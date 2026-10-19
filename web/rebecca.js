// Ребека — ИИ-репетитор. Чаты хранятся в аккаунте (Firestore), ответы идут через сервер на Cloudflare.
(function () {
  const C = window.TANGOCHO_CONFIG || {};
  const URL_ = (C.rebeccaUrl || "").replace(/\/+$/, "");
  const MAX_IMAGES = 3, HISTORY = 20;
  const MAX_DOC_CHARS = 15000;        // столько текста из файлов уходит в одном сообщении (бесплатные ИИ не любят огромные запросы)
  const MAX_FILE_MB = 25;

  const R = window.Rebecca = {};
  let chat = null;            // { id, title, created, updated, msgs:[{role, text, thumbs:[]}] }
  let atts = [];              // [{ kind:"image", data, mime, thumb } | { kind:"doc", name, ext, text, truncated } | { kind:"loading", name }]
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

  // ───────── документы: txt, docx, pdf, xlsx, pptx, odt, rtf, код ─────────
  const LIB = {
    mammoth: "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js",
    xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
    pdf: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
    pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
  };
  const loaded = {};
  const need = k => loaded[k] || (loaded[k] = load(LIB[k]).catch(e => { delete loaded[k]; throw new Error("Нет интернета, не удалось загрузить чтение файлов"); }));

  const TEXT_EXT = "txt md markdown csv tsv json xml html htm log ini cfg conf yml yaml toml py js ts jsx tsx cs java kt cpp c h hpp lua sql php rb go rs swift sh bat ps1 css scss srt vtt tex".split(" ");
  const extOf = name => (name.split(".").pop() || "").toLowerCase();

  function decodeText(buf) {
    let t = new TextDecoder("utf-8").decode(buf);
    const bad = (t.match(/\uFFFD/g) || []).length;
    if (bad > 3 && bad > t.length / 200) {                 // похоже на Windows-1251 (старые русские txt)
      try { t = new TextDecoder("windows-1251").decode(buf); } catch (e) {}
    }
    return t.replace(/^\uFEFF/, "");
  }
  const looksBinary = buf => { const b = new Uint8Array(buf.slice(0, 2000)); let z = 0; for (const x of b) if (x === 0) z++; return z > 2; };
  const xmlText = (xml, para) => xml.replace(new RegExp("</(" + para + ")>", "g"), "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  async function readPdf(buf, name) {
    await need("pdf");
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    let text = "";
    for (let i = 1; i <= Math.min(doc.numPages, 60) && text.length < MAX_DOC_CHARS * 2; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      text += (doc.numPages > 1 ? "\n— стр. " + i + " —\n" : "") + c.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("");
    }
    if (text.replace(/\s|— стр\. \d+ —/g, "").length > 40) return { text };
    // Скан без текста — отправим первые страницы как картинки
    const images = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_IMAGES); i++) {
      const page = await doc.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2, 1600 / Math.max(vp0.width, vp0.height)) });
      const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      const big = cv.toDataURL("image/jpeg", 0.85);
      const t = document.createElement("canvas"), k = 160 / Math.max(cv.width, cv.height);
      t.width = cv.width * k; t.height = cv.height * k; t.getContext("2d").drawImage(cv, 0, 0, t.width, t.height);
      images.push({ kind: "image", mime: "image/jpeg", data: big.split(",")[1], thumb: t.toDataURL("image/jpeg", 0.7), name: name + " · стр. " + i });
    }
    return { images, scanned: true, pages: doc.numPages };
  }

  async function readDoc(f) {
    const ext = extOf(f.name);
    if (f.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Файл «${f.name}» больше ${MAX_FILE_MB} МБ`);
    const buf = await f.arrayBuffer();
    if (ext === "pdf" || f.type === "application/pdf") return readPdf(buf, f.name);
    if (ext === "docx" || ext === "docm") {
      await need("mammoth");
      return { text: (await mammoth.extractRawText({ arrayBuffer: buf })).value };
    }
    if (["xlsx", "xlsm", "xls", "ods"].includes(ext)) {
      await need("xlsx");
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      return { text: wb.SheetNames.map(n => "Лист «" + n + "»:\n" + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join("\n\n") };
    }
    if (ext === "pptx" || ext === "odt" || ext === "odp") {
      await need("jszip");
      const zip = await JSZip.loadAsync(buf);
      if (ext === "pptx") {
        const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
        const parts = [];
        for (const [i, n] of slides.entries()) {
          const xml = await zip.file(n).async("string");
          const t = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || []).map(x => xmlText(x, "a:t")).join(" ");
          parts.push("Слайд " + (i + 1) + ": " + t.trim());
        }
        return { text: parts.join("\n") };
      }
      const xml = await zip.file("content.xml").async("string");
      return { text: xmlText(xml, "text:p|text:h") };
    }
    if (ext === "rtf") {
      const raw = decodeText(buf);
      return { text: raw.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^}]*\}/g, "").replace(/\\'([0-9a-f]{2})/gi, (_, h) => new TextDecoder("windows-1251").decode(new Uint8Array([parseInt(h, 16)])))
        .replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "") };
    }
    if (ext === "doc" || ext === "ppt") throw new Error(`Старый формат .${ext} не читается. Открой файл в Word/PowerPoint и сохрани как .${ext}x`);
    if (TEXT_EXT.includes(ext) || f.type.startsWith("text/") || !looksBinary(buf)) return { text: decodeText(buf) };
    throw new Error(`Файл «${f.name}» не похож на документ, который я умею читать`);
  }

  const imgCount = () => atts.filter(a => a.kind === "image").length;

  async function addFiles(files) {
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        if (imgCount() >= MAX_IMAGES) { toastErr(`За раз можно отправить до ${MAX_IMAGES} фото`); continue; }
        try { atts.push({ kind: "image", ...(await readImage(f)) }); } catch (e) { toastErr(e.message); }
        renderComposer();
        continue;
      }
      const slot = { kind: "loading", name: f.name };
      atts.push(slot); renderComposer();
      try {
        const r = await readDoc(f);
        const i = atts.indexOf(slot);
        if (i < 0) continue;                                  // убрали, пока читали
        if (r.images) {
          const room = MAX_IMAGES - imgCount();
          atts.splice(i, 1, ...r.images.slice(0, Math.max(0, room)));
          if (room <= 0) toastErr("В PDF нет текста (это скан), а места для фото уже нет — убери фото и прикрепи снова");
        } else {
          const text = (r.text || "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          if (!text) { atts.splice(i, 1); toastErr(`В файле «${f.name}» не нашлось текста`); }
          else atts.splice(i, 1, { kind: "doc", name: f.name, ext: extOf(f.name), text });
        }
      } catch (e) {
        const i = atts.indexOf(slot); if (i >= 0) atts.splice(i, 1);
        toastErr(e.message || String(e));
      }
      renderComposer();
    }
  }

  /** Текст всех документов для отправки, с общим ограничением по длине */
  function docsBlock(docs) {
    let left = MAX_DOC_CHARS, out = [];
    for (const d of docs) {
      const part = d.text.slice(0, Math.max(0, left));
      const cut = part.length < d.text.length;
      left -= part.length;
      out.push(`Файл «${d.name}»${cut ? ` (большой, показано начало: ${part.length} из ${d.text.length} символов)` : ""}:\n"""\n${part}\n"""`);
    }
    return out.join("\n\n");
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

  /** «Проверь меня» по урокам, отмеченным галочками */
  function quizButton() {
    const ls = typeof selLessons === "function" ? selLessons() : [];
    if (!ls.length) return "";
    const names = ls.map(l => l.title).join(", ");
    const list = ls.map(l => l.title + ": " + l.items.map(w => l.type === "kanji"
      ? w[0] + " (" + w[1] + "; кун: " + (w[2] || "—") + "; он: " + (w[3] || "—") + ")"
      : (w[1] ? w[0] + " / " + w[1] : w[0]) + " — " + w[2]).join("; ")).join("\n");
    const q = "Проверь меня: задай 5 вопросов по словам из " + names + ", по одному за раз, и жди мой ответ.";
    return `<button data-q="${esc(q)}" data-ctx="${esc("Слова и канджи, по которым проверять (из учебника):\n" + list)}">Проверь меня<small>${esc(names)}</small></button>`;
  }

  function hello() {
    return `<div class="hello">
      <span class="jp">こんにちは！</span>
      <b>Я Ребека, твой репетитор</b>
      <p>Спроси что угодно или прикрепи фото задачи. Решу и объясню по шагам, перепишу текст с фото, проверю твоё решение.</p>
      <div class="sugg">
        <button data-q="Объясни простыми словами разницу между ～から и ～まで и дай 3 примера.">Объясни грамматику<small>～から и ～まで с примерами</small></button>
        ${quizButton()}
        <button data-photo="1">Решить задачу по фото<small>сфоткай и отправь</small></button>
        <button data-q="Как лучше запоминать кандзи? Дай короткий план на неделю.">Совет по учёбе<small>как запоминать кандзи</small></button>
      </div>
    </div>`;
  }

  function msgHtml(m, i) {
    const imgs = m.thumbs && m.thumbs.length ? `<div class="imgs">${m.thumbs.map(t => `<img src="${t}" alt="Фото">`).join("")}</div>` : "";
    const files = m.files && m.files.length ? `<div class="files">${m.files.map(f => `<span class="fchip"><b>${esc((f.ext || "файл").toUpperCase())}</b>${esc(f.name)}</span>`).join("")}</div>` : "";
    if (m.role === "user") return `<div class="m user">${imgs}${files}${esc(m.text || "")}</div>`;
    return `<div class="m bot" data-i="${i}"><div class="who">Ребека</div><div class="body">${m.error ? `<span class="err">${esc(m.error)}</span>` : m.text ? md(m.text) : `<span class="typing"><i></i><i></i><i></i></span>`}</div>
      ${m.text && !m.pending ? `<div class="tools"><button data-copy="${i}">Копировать</button></div>` : ""}</div>`;
  }

  function renderMsgs(scroll) {
    const box = el("msgs");
    const g = gate();
    if (g) { renderGate(g); return; }
    el("composer").hidden = false;
    box.innerHTML = !chat || !chat.msgs.length ? hello() : chat.msgs.map(msgHtml).join("");
    box.querySelectorAll("[data-q]").forEach(b => b.onclick = () => send(b.dataset.q, b.dataset.ctx));
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
    el("atts").innerHTML = atts.map((a, i) => a.kind === "image"
      ? `<div class="att"><img src="${a.thumb}" alt=""><button data-rm="${i}" aria-label="Убрать фото">×</button></div>`
      : `<div class="att file${a.kind === "loading" ? " loading" : ""}"><b>${a.kind === "loading" ? "…" : esc((a.ext || "файл").toUpperCase())}</b><span>${esc(a.kind === "loading" ? "Читаю " + a.name : a.name)}</span><button data-rm="${i}" aria-label="Убрать файл">×</button></div>`).join("");
    el("atts").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { atts.splice(+b.dataset.rm, 1); renderComposer(); });
    const empty = !el("chatInput").value.trim();
    const hasDocs = atts.some(a => a.kind === "doc"), hasImgs = atts.some(a => a.kind === "image");
    const chipList = hasDocs
      ? ["Кратко перескажи", "Реши задания из файла", "Сделай конспект", "Проверь на ошибки", "Переведи на русский"]
      : ["Реши задачу и объясни по шагам", "Перепиши текст с фото", "Объясни, что здесь", "Переведи на русский", "Проверь моё решение"];
    el("chips").innerHTML = (hasDocs || hasImgs) && empty ? chipList.map(q => `<button data-chip="${esc(q)}">${esc(q)}</button>`).join("") : "";
    el("chips").querySelectorAll("[data-chip]").forEach(b => b.onclick = () => send(b.dataset.chip));
    const btn = el("sendBtn");
    const busyReading = atts.some(a => a.kind === "loading");
    btn.disabled = !streaming && ((empty && !atts.length) || busyReading);
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
    limit: "Бесплатные лимиты ИИ на сейчас закончились. Попробуй через минуту, а если не поможет — позже.",
    billing: "На счёте платного ИИ закончились деньги.",
    badkey: "Ключ ИИ на сервере неверный или не задан. Проверь ключи в настройках воркера на Cloudflare.",
    region: "ИИ недоступен из региона сервера. Включи Smart Placement у воркера на Cloudflare.",
    too_big: "Файлы слишком большие. Отправь поменьше или по одному.",
  };

  /** ctx — скрытый текст для Ребеки (например, список слов урока); в чате не показывается */
  async function send(text, ctx) {
    text = (text || "").trim();
    if (atts.some(a => a.kind === "loading")) return;
    if (streaming || (!text && !atts.length)) return;
    const imgs = atts.filter(a => a.kind === "image"), docs = atts.filter(a => a.kind === "doc");
    if (!text) text = docs.length ? "Прочитай файл и кратко расскажи, что в нём" : "Реши задачу с фото и объясни по шагам";
    if (!chat) chat = { id: newId(), title: "", created: Date.now(), updated: Date.now(), msgs: [] };

    const images = imgs.map(a => ({ mime: a.mime, data: a.data }));
    const userMsg = { role: "user", text, thumbs: imgs.map(a => a.thumb),
      files: docs.map(d => ({ name: d.name, ext: d.ext })), docText: docs.length ? docsBlock(docs) : (ctx || "") };
    chat.msgs = chat.msgs.filter(m => !m.error);
    chat.msgs.push(userMsg);
    if (!chat.title) chat.title = docs.length && text.startsWith("Прочитай файл") ? docs[0].name : (text.length > 48 ? text.slice(0, 46) + "…" : text);
    // В историю целиком кладём только самые свежие документы — старые урезаем, чтобы влезть в бесплатные лимиты
    const recent = chat.msgs.slice(-HISTORY);
    const lastDocIdx = recent.map(m => !!m.docText).lastIndexOf(true);
    const history = recent.map((m, i) => ({ role: m.role,
      text: (m.text || "") + (m.docText ? "\n\n" + (i === lastDocIdx ? m.docText : m.docText.slice(0, 1500) + "\n…(файл сокращён)") : "") }));
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
    const saved = { ...chat, msgs: keep.map(m => ({ role: m.role, text: m.text || "", thumbs: m.thumbs || [],
      ...((m.files && m.files.length) || m.docText ? { files: m.files || [], docText: (m.docText || "").slice(0, MAX_DOC_CHARS + 2000) } : {}) })) };
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
    const files = [...(e.clipboardData?.files || [])];
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
