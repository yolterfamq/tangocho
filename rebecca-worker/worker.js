// Ребека — сервер-посредник между приложением и бесплатными ИИ (Cloudflare Worker).
// Ключи хранятся только здесь. Отвечаем только вошедшим пользователям из списка ALLOWED_EMAILS.
//
// Ребека пробует сервисы по очереди: если один упёрся в лимит или сломался — берёт следующий.
// Переменные (Cloudflare → Worker → Settings → Variables and Secrets):
//   ALLOWED_EMAILS               почты через запятую: "me@gmail.com, her@gmail.com"
//   GROQ_API_KEY      (секрет)   ключ с console.groq.com — основной, бесплатный
//   GEMINI_API_KEY    (секрет)   ключ с aistudio.google.com — запасной, бесплатный
//   Привязка Workers AI с именем AI (Settings → Bindings → Workers AI) — последний запасной, без ключа
//
// Необязательно (платные или свои сервисы, идут ПЕРВЫМИ, если заданы):
//   ANTHROPIC_API_KEY + (AI_FORMAT=openai, AI_BASE_URL, CLAUDE_MODEL) — как раньше
//   FIREBASE_PROJECT_ID          по умолчанию "tangocho-7cc8d"

const SYSTEM = `Ты — Ребека, дружелюбный и терпеливый репетитор внутри приложения «Тангочо» (японские карточки).
Отвечай на языке пользователя, по умолчанию по-русски. Обращайся на «ты».

Что ты делаешь:
- Отвечаешь на любые учебные вопросы: математика, физика, химия, языки, история, программирование, японский и др.
- Решаешь задачи по шагам: сначала кратко, что дано и что нужно найти, потом решение с пояснением каждого шага, в конце — чёткий ответ.
- Если прислали фото, сначала внимательно прочитай всё, что на нём. Если что-то не разобрать — прямо скажи, какую часть, не выдумывай.
- Если просят «перепиши / распознай текст / в текст» — выдай ТОЛЬКО распознанный текст, сохраняя строки, нумерацию и формулы, без решения и комментариев.
- Если просят «проверь решение» — найди ошибки, объясни их и покажи, как правильно.
- По японскому: давай чтение хираганой рядом с кандзи, перевод и короткие примеры.
- Как репетитор: объясняй понятно, приводи примеры; если ученик хочет разобраться сам — давай подсказки, а не готовый ответ.

Оформление: Markdown. Формулы — LaTeX: в строке $...$, отдельной строкой $$...$$. Не растягивай ответ без нужды.
Если не уверена в ответе — так и скажи.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") return json({ ok: true, name: "Rebecca" });
    if (url.pathname !== "/chat" || req.method !== "POST") return json({ error: "Not found" }, 404);

    // 1) Кто пишет
    let user;
    try {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      user = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID || "tangocho-7cc8d");
    } catch (e) {
      return json({ error: "Нужно войти в аккаунт", code: "unauthorized" }, 401);
    }
    const allowed = (env.ALLOWED_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const email = (user.email || "").toLowerCase();
    if (!email || !allowed.includes(email)) return json({ error: "Нет доступа", code: "denied" }, 403);
    if (!user.email_verified) return json({ error: "Почта не подтверждена", code: "unverified" }, 403);

    // 2) Что пишет
    let body;
    try { body = await req.json(); } catch { return json({ error: "Плохой запрос" }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    const imgBytes = images.reduce((n, i) => n + (i.data ? i.data.length : 0), 0);
    if (imgBytes > 12_000_000) return json({ error: "Слишком большие фото", code: "too_big" }, 413);
    if (!messages.length) return json({ error: "Пустое сообщение" }, 400);

    const msgs = [];
    for (const m of messages) {
      const role = m.role === "model" ? "assistant" : "user";
      const text = String(m.text || "").slice(0, 12000);
      if (!text) continue;
      // Claude требует чередования ролей — склеиваем подряд идущие
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === role) prev.content[0].text += "\n\n" + text;
      else msgs.push({ role, content: [{ type: "text", text }] });
    }
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") return json({ error: "Последнее сообщение должно быть от пользователя" }, 400);
    for (const img of images) {
      if (/^image\/(jpeg|png|webp|gif)$/.test(img.mime || "") && img.data)
        last.content.unshift({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
    }

    // 3) Спрашиваем ИИ по цепочке бесплатных сервисов
    const hasImages = msgs.some(m => m.content.some(c => c.type === "image"));
    const providers = buildProviders(env, hasImages);
    if (!providers.length) return json({ error: "На сервере не задан ни один ключ ИИ (GROQ_API_KEY, GEMINI_API_KEY или привязка AI)", code: "badkey" }, 500);

    let stream = null, lastErr = "", lastStatus = 0;
    for (const p of providers) {
      try {
        const r = await p.call(msgs);
        if (r.ok) { stream = r.body; break; }
        lastStatus = r.status;
        lastErr = p.name + ": " + r.status + " " + (await r.text()).slice(0, 300);
      } catch (e) {
        lastErr = p.name + ": " + (e.message || e);
      }
    }
    if (!stream) {
      const code = lastStatus === 429 ? "limit"
        : lastStatus === 401 || lastStatus === 403 ? "badkey"
        : /credit balance|insufficient|balance/i.test(lastErr) || lastStatus === 402 ? "billing" : "claude";
      return json({ error: "Все ИИ сейчас недоступны. Последняя ошибка — " + lastErr, code }, 502);
    }

    // 4) Пересылаем ответ по кусочкам: data: {"t":"текст"}
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(pipe(stream, writable));
    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};

/** Список сервисов по порядку. Каждый возвращает Response с потоком SSE. */
function buildProviders(env, hasImages) {
  const list = [];
  const openaiCall = (name, url, key, model, extra = {}) => ({
    name,
    call: msgs => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ model, stream: true, max_tokens: 4096, messages: toOpenAI(msgs), ...extra }),
    }),
  });

  // 0) Свой/платный сервис, если задан (как было раньше)
  const customKey = (env.ANTHROPIC_API_KEY || env.AI_API_KEY || "").trim();
  if (customKey) {
    const openai = (env.AI_FORMAT || "").toLowerCase() === "openai";
    const base = (env.AI_BASE_URL || (openai ? "https://api.openai.com/v1" : "https://api.anthropic.com")).replace(/\/+$/, "");
    for (const model of [...new Set([env.CLAUDE_MODEL || "claude-sonnet-5-5", env.CLAUDE_FALLBACK || env.CLAUDE_MODEL || "claude-haiku-5-5"])]) {
      list.push(openai ? openaiCall("custom", base + "/chat/completions", customKey, model) : {
        name: "claude",
        call: msgs => fetch(base + "/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": customKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM, messages: msgs, stream: true }),
        }),
      });
    }
  }

  // 1) Groq — бесплатно: фото понимает qwen3.8-27b (до 3 фото), текст — gpt-oss-120b
  const groq = (env.GROQ_API_KEY || "").trim();
  if (groq) {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const qwen = openaiCall("groq-qwen", url, groq, env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b", { reasoning_format: "hidden" });
    if (hasImages) list.push(qwen);
    else {
      list.push(openaiCall("groq-gptoss", url, groq, env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b"));
      list.push(qwen);
    }
  }

  // 2) Gemini — бесплатный ключ, формат OpenAI
  const gem = (env.GEMINI_API_KEY || "").trim();
  if (gem) {
    const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    list.push(openaiCall("gemini", url, gem, env.GEMINI_MODEL || "gemini-3.8-flash"));
    list.push(openaiCall("gemini-lite", url, gem, env.GEMINI_FALLBACK || "gemini-3.5-flash-lite"));
  }

  // 3) Cloudflare Workers AI — привязка AI, без ключа (около 10 000 «нейронов» в день бесплатно)
  if (env.AI && typeof env.AI.run === "function") {
    list.push({
      name: "workers-ai",
      call: async msgs => {
        const out = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/qwen/qwen3.8-27b", { messages: toOpenAI(msgs), stream: true, max_tokens: 4096 });
        return new Response(out, { status: 200 });
      },
    });
  }
  return list;
}

/** Сообщения из формата Claude в формат OpenAI (картинки — data:URL) */
function toOpenAI(msgs) {
  const out = [{ role: "system", content: SYSTEM }];
  for (const m of msgs) {
    const hasImg = m.content.some(c => c.type === "image");
    if (!hasImg) { out.push({ role: m.role, content: m.content.map(c => c.text).join("\n\n") }); continue; }
    out.push({ role: m.role, content: m.content.map(c => c.type === "image"
      ? { type: "image_url", image_url: { url: "data:" + c.source.media_type + ";base64," + c.source.data } }
      : { type: "text", text: c.text }) });
  }
  return out;
}

async function pipe(src, writable) {
  const w = writable.getWriter(), enc = new TextEncoder(), dec = new TextDecoder();
  const raw = obj => w.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
  // Убираем «мысли» моделей в тегах <think>…</think>, отдаём только ответ
  let thinking = false, tail = "";
  const send = async obj => {
    if (obj.t == null) return raw(obj);
    let t = tail + obj.t, out = ""; tail = "";
    while (t) {
      if (thinking) {
        const i = t.indexOf("</think>");
        if (i < 0) { tail = t.slice(-7); t = ""; break; }
        thinking = false; t = t.slice(i + 8).replace(/^\s+/, "");
      } else {
        const i = t.indexOf("<think>");
        if (i < 0) {
          const lt = t.lastIndexOf("<");
          if (lt >= 0 && lt > t.length - 7 && "<think>".startsWith(t.slice(lt))) { out += t.slice(0, lt); tail = t.slice(lt); }
          else out += t;
          t = ""; break;
        }
        out += t.slice(0, i); thinking = true; t = t.slice(i + 7);
      }
    }
    if (out) await raw({ t: out });
  };
  const reader = src.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        // формат Claude
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text)
          await send({ t: ev.delta.text });
        else if (ev.type === "error" || (ev.error && !ev.choices))
          await send({ error: "ИИ: " + ((ev.error && ev.error.message) || "ошибка"), code: ev.error && ev.error.type === "overloaded_error" ? "limit" : undefined });
        // формат OpenAI
        else if (ev.choices && ev.choices[0] && ev.choices[0].delta && typeof ev.choices[0].delta.content === "string" && ev.choices[0].delta.content)
          await send({ t: ev.choices[0].delta.content });
        // формат Workers AI
        else if (typeof ev.response === "string" && ev.response)
          await send({ t: ev.response });
      }
    }
    await send({ done: true });
  } catch (e) {
    try { await send({ error: "Связь с ИИ оборвалась: " + e.message }); } catch {}
  } finally {
    try { await w.close(); } catch {}
  }
}

// ───────── проверка входа Firebase (ID-токен, RS256) ─────────
let JWKS = null, JWKS_EXP = 0;

async function getKeys() {
  if (JWKS && Date.now() < JWKS_EXP) return JWKS;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const data = await r.json();
  const maxAge = +((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/) || [0, 3600])[1];
  JWKS = data.keys; JWKS_EXP = Date.now() + maxAge * 1000;
  return JWKS;
}

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));

async function verifyFirebaseToken(token, projectId) {
  if (!token || !projectId) throw new Error("no token");
  const [h, p, sig] = token.split(".");
  if (!sig) throw new Error("bad token");
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== "RS256") throw new Error("alg");

  const jwk = (await getKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("kid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(h + "." + p));
  if (!ok) throw new Error("signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("aud");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("iss");
  if (!(payload.exp > now) || payload.iat > now + 300) throw new Error("exp");
  if (!payload.sub) throw new Error("sub");
  return payload;
}
