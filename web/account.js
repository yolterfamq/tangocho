// Аккаунт и синхронизация прогресса (Firebase Auth + Firestore).
// Без входа всё работает как раньше: прогресс на устройстве.
// После входа прогресс сливается с облаком и дальше синхронизируется сам.
(function () {
  const C = window.TANGOCHO_CONFIG || {};
  const FB = "https://cdn.jsdelivr.net/npm/firebase@10.14.1/";
  const configured = !!(C.firebase && C.firebase.apiKey && C.firebase.projectId);

  const A = window.Account = {
    configured, ready: false, failed: false, user: null,
    sync: "", syncAt: 0,            // "", "syncing", "ok", "error"
    mode: "choose",                 // choose | login | register | reset
    msg: "", msgOk: false, busy: false,
    listeners: [],
    onChange(f) { this.listeners.push(f); },
  };
  const emit = () => { A.render(); A.listeners.forEach(f => { try { f(A); } catch (e) {} }); };

  function load(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
      document.head.appendChild(s);
    });
  }

  // ───────── синхронизация ─────────
  let unsub = null, pushTimer = null, lastPushed = "", applying = false;

  function docRef() { return A.db.collection("users").doc(A.user.uid); }

  function setSync(state) { A.sync = state; if (state === "ok") A.syncAt = Date.now(); renderSyncLine(); }

  async function startSync() {
    setSync("syncing");
    try {
      const snap = await docRef().get();
      const remote = snap.exists && snap.data().state ? JSON.parse(snap.data().state) : null;
      const merged = mergeState(S, remote);
      applying = true; applyState(merged); applying = false;
      await push(true);
    } catch (e) {
      console.warn(e); setSync("error");
    }
    if (unsub) unsub();
    unsub = docRef().onSnapshot(snap => {
      if (snap.metadata.hasPendingWrites || !snap.exists) return;
      const raw = snap.data().state;
      if (!raw || raw === lastPushed) { setSync("ok"); return; }
      try {
        const merged = mergeState(S, JSON.parse(raw));
        applying = true; applyState(merged); applying = false;
        lastPushed = raw;
        setSync("ok");
      } catch (e) { console.warn(e); }
    }, err => { console.warn(err); setSync("error"); });
  }

  function stopSync() {
    if (unsub) unsub(); unsub = null;
    clearTimeout(pushTimer); lastPushed = "";
    A.sync = "";
  }

  async function push(now) {
    if (!A.user) return;
    clearTimeout(pushTimer);
    const run = async () => {
      const raw = JSON.stringify(S);
      if (raw === lastPushed) { setSync("ok"); return; }
      setSync("syncing");
      try {
        await docRef().set({ state: raw, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        lastPushed = raw;
        setSync("ok");
      } catch (e) { console.warn(e); setSync("error"); }
    };
    if (now) return run();
    pushTimer = setTimeout(run, 1500);
  }

  // Любое сохранение прогресса → через 1.5 с отправляем в облако
  syncHooks.push(() => { if (A.user && !applying) push(false); });

  // ───────── вход ─────────
  const ERR = {
    "auth/invalid-email": "Неверный адрес почты.",
    "auth/missing-password": "Введи пароль.",
    "auth/weak-password": "Пароль слишком простой: нужно хотя бы 6 символов.",
    "auth/email-already-in-use": "Аккаунт с этой почтой уже есть. Войди или восстанови пароль.",
    "auth/invalid-credential": "Неверная почта или пароль.",
    "auth/wrong-password": "Неверная почта или пароль.",
    "auth/user-not-found": "Аккаунта с этой почтой нет.",
    "auth/too-many-requests": "Слишком много попыток. Подожди пару минут.",
    "auth/network-request-failed": "Нет интернета.",
    "auth/popup-closed-by-user": "Окно входа закрыто.",
    "auth/account-exists-with-different-credential": "Эта почта уже зарегистрирована другим способом. Войди по почте и паролю.",
  };
  const errText = e => ERR[e && e.code] || ("Ошибка: " + ((e && e.message) || e));

  function setMsg(text, ok) { A.msg = text; A.msgOk = !!ok; A.render(); }

  async function withBusy(fn) {
    A.busy = true; A.render();
    try { await fn(); } catch (e) { setMsg(errText(e)); }
    A.busy = false; A.render();
  }

  A.google = () => withBusy(async () => {
    setMsg("");
    if (typeof isApp !== "undefined" && isApp) {
      // В приложении Google не пускает во встроенное окно — входим через обычный браузер
      setMsg("Открыл браузер. Войди там через Google и вернись сюда.", true);
      hostSend({ type: "googleLogin", url: C.authPage });
      return;
    }
    const p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    try { await A.auth.signInWithPopup(p); }
    catch (e) {
      if (e.code === "auth/popup-blocked") await A.auth.signInWithRedirect(p);
      else throw e;
    }
  });

  A.onHost = m => {
    if (m.type === "googleError") { setMsg(m.message || "Вход через Google не удался."); return; }
    withBusy(async () => {
      const cred = firebase.auth.GoogleAuthProvider.credential(m.idToken);
      await A.auth.signInWithCredential(cred);
      setMsg("");
    });
  };

  A.login = (email, pass) => withBusy(async () => {
    await A.auth.signInWithEmailAndPassword(email.trim(), pass);
    setMsg("");
  });

  A.register = (email, pass) => withBusy(async () => {
    const r = await A.auth.createUserWithEmailAndPassword(email.trim(), pass);
    try { await r.user.sendEmailVerification(); } catch (e) {}
    setMsg("Аккаунт создан. Мы отправили письмо для подтверждения почты.", true);
  });

  A.reset = email => withBusy(async () => {
    await A.auth.sendPasswordResetEmail(email.trim());
    setMsg("Письмо для смены пароля отправлено на " + email.trim(), true);
  });

  A.verify = () => withBusy(async () => {
    await A.user.sendEmailVerification();
    setMsg("Письмо отправлено. Открой ссылку в нём, потом нажми «Я подтвердил».", true);
  });

  A.reloadUser = () => withBusy(async () => {
    await A.user.reload();
    A.user = A.auth.currentUser;
    await A.user.getIdToken(true);
    setMsg(A.user.emailVerified ? "Почта подтверждена." : "Почта ещё не подтверждена.", A.user.emailVerified);
    emit();
  });

  A.logout = () => withBusy(async () => {
    await push(true);
    await A.auth.signOut();
    setMsg("Ты вышел. Прогресс остался на этом устройстве.", true);
  });

  A.token = async () => A.user ? A.user.getIdToken() : null;

  // ───────── интерфейс в настройках ─────────
  const GICON = '<svg viewBox="0 0 24 24"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z"/></svg>';

  function timeAgo(t) {
    const d = new Date(t);
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function renderSyncLine() {
    const el = document.getElementById("syncLine");
    if (!el) return;
    el.className = "sync" + (A.sync === "ok" ? " ok" : A.sync === "error" ? " err" : "");
    el.textContent = A.sync === "syncing" ? "Синхронизирую…"
      : A.sync === "ok" ? "Прогресс синхронизирован · " + timeAgo(A.syncAt)
      : A.sync === "error" ? "Не удалось синхронизировать. Проверь интернет — попробую ещё раз при следующем ответе."
      : "";
  }

  A.render = function () {
    const box = document.getElementById("accBox");
    if (!box) return;
    const hint = document.getElementById("progHint");
    const msg = A.msg ? `<span class="${A.msgOk ? "msg-ok" : "msg-err"}">${esc(A.msg)}</span>` : "";
    const dis = A.busy ? " disabled" : "";

    if (!configured) {
      box.innerHTML = `<span class="hint">Аккаунты ещё не настроены (нужно заполнить config.js).</span>`;
      return;
    }
    if (A.failed) {
      box.innerHTML = `<span class="hint">Нет связи с сервером аккаунтов. Проверь интернет и открой настройки снова.</span>`;
      return;
    }
    if (!A.ready) { box.innerHTML = `<span class="hint">Загрузка…</span>`; return; }

    if (A.user) {
      const u = A.user, name = u.displayName || u.email || "Аккаунт";
      const av = u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(name[0].toUpperCase());
      const needVerify = !u.emailVerified && u.providerData.some(p => p.providerId === "password");
      box.innerHTML = `<div class="acc-card">
        <div class="acc-who"><span class="avatar">${av}</span><div><b>${esc(name)}</b>${u.displayName && u.email ? `<span class="hint">${esc(u.email)}</span>` : ""}</div></div>
        <span id="syncLine"></span>
        ${needVerify ? `<span class="hint">Почта не подтверждена. Подтверди её, чтобы пользоваться Ребекой.</span>
          <div class="upd-row"><button class="btn" id="accVerify"${dis}>Отправить письмо</button><button class="btn" id="accReload"${dis}>Я подтвердил</button></div>` : ""}
        ${msg}
        <button class="btn" id="accOut"${dis}>Выйти</button>
      </div>`;
      renderSyncLine();
      if (hint) hint.textContent = "Прогресс сохраняется в аккаунте и одинаковый на всех устройствах, где ты вошёл.";
      const v = document.getElementById("accVerify"); if (v) v.onclick = A.verify;
      const r = document.getElementById("accReload"); if (r) r.onclick = A.reloadUser;
      document.getElementById("accOut").onclick = A.logout;
      return;
    }

    if (hint) hint.textContent = "Прогресс хранится на этом устройстве. Войди в аккаунт, чтобы он был одинаковым на ПК, телефоне и сайте.";

    if (A.mode === "choose") {
      box.innerHTML = `<div class="acc-card">
        <span class="hint">Войди, чтобы прогресс сохранялся в облаке и был одинаковым на всех устройствах.</span>
        <div class="upd-row">
          <button class="btn gbtn" id="accGoogle"${dis}>${GICON} Войти через Google</button>
          <button class="btn" id="accMail"${dis}>Войти по почте</button>
        </div>
        ${msg}
      </div>`;
      document.getElementById("accGoogle").onclick = A.google;
      document.getElementById("accMail").onclick = () => { A.mode = "login"; A.msg = ""; A.render(); };
      return;
    }

    const isReg = A.mode === "register", isReset = A.mode === "reset";
    // Не теряем введённое при перерисовке (ошибка, загрузка)
    const prevEmail = document.getElementById("accEmail")?.value || A.lastEmail || "";
    const prevPass = document.getElementById("accPass")?.value || "";
    box.innerHTML = `<form class="form" id="accForm" autocomplete="on">
      <input type="email" id="accEmail" placeholder="Почта" autocomplete="email" required>
      ${isReset ? "" : `<input type="password" id="accPass" placeholder="Пароль${isReg ? " (от 6 символов)" : ""}" autocomplete="${isReg ? "new-password" : "current-password"}" required>`}
      <button class="btn primary" type="submit"${dis}>${isReg ? "Создать аккаунт" : isReset ? "Прислать письмо" : "Войти"}</button>
      ${msg}
      ${isReg || isReset ? `<button type="button" class="linkbtn" id="accToLogin">У меня уже есть аккаунт</button>`
        : `<button type="button" class="linkbtn" id="accToReg">Создать аккаунт</button>
           <button type="button" class="linkbtn" id="accToReset">Забыл пароль</button>`}
      <button type="button" class="linkbtn" id="accBack">← Другие способы входа</button>
    </form>`;
    const f = document.getElementById("accForm");
    document.getElementById("accEmail").value = prevEmail;
    if (document.getElementById("accPass")) document.getElementById("accPass").value = prevPass;
    f.onsubmit = e => {
      e.preventDefault();
      const em = document.getElementById("accEmail").value, pw = document.getElementById("accPass")?.value || "";
      A.lastEmail = em;
      if (isReg) A.register(em, pw); else if (isReset) A.reset(em); else A.login(em, pw);
    };
    const go = (id, mode) => { const b = document.getElementById(id); if (b) b.onclick = () => { A.mode = mode; A.msg = ""; A.render(); }; };
    go("accToLogin", "login"); go("accToReg", "register"); go("accToReset", "reset"); go("accBack", "choose");
  };

  // ───────── запуск ─────────
  async function init() {
    if (!configured) { A.render(); return; }
    try {
      await load(FB + "firebase-app-compat.js");
      await Promise.all([load(FB + "firebase-auth-compat.js"), load(FB + "firebase-firestore-compat.js")]);
    } catch (e) {
      A.failed = true; emit();
      // Нет интернета — попробуем ещё раз, когда он появится
      window.addEventListener("online", () => location.reload(), { once: true });
      return;
    }
    firebase.initializeApp(C.firebase);
    A.auth = firebase.auth();
    A.db = firebase.firestore();
    try { A.auth.useDeviceLanguage(); } catch (e) {}
    try { await A.auth.getRedirectResult(); } catch (e) { setMsg(errText(e)); }

    A.auth.onAuthStateChanged(u => {
      A.user = u; A.ready = true;
      if (u) { A.mode = "choose"; startSync(); } else stopSync();
      emit();
    });
    // Вернулись в приложение / вкладку — подтянем свежий прогресс
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && A.user && A.sync === "error") startSync();
    });
  }
  init();
})();
