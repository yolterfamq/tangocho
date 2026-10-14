// Ребека — ИИ-репетитор. Чаты хранятся в аккаунте (Firestore), ответы идут через сервер на Cloudflare.
(function () {
  const C = window.TANGOCHO_CONFIG || {};
  const URL_ = (C.rebeccaUrl || "").replace(/\/+$/, "");
  const MAX_IMAGES = 4, HISTORY = 20;

  const R = window.Rebecca = {};
  let chat = null;            // { id, title, created, updated, msgs:[{role, text, thumbs:[]}] }
  let atts = [];              // [{ data, mime, thumb }]
  let streaming = null;       // AbortController
  let libs = null;
  let listOpen = false;
  let gateReason = "";        // "" | "config" | "login" | "verify" | "denied"

  const el = id => document.getElementById(id);
  const isTouch = matchMedia("(hover:none)").matches;

  // ───────── библиотеки: Markdown + формулы ─────────
  function load(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function loadLibs() {
    if (libs) return libs;
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.appendChild(css);
    libs = Promise.allSettled([
      load("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"),
      load("https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"),
      load("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"),
    ]);
    return libs;
  }

  function md(text) {
    const math = [];
    const keep = (s, d) => { math.push({ s, d }); return "@@M" + (math.length - 1) + "@@"; };
    let t = text
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, a) => keep(a, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, a) => keep(a, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, a) => keep(a, false))
      .replace(/\$(?=\S)([^$\n]+?)(?<=\S)\$/g, (_, a) => keep(a, false));
    let html = window.marked ? marked.parse(t, { breaks: true, gfm: true }) : esc(t).replace(/\n/g, "<br>");
    if (window.DOMPurify) html = DOMPurify.sanitize(html);
    return html.replace(/@@M(\d+)@@/g, (_, i) => {
      const m = math[+i];
      if (!window.katex) return esc(m.d ? "$$" + m.s + "$$" : "$" + m.s + "$");
      try { return katex.renderToString(m.s, { displayMode: m.d, throwOnError: false }); }
      catch (e) { return esc(m.s); }
    });
  }

  // ───────── фото ─────────
  function readImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const shot = (max, q) => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          const g = c.getContext("2d");
          g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL("image/jpeg", q);
        };
        const big = shot(1800, 0.86), thumb = shot(160, 0.7);
        URL.revokeObjectURL(url);
        res({ mime: "image/jpeg", data: big.split(",")[1], thumb });
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Не удалось открыть картинку")); };
      img.src = url;
    });
  }

  async function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (atts.length >= MAX_IMAGES) break;
      try { atts.push(await readImage(f)); } catch (e) { toastErr(e.message); }
    }
    renderComposer();
  }

  // ───────── хранение чатов ─────────
  const col = () => Account.db.collection("users").doc(Account.user.uid).collection("chats");
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  async function saveChat() {
    if (!chat || !Account.user) return;
    chat.updated = Date.now();
    try { await col().doc(chat.id).set(chat); } catch (e) { console.warn(e); }
  }

  async function listChats() {
    const snap = await col().orderBy("updated", "desc").limit(60).get();
    return snap.docs.map(d => d.data());
  }

  // ───────── отрисовка ─────────
  function gate() {
    if (!URL_ || !window.Account || !Account.configured) return "config";
    if (Account.failed) return "offline";
    if (!Account.ready) return "loading";
    if (!Account.user) return "login";
    const pw = Account.user.providerData.some(p => p.providerId === "password");
    if (pw && !Account.user.emailVerified) return "verify";
    if (gateReason === "denied") return "denied";
    return "";
  }

  function renderGate(g) {
    const box = el("msgs");
    el("composer").hidden = true;
    const texts = {
      loading: ["Загрузка…", ""],
      config: ["Ребека ещё не настроена", "Нужно заполнить config.js: настройки Firebase и адрес сервера Ребеки (см. README)."],
      offline: ["Нет интернета", "Ребеке нужен интернет. Проверь подключение и открой этот экран снова."],
      login: ["Войди в аккаунт", "Ребека работает только для вошедших — так ваши чаты сохраняются и доступны с любого устройства."],
      verify: ["Подтверди почту", "Мы отправили письмо при регистрации. Открой ссылку из него, затем нажми «Я подтвердил» в настройках."],
      denied: ["Ребека пока только по приглашению", "Этот аккаунт не в списке. Попроси владельца добавить твою почту."],
    };
    const [t, p] = texts[g];
    box.innerHTML = `<div class="gate"><span class="jp" style="font-family:var(--jp);font-size:30px;color:var(--accent)">レベッカ</span><b>${t}</b>${p ? `<p>${p}</p>` : ""}
      ${g === "login" || g === "verify" ? `<button class="btn primary" id="gateGo">Открыть настройки</button>` : ""}</div>`;
    const b = el("gateGo"); if (b) b.onclick = () => show("set");
  }

  function hello() {
    return `<div class="hello">
      <span class="jp">こんにちは！</span>
      <b>Я Ребека, твой репетитор</b>
      <p>Спроси что угодно или прикрепи фото задачи. Решу и объясню по шагам, перепишу текст с фото, проверю твоё решение.</p>
      <div class="sugg">
        <button data-q="Объясни простыми словами разницу между ～から и ～まで и дай 3 примера.">Объясни грамматику<small>～から и ～まで с примерами</small></button>
        <button data-q="Проверь меня: задай 5 вопросов по словам урока 4 (дни недели и время), по одному за раз.">Проверь меня<small>вопросы по уроку 4</small></button>
        <button data-photo="1">Решить задачу по фото<small>сфоткай и отправь</small></button>
        <button data-q="Как лучше запоминать кандзи? Дай короткий план на неделю.">Совет по учёбе<small>как запоминать кандзи</small></button>
      </div>
    </div>`;
  }

  function msgHtml(m, i) {
    const imgs = m.thumbs && m.thumbs.length ? `<div class="imgs">${m.thumbs.map(t => `<img src="${t}" alt="Фото">`).join("")}</div>` : "";
    if (m.role === "user") return `<div class="m user">${imgs}${esc(m.text || "")}</div>`;
    return `<div class="m bot" data-i="${i}"><div class="who">Ребека</div><div class="body">${m.error ? `<span class="err">${esc(m.error)}</span>` : m.text ? md(m.text) : `<span class="typing"><i></i><i></i><i></i></span>`}</div>
      ${m.text && !m.pending ? `<div class="tools"><button data-copy="${i}">Копировать</button></div>` : ""}</div>`;
  }

  function renderMsgs(scroll) {
    const box = el("msgs");
    const g = gate();
    if (g) { renderGate(g); return; }
    el("composer").hidden = false;
    box.innerHTML = !chat || !chat.msgs.length ? hello() : chat.msgs.map(msgHtml).join("");
    box.querySelectorAll("[data-q]").forEach(b => b.onclick = () => send(b.dataset.q));
    box.querySelectorAll("[data-photo]").forEach(b => b.onclick = () => el("fileIn").click());
    box.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(chat.msgs[+b.dataset.copy].text, b));
    if (scroll) box.scrollTop = box.scrollHeight;
    el("chatSub").textContent = chat && chat.title ? chat.title : "репетитор";
  }

  function updateLast() {
    const box = el("msgs"), i = chat.msgs.length - 1;
    const node = box.querySelector(`.m.bot[data-i="${i}"]`);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (node) node.outerHTML = msgHtml(chat.msgs[i], i); else renderMsgs(false);
    box.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(chat.msgs[+b.dataset.copy].text, b));
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderComposer() {
    el("atts").innerHTML = atts.map((a, i) => `<div class="att"><img src="${a.thumb}" alt=""><button data-rm="${i}" aria-label="Убрать фото">×</button></div>`).join("");
    el("atts").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { atts.splice(+b.dataset.rm, 1); renderComposer(); });
    const empty = !el("chatInput").value.trim();
    el("chips").innerHTML = atts.length && empty ? ["Реши задачу и объясни по шагам", "Перепиши текст с фото", "Объясни, что здесь", "Переведи на русский", "Проверь моё решение"]
      .map(q => `<button data-chip="${esc(q)}">${esc(q)}</button>`).join("") : "";
    el("chips").querySelectorAll("[data-chip]").forEach(b => b.onclick = () => send(b.dataset.chip));
    const btn = el("sendBtn");
    btn.disabled = !streaming && empty && !atts.length;
    btn.setAttribute("aria-label", streaming ? "Остановить" : "Отправить");
    btn.innerHTML = streaming
      ? `<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  }

  function grow() { const t = el("chatInput"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }

  function copy(text, btn) {
    const done = () => { btn.textContent = "Скопировано"; setTimeout(() => btn.textContent = "Копировать", 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
  }

  function toastErr(text) {
    if (!chat) chat = { id: newId(), title: "", created: Date.now(), updated: Date.now(), msgs: [] };
    chat.msgs.push({ role: "model", error: text });
    renderMsgs(true);
  }

  // ───────── отправка ─────────
  const ERRORS = {
    unauthorized: "Сессия устарела. Выйди и войди в аккаунт снова.",
    denied: "Этот аккаунт не в списке тех, кому доступна Ребека.",
    unverified: "Сначала подтверди почту (в настройках).",
    limit: "Claude сейчас перегружен или упёрся в лимит запросов. Попробуй через минуту.",
    billing: "На счёте Claude закончились деньги. Пополни баланс на console.anthropic.com → Billing.",
    badkey: "Ключ Claude на сервере неверный. Проверь ANTHROPIC_API_KEY в настройках воркера.",
    region: "Claude недоступен из региона сервера. Включи Smart Placement у воркера на Cloudflare (см. README).",
    too_big: "Фото слишком большие. Отправь поменьше или по одному.",
  };

  async function send(text) {
    text = (text || "").trim();
    if (streaming || (!text && !atts.length)) return;
    if (!text) text = "Реши задачу с фото и объясни по шагам";
    if (!chat) chat = { id: newId(), title: "", created: Date.now(), updated: Date.now(), msgs: [] };

    const images = atts.map(a => ({ mime: a.mime, data: a.data }));
    const userMsg = { role: "user", text, thumbs: atts.map(a => a.thumb) };
    chat.msgs = chat.msgs.filter(m => !m.error);
    chat.msgs.push(userMsg);
    if (!chat.title) chat.title = text.length > 48 ? text.slice(0, 46) + "…" : text;
    const history = chat.msgs.slice(-HISTORY).map(m => ({ role: m.role, text: m.text || "" }));
    const bot = { role: "model", text: "", pending: true };
    chat.msgs.push(bot);

    atts = []; el("chatInput").value = ""; grow();
    streaming = new AbortController();
    renderComposer(); renderMsgs(true);

    let last = 0, raf = 0;
    const paint = () => { raf = 0; last = Date.now(); updateLast(); };
    const schedulePaint = () => { if (!raf) raf = setTimeout(paint, Math.max(0, 70 - (Date.now() - last))); };

    try {
      await loadLibs();
      const token = await Account.token();
      const resp = await fetch(URL_ + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ messages: history, images }),
        signal: streaming.signal,
      });
      if (!resp.ok) {
        let j = {}; try { j = await resp.json(); } catch (e) {}
        if (j.code === "denied") gateReason = "denied";
        throw new Error(ERRORS[j.code] || j.error || ("Сервер ответил " + resp.status));
      }
      const reader = resp.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, k).trim(); buf = buf.slice(k + 2);
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (ev.t) { bot.text += ev.t; schedulePaint(); }
          if (ev.error) throw new Error(ERRORS[ev.code] || ev.error);
        }
      }
      if (!bot.text) throw new Error("Ребека ничего не ответила. Попробуй переформулировать.");
    } catch (e) {
      if (e.name === "AbortError") { if (!bot.text) bot.text = "_(остановлено)_"; }
      else { bot.error = e.message || String(e); }
    }
    clearTimeout(raf);
    bot.pending = false;
    streaming = null;
    if (bot.error && !bot.text) delete bot.text;
    renderComposer(); updateLast();
    if (gateReason === "denied") { renderMsgs(false); return; }
    // в облако сохраняем без ошибок и без пустых ответов
    const keep = chat.msgs.filter(m => !m.error && !m.pending);
    const saved = { ...chat, msgs: keep.map(m => ({ role: m.role, text: m.text || "", thumbs: m.thumbs || [] })) };
    if (Account.user) col().doc(chat.id).set({ ...saved, updated: Date.now() }).catch(e => console.warn(e));
  }

  // ───────── список чатов ─────────
  async function openList() {
    listOpen = true;
    const box = el("chatList");
    box.hidden = false; el("msgs").hidden = true; el("composer").hidden = true;
    box.innerHTML = `<span class="hint">Загрузка…</span>`;
    try {
      const all = await listChats();
      if (!listOpen) return;
      box.innerHTML = all.length ? all.map(c => `<button data-open="${c.id}"><span class="del" data-del="${c.id}">Удалить</span><b>${esc(c.title || "Без названия")}</b>
        <small>${new Date(c.updated).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${c.msgs.length} сообщ.</small></button>`).join("")
        : `<span class="hint">Пока нет сохранённых чатов.</span>`;
      box.querySelectorAll("[data-open]").forEach(b => b.onclick = e => {
        const del = e.target.closest("[data-del]");
        if (del) {
          e.stopPropagation();
          if (del.dataset.confirm) { col().doc(del.dataset.del).delete().then(openList); if (chat && chat.id === del.dataset.del) chat = null; }
          else { del.dataset.confirm = "1"; del.textContent = "Точно удалить?"; }
          return;
        }
        chat = all.find(c => c.id === b.dataset.open);
        closeList();
      });
    } catch (e) {
      box.innerHTML = `<span class="msg-err">Не удалось загрузить чаты: ${esc(e.message)}</span>`;
    }
  }
  function closeList() {
    listOpen = false;
    el("chatList").hidden = true; el("msgs").hidden = false;
    renderMsgs(true); renderComposer();
  }

  R.back = () => { if (listOpen) { closeList(); return true; } return false; };

  // ───────── события ─────────
  el("sendBtn").onclick = () => { if (streaming) streaming.abort(); else send(el("chatInput").value); };
  el("chatInput").addEventListener("input", () => { grow(); renderComposer(); });
  el("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.isComposing) { e.preventDefault(); send(el("chatInput").value); }
  });
  el("chatInput").addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el("attachBtn").onclick = () => el("fileIn").click();
  el("fileIn").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  el("newChatBtn").onclick = () => { if (streaming) return; chat = null; atts = []; if (listOpen) closeList(); else { renderMsgs(true); renderComposer(); } el("chatInput").focus(); };
  el("chatsBtn").onclick = () => { if (!Account.user) return; listOpen ? closeList() : openList(); };

  const cv = el("chatView");
  cv.addEventListener("dragover", e => { if ([...e.dataTransfer.items].some(i => i.kind === "file")) { e.preventDefault(); cv.classList.add("dropping"); } });
  cv.addEventListener("dragleave", e => { if (!cv.contains(e.relatedTarget)) cv.classList.remove("dropping"); });
  cv.addEventListener("drop", e => { e.preventDefault(); cv.classList.remove("dropping"); addFiles([...e.dataTransfer.files]); });

  viewHooks.push(v => {
    if (v !== "chat") return;
    loadLibs();
    if (!listOpen) { renderMsgs(true); renderComposer(); grow(); }
    if (!isTouch && !gate()) setTimeout(() => el("chatInput").focus(), 50);
  });
  if (window.Account) Account.onChange(() => {
    if (!Account.user) { chat = null; gateReason = ""; if (listOpen) closeList(); }
    if (view === "chat" && !listOpen) renderMsgs(false);
  });
})();
