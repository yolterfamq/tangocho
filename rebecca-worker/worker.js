// Ребека — сервер-посредник между приложением и Claude (Cloudflare Worker).
// Ключ Claude хранится только здесь. Отвечаем только вошедшим пользователям из списка ALLOWED_EMAILS.
//
// Переменные (Cloudflare → Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY    (секрет)  ключ с console.anthropic.com (sk-ant-...)
//   FIREBASE_PROJECT_ID (необяз.) id проекта Firebase, по умолчанию "tangocho-7cc8d"
//   ALLOWED_EMAILS                почты через запятую: "me@gmail.com, her@gmail.com"
//   CLAUDE_MODEL         (необяз.) по умолчанию claude-sonnet-5-5
//   CLAUDE_FALLBACK      (необяз.) запасная модель, по умолчанию claude-haiku-5-5

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
    const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
    const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    const imgBytes = images.reduce((n, i) => n + (i.data ? i.data.length : 0), 0);
    if (imgBytes > 12_000_000) return json({ error: "Слишком большие фото", code: "too_big" }, 413);
    if (!messages.length) return json({ error: "Пустое сообщение" }, 400);

    const msgs = [];
    for (const m of messages) {
      const role = m.role === "model" ? "assistant" : "user";
      const text = String(m.text || "").slice(0, 20000);
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

    // 3) Спрашиваем Claude (если основная модель перегружена — пробуем запасную)
    const models = [env.CLAUDE_MODEL || "claude-sonnet-5-5", env.CLAUDE_FALLBACK || "claude-haiku-5-5"];
    let upstream, lastErr = "";
    for (const model of models) {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM, messages: msgs, stream: true }),
      });
      if (upstream.ok) break;
      lastErr = await upstream.text();
      if (![404, 429, 500, 529].includes(upstream.status)) break;
    }
    if (!upstream.ok) {
      const code = upstream.status === 429 || upstream.status === 529 ? "limit"
        : /credit balance/i.test(lastErr) ? "billing"
        : upstream.status === 401 ? "badkey"
        : /region|country|location/i.test(lastErr) ? "region" : "claude";
      return json({ error: "Claude: " + upstream.status + " " + lastErr.slice(0, 300), code }, 502);
    }

    // 4) Пересылаем ответ по кусочкам: data: {"t":"текст"}
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(pipe(upstream.body, writable));
    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};

async function pipe(src, writable) {
  const w = writable.getWriter(), enc = new TextEncoder(), dec = new TextDecoder();
  const send = obj => w.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
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
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text)
          await send({ t: ev.delta.text });
        else if (ev.type === "error")
          await send({ error: "Claude: " + ((ev.error && ev.error.message) || "ошибка"), code: ev.error && ev.error.type === "overloaded_error" ? "limit" : undefined });
      }
    }
    await send({ done: true });
  } catch (e) {
    try { await send({ error: "Связь с Claude оборвалась: " + e.message }); } catch {}
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
