// Редактор урока: новый урок по фото страниц, правка слов, дописать фото, удалить.
// Страницы читает Ребека (сервер /extract), сохраняем в общие уроки (lessons-cloud.js).
(function () {
  const C = window.TANGOCHO_CONFIG || {};
  const URL_ = (C.rebeccaUrl || "").replace(/\/+$/, "");
  const view = $("editView");
  const drafts = {};                 // id урока (или "new") → черновик
  let d = null;                      // открытый черновик

  const WORDS_PH = ["かな", "漢字", "перевод", "пояснение (необязательно)"];
  const KANJI_PH = ["漢", "значение", "くんよみ", "オンヨミ"];
  const FW = "０１２３４５６７８９";
  const jpTitle = t => { const m = /^Урок\s*(\d+)\s*$/i.exec(t || ""); return m ? "だい" + m[1].replace(/\d/g, c => FW[+c]) + "か" : ""; };
  const sameKey = (type, w) => type === "kanji" ? w[0].trim() : (w[0] + "|" + w[1]).replace(/\s/g, "");
  const ERR = {
    unauthorized: "Нужно войти в аккаунт (Настройки → Аккаунт).",
    denied: "Читать страницы может только Ребека для нас двоих — этот аккаунт не в списке.",
    unverified: "Подтверди почту (письмо пришло при регистрации) и попробуй снова.",
    limit: "Бесплатный лимит ИИ на сейчас закончился. Попробуй через несколько минут.",
    too_big: "Фото слишком большое.",
  };

  const Ed = window.Editor = {
    /** Есть ли несохранённый черновик (id = null — новый урок) */
    draftFor(id) { const x = drafts[id || "new"]; return x && x.dirty ? x : null; },
    open(id) {
      const k = id || "new";
      if (!drafts[k] || (!drafts[k].dirty && !drafts[k].busy)) drafts[k] = fresh(id);
      d = drafts[k];
      show("edit"); render();
      view.scrollTop = 0;
    },
  };

  function fresh(id) {
    const l = id ? LBY[id] : null;
    return {
      k: id || "new", id: l ? l.id : null, title: l ? l.title : "", type: l ? (l.type || "words") : "",
      order: l ? (l.order != null ? l.order : null) : null, jpOld: l ? l.jp || "" : "", titleOld: l ? l.title : "",
      rows: l ? l.items.map((w, i) => ({ key: keyOf(l, i), w: w.slice(0, 4).concat(["", "", "", ""]).slice(0, 4) })) : [],
      next: l ? (l.next || 0) : 0,
      dirty: false, busy: false, status: "", errs: [], notes: [], confirmDel: false, saving: false, saveErr: "",
    };
  }

  // ───────── отрисовка ─────────
  function gate() {
    const A = window.Account, CL = window.CloudLessons;
    if (!A || !A.configured) return "Добавлять уроки можно, когда настроены аккаунты.";
    if (A.failed) return "Нет связи с сервером аккаунтов. Проверь интернет.";
    if (!A.ready) return "Загрузка аккаунта…";
    if (!A.user) return `Чтобы добавлять и менять уроки, войди в аккаунт. <button class="btn sm" data-act="settings">Открыть настройки</button>`;
    if (!A.user.emailVerified) return "Подтверди почту — письмо пришло при регистрации. Потом нажми «Я подтвердил(а)» в настройках.";
    if (CL && CL.denied) return `База не пускает к общим урокам аккаунт <b>${esc(A.user.email || "")}</b>.<br>
      Если это одна из наших двух почт — значит, в Firebase ещё не опубликованы новые правила: Firestore Database → Rules → вставить firestore.rules → Publish.
      <button class="btn sm" data-act="retry">Проверить снова</button>`;
    return "";
  }

  function rowHtml(r, i) {
    const ph = d.type === "kanji" ? KANJI_PH : WORDS_PH;
    const inp = (f, cls) => `<input class="${cls}" data-r="${i}" data-f="${f}" value="${esc(r.w[f])}" placeholder="${esc(ph[f])}" autocomplete="off" spellcheck="false">`;
    const x = `<button class="icon ex" data-del="${i}" aria-label="Удалить строку" title="Удалить строку">×</button>`;
    if (d.type === "kanji")
      return `<div class="erow k${r.fresh ? " fresh" : ""}">${inp(0, "jp big")}${inp(1, "")}${x}${inp(2, "jp")}${inp(3, "jp")}</div>`;
    return `<div class="erow${r.fresh ? " fresh" : ""}">${inp(0, "jp")}${inp(1, "jp")}${x}${inp(2, "")}${inp(3, "sm")}</div>`;
  }

  function render() {
    if (!d) return;
    const g = gate(), locked = !!g, n = d.rows.filter(r => !empty(r)).length, freshN = d.rows.filter(r => r.fresh).length;
    const isNew = !d.id, lockType = !!d.type && (!isNew || d.rows.some(r => !empty(r)));
    view.innerHTML = `
      <div class="ed-head">
        <button class="icon" data-act="back" aria-label="К урокам" title="К урокам">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
        <h2>${isNew ? "Новый урок" : "Изменить урок"}</h2>
      </div>
      ${g ? `<div class="ed-note warn">${g}</div>` : ""}
      ${d.notes.map(t => `<div class="ed-note">${esc(t)}</div>`).join("")}
      <div class="field">
        <label for="edTitle">Название</label>
        <input class="ed-in" id="edTitle" value="${esc(d.title)}" placeholder="Например: Урок 6" autocomplete="off">
      </div>
      <div class="field">
        <span class="lbl">Что в уроке</span>
        <div class="seg" id="edType">
          <button data-type="words" aria-pressed="${d.type === "words"}"${lockType ? " disabled" : ""}>Слова</button>
          <button data-type="kanji" aria-pressed="${d.type === "kanji"}"${lockType ? " disabled" : ""}>Канджи</button>
        </div>
        ${isNew && !d.type ? `<span class="hint">Можно не выбирать — Ребека поймёт по фото.</span>` : ""}
      </div>
      <div class="field">
        <span class="lbl">Страницы учебника</span>
        <button class="btn primary" data-act="photos"${locked || d.busy ? " disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          ${d.rows.length ? "Дописать фото страниц" : "Добавить фото страниц"}</button>
        <span class="hint">Фото или скриншоты, можно несколько сразу. Ребека прочитает каждую страницу и добавит слова в таблицу — проверь их перед сохранением.</span>
        ${d.status ? `<div class="ed-status${d.busy ? " busy" : ""}">${esc(d.status)}</div>` : ""}
        ${d.errs.map(t => `<div class="ed-err">${esc(t)}</div>`).join("")}
      </div>
      ${d.type ? `
      <div class="ed-sub"><b>${n} ${d.type === "kanji" ? "канджи" : plural(n)}</b>${freshN ? `<button class="linkb" data-act="tofresh">новые строки подсвечены (${freshN}) — показать</button>` : ""}</div>
      <div class="ed-rows" id="edRows">${d.rows.map(rowHtml).join("")}</div>
      <button class="btn" data-act="addrow">＋ Строка вручную</button>` : ""}
      <div class="ed-bar">
        ${d.saveErr ? `<div class="ed-err">${esc(d.saveErr)}</div>` : ""}
        <div class="upd-row">
          <button class="btn primary" data-act="save"${locked || d.busy || d.saving || !n || !d.type ? " disabled" : ""}>${d.saving ? "Сохраняю…" : "Сохранить"}</button>
          <button class="btn" data-act="cancel"${d.saving ? " disabled" : ""}>Отмена</button>
        </div>
      </div>
      <p class="hint">Урок появится у нас обоих${isNew ? " и сразу будет отмечен галочкой" : ""}. Прогресс у каждого свой.</p>
      ${isNew ? "" : `
      <div class="field ed-del">
        ${d.confirmDel ? `<div class="confirm"><span>Удалить «${esc(d.titleOld)}» у вас обоих?</span>
          <button class="yes" data-act="delyes">Удалить</button><button class="no" data-act="delno">Отмена</button></div>`
        : `<button class="danger" data-act="del"${locked ? " disabled" : ""}>Удалить урок</button>`}
      </div>`}
      <input type="file" id="edFile" accept="image/*" multiple hidden>`;
  }
  const empty = r => !r.w.some(x => x.trim());
  const plural = n => n % 10 === 1 && n % 100 !== 11 ? "слово" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "слова" : "слов";

  // ───────── действия ─────────
  view.addEventListener("input", e => {
    if (!d) return;
    const t = e.target;
    if (t.id === "edTitle") { d.title = t.value; d.dirty = true; return; }
    if (t.dataset.r != null) { d.rows[+t.dataset.r].w[+t.dataset.f] = t.value; d.dirty = true; }
  });
  view.addEventListener("change", e => { if (e.target.id === "edFile") { addPhotos([...e.target.files]); e.target.value = ""; } });
  view.addEventListener("click", e => {
    if (!d) return;
    const typ = e.target.closest("[data-type]");
    if (typ && !typ.disabled) { d.type = typ.dataset.type; d.dirty = true; render(); return; }
    const del = e.target.closest("[data-del]");
    if (del) { d.rows.splice(+del.dataset.del, 1); d.dirty = true; render(); return; }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    switch (b.dataset.act) {
      case "back": show("lessons"); break;
      case "settings": show("set"); break;
      case "retry": if (window.CloudLessons) CloudLessons.retry(); break;
      case "photos": view.querySelector("#edFile").click(); break;
      case "addrow":
        d.rows.push({ key: null, w: ["", "", "", ""], fresh: true }); d.dirty = true; render();
        { const ins = view.querySelectorAll(".erow:last-child input"); if (ins[0]) ins[0].focus(); }
        break;
      case "save": save(); break;
      case "tofresh": { const f = view.querySelector(".erow.fresh"); if (f) f.scrollIntoView({ block: "center", behavior: "smooth" }); } break;
      case "cancel": delete drafts[d.k]; d = null; show("lessons"); break;
      case "del": d.confirmDel = true; render(); break;
      case "delno": d.confirmDel = false; render(); break;
      case "delyes": remove(); break;
    }
  });

  /** Фото → JPEG не больше 2000px по длинной стороне */
  function shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const x = c.getContext("2d");
        x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        res({ mime: "image/jpeg", data: c.toDataURL("image/jpeg", 0.88).split(",")[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("не получилось открыть картинку")); };
      img.src = u;
    });
  }

  async function extract(image, hint) {
    if (!URL_) throw new Error("Не задан адрес Ребеки в config.js");
    const token = await Account.token();
    const r = await fetch(URL_ + "/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ image, hint: hint || "" }),
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (r.status === 404) throw new Error("на сервере Ребеки старая версия. Вставь новый rebecca-worker/worker.js в Cloudflare (Edit code → Deploy).");
    if (!r.ok) throw new Error(ERR[j.code] || j.error || ("сервер ответил " + r.status));
    return j;
  }

  async function addPhotos(files) {
    files = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|gif|bmp)$/i.test(f.name));
    if (!files.length || !d) return;
    let draft = d;
    draft.busy = true; draft.errs = []; draft.saveErr = "";
    let added = 0, skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const name = files.length > 1 ? "Страница " + (i + 1) : "Страница";
      draft.status = files.length > 1 ? `Ребека читает страницу ${i + 1} из ${files.length}…` : "Ребека читает страницу…";
      if (d === draft) render();
      try {
        const res = await extract(await shrink(files[i]), draft.type);
        if (res.type === "none" || !res.items || !res.items.length) {
          draft.errs.push(name + ": не нашла на ней слов или канджи." + (res.trace && res.trace.length ? " Подробности: " + res.trace.join(" | ") : ""));
          continue;
        }
        // Канджи в новом уроке → дописываем в общий набор «Канджи», как договорились
        if (!draft.id && !draft.type && res.type === "kanji") {
          const kl = LESSONS.find(isKanji);
          if (kl) {
            const target = drafts[kl.id] && (drafts[kl.id].dirty || drafts[kl.id].busy) ? drafts[kl.id] : (drafts[kl.id] = fresh(kl.id));
            Object.assign(target, { busy: true, status: draft.status, errs: draft.errs });
            target.notes = ["Это страница с канджи — добавляю в набор «" + kl.title + "»."];
            delete drafts[draft.k];
            if (d === draft) { d = target; }
            draft = target;
          }
        }
        if (!draft.type) draft.type = res.type;
        if (res.type !== draft.type) {
          draft.errs.push(name + ": это страница с " + (res.type === "kanji" ? "канджи" : "новыми словами") + ", а урок — " + (draft.type === "kanji" ? "канджи" : "со словами") + ". Пропустила.");
          continue;
        }
        if (!draft.title && res.title) draft.title = res.title;
        const seen = new Set(draft.rows.map(r => sameKey(draft.type, r.w)));
        for (const w of res.items) {
          const k = sameKey(draft.type, w);
          if (seen.has(k)) { skipped++; continue; }
          seen.add(k);
          draft.rows.push({ key: null, w: w.slice(0, 4), fresh: true });
          added++;
        }
        draft.dirty = true;
      } catch (e) {
        draft.errs.push(name + ": " + (e.message || e));
      }
    }
    draft.busy = false;
    draft.status = added ? `Готово: добавлено ${added} ${draft.type === "kanji" ? "канджи" : plural(added)}${skipped ? `, ${skipped} уже было в уроке` : ""}. Проверь подсвеченные строки и нажми «Сохранить».`
      : skipped ? "Всё с этих страниц уже есть в уроке." : "";
    if (d === draft && view && !view.hidden) render();
    else if (window.renderLessons && !$("lessonsView").hidden) renderLessons();
  }

  async function save() {
    const title = (d.title || "").trim() || (d.type === "kanji" ? "Канджи" : "Урок");
    const rows = d.rows.filter(r => !empty(r)).map(r => ({ ...r, w: r.w.map(x => x.trim()) }));
    if (!rows.length) return;
    const used = new Set(rows.map(r => r.key).filter(Boolean));
    let next = d.next || 0;
    for (const r of rows) if (!r.key) { do { next++; } while (used.has("n" + next)); r.key = "n" + next; used.add(r.key); }
    const jp = title === d.titleOld && d.jpOld ? d.jpOld : d.type === "kanji" ? (d.jpOld || "かんじ") : jpTitle(title);
    d.saving = true; d.saveErr = ""; render();
    try {
      await CloudLessons.save({ id: d.id, title, jp, type: d.type, order: d.order, items: rows.map(r => r.w), keys: rows.map(r => r.key), next });
      delete drafts[d.k]; d = null;
      show("lessons");
    } catch (e) {
      d.saving = false; d.saveErr = e.message || String(e); render();
    }
  }

  async function remove() {
    try {
      await CloudLessons.remove(d.id);
      delete drafts[d.k]; d = null;
      show("lessons");
    } catch (e) {
      d.confirmDel = false; d.saveErr = e.message || String(e); render();
    }
  }

  // Вход/выход и доступ к общим урокам меняют подсказки в редакторе
  const rerender = () => { if (d && !view.hidden) render(); };
  if (window.Account) Account.onChange(rerender);
  if (window.CloudLessons) CloudLessons.onChange(rerender);

  // стили редактора
  const st = document.createElement("style");
  st.textContent = `
.ed-head{display:flex;align-items:center;gap:6px;margin:0 0 4px -8px}
.ed-head h2{margin:0}
.ed-note{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-size:14px;line-height:1.5;margin-block:8px}
.ed-note.warn{border-color:var(--again)}
.ed-note .btn{margin-top:8px;display:block}
.ed-in{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--fg);font:inherit}
#editView .btn svg{width:18px;height:18px;vertical-align:-4px;margin-right:6px}
#editView .seg button:disabled{opacity:.55;cursor:default}
.ed-status{font-size:15px;line-height:1.5;color:var(--good)}
.ed-status.busy{color:var(--accent)}
.ed-status.busy::before{content:"";display:inline-block;width:12px;height:12px;margin-right:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:edspin .8s linear infinite;vertical-align:-1px}
@keyframes edspin{to{transform:rotate(360deg)}}
.ed-err{font-size:14px;color:var(--again);line-height:1.45}
.ed-sub{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin:16px 0 8px}
.linkb{font-size:13px;color:var(--accent);text-decoration:underline;text-underline-offset:3px;padding:0}
#editView .seg{flex-direction:row}
#editView .seg button{width:auto;flex:1;text-align:center}
.ed-rows{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.erow{display:grid;grid-template-columns:1fr 1fr 36px;gap:6px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.erow.fresh{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.erow input{min-width:0;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:15px;user-select:text;-webkit-user-select:text}
.erow input:nth-of-type(3){grid-column:1/-1}
.erow input.sm{grid-column:1/-1;font-size:14px}
.erow input.jp{font-family:var(--jp);font-size:17px;font-weight:600}
.erow .ex{width:36px;height:36px;color:var(--muted);font-size:20px}
.erow.k{grid-template-columns:64px 1fr 1fr 36px}
.erow.k input:nth-of-type(2){grid-column:2/4}
.erow.k input.big{font-size:26px;text-align:center;padding:4px}
.erow.k input:nth-of-type(3){grid-column:1/3}
.erow.k input:nth-of-type(4){grid-column:3/-1}
.ed-bar{position:sticky;bottom:0;background:var(--bg);padding:12px 0 calc(8px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line);margin-top:12px;display:flex;flex-direction:column;gap:8px}
.ed-del{border-bottom:0}
.btn.sm{padding:6px 10px;font-size:14px}`;
  document.head.appendChild(st);
})();
