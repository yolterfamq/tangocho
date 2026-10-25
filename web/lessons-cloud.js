// Общие уроки в облаке (Firestore, коллекция lessons) — одни на двоих.
// Здесь лежат уроки, добавленные по фото, и правки встроенных уроков (тогда документ с тем же id, что у файла).
// Документ: { title, jp, type, order, data: JSON {items, keys, next}, deleted, updatedBy, updatedAt }
// Копия хранится на устройстве, чтобы уроки были и без интернета.
(function () {
  const CACHE = "tango-cloud-lessons";
  const CL = window.CloudLessons = { docs: {}, live: false, denied: false, error: "", listeners: [] };
  CL.onChange = f => CL.listeners.push(f);
  const emit = () => CL.listeners.forEach(f => { try { f(); } catch (e) {} });

  try { CL.docs = JSON.parse(localStorage.getItem(CACHE) || "{}") || {}; } catch (e) {}
  const keep = () => { try { localStorage.setItem(CACHE, JSON.stringify(CL.docs)); } catch (e) {} };

  CL.isBuiltin = id => BUILTIN.some(b => b.id === id);

  /** Встроенные уроки + облако → итоговый список */
  function build() {
    const map = new Map(BUILTIN.map(l => [l.id, l]));
    for (const [id, d] of Object.entries(CL.docs)) {
      if (!d) continue;
      if (d.deleted) { map.delete(id); continue; }
      let data;
      try { data = JSON.parse(d.data || "{}"); } catch (e) { continue; }
      if (!data || !Array.isArray(data.items)) continue;
      const base = BUILTIN.find(b => b.id === id);
      const items = data.items.map(w => [0, 1, 2, 3].map(k => String(w && w[k] != null ? w[k] : "")));
      const keys = Array.isArray(data.keys) && data.keys.length === items.length ? data.keys.map(String) : items.map((_, i) => String(i));
      map.set(id, {
        id, items, keys, next: +data.next || 0,
        type: d.type || (base && base.type) || "words",
        title: d.title || (base && base.title) || "Урок",
        jp: d.jp != null ? d.jp : (base && base.jp) || "",
        order: d.order != null ? d.order : base && base.order,
        builtin: !!base, cloud: true, updatedBy: d.updatedBy || "",
      });
    }
    setLessons([...map.values()]);
    emit();
  }

  const plain = d => ({
    title: d.title || "", jp: d.jp || "", type: d.type || "words",
    order: typeof d.order === "number" ? d.order : null,
    data: d.data || "", deleted: !!d.deleted, updatedBy: d.updatedBy || "",
  });

  // ───────── слушаем облако, когда вошли ─────────
  let unsub = null, uid = null;
  function watch() {
    const A = window.Account;
    // после подтверждения почты подписываемся заново: раньше база могла отказать
    const u = A && A.user && A.db ? A.user.uid + (A.user.emailVerified ? "+" : "-") : null;
    if (u === uid) return;
    uid = u;
    if (unsub) { unsub(); unsub = null; }
    CL.live = false; CL.denied = false; CL.error = "";
    emit();
    if (!u) return;
    unsub = A.db.collection("lessons").onSnapshot(snap => {
      const docs = {};
      snap.forEach(doc => { docs[doc.id] = plain(doc.data()); });
      CL.docs = docs; CL.live = true; CL.denied = false; CL.error = "";
      keep(); build();
    }, err => {
      console.warn(err);
      CL.denied = !!err && err.code === "permission-denied";
      CL.error = (err && err.message) || "ошибка";
      emit();
    });
  }

  /** Подписаться заново (например, после публикации новых правил в Firebase) */
  CL.retry = () => { uid = null; watch(); };
  // Вернулись в приложение, а доступа не было — пробуем ещё раз
  const again = () => { if (CL.denied && document.visibilityState === "visible") CL.retry(); };
  window.addEventListener("focus", again);
  document.addEventListener("visibilitychange", again);

  function need() {
    const A = window.Account;
    if (!A || !A.configured) throw new Error("Аккаунты не настроены");
    if (!A.user || !A.db) throw new Error("Сначала войди в аккаунт: Настройки → Аккаунт");
    return A;
  }
  const friendly = e => new Error(e && e.code === "permission-denied"
    ? "Нет доступа к общим урокам. Добавлять уроки могут только мы двое (и почта должна быть подтверждена)."
    : "Не удалось сохранить: " + ((e && e.message) || e));

  /** Сохранить урок. l: { id?, title, jp, type, order, items, keys, next }. Возвращает id. */
  CL.save = async l => {
    const A = need();
    const id = l.id || ("u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const doc = {
      title: l.title, jp: l.jp || "", type: l.type, order: l.order,
      data: JSON.stringify({ items: l.items, keys: l.keys, next: l.next || 0 }),
      deleted: false, updatedBy: A.user.email || "",
    };
    const before = CL.docs[id];
    CL.docs[id] = plain(doc); keep(); build();       // сразу показываем, облако догонит
    try {
      await A.db.collection("lessons").doc(id).set({ ...doc, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      if (before) CL.docs[id] = before; else delete CL.docs[id];
      keep(); build();
      throw friendly(e);
    }
    return id;
  };

  /** Удалить урок. Встроенный (из файла) просто скрываем у обоих. */
  CL.remove = async id => {
    const A = need();
    const before = CL.docs[id];
    const ref = A.db.collection("lessons").doc(id);
    if (CL.isBuiltin(id)) CL.docs[id] = plain({ deleted: true });
    else delete CL.docs[id];
    keep(); build();
    try {
      if (CL.isBuiltin(id)) await ref.set({ deleted: true, updatedBy: A.user.email || "", updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      else await ref.delete();
    } catch (e) {
      if (before) CL.docs[id] = before; else delete CL.docs[id];
      keep(); build();
      throw friendly(e);
    }
  };

  if (Object.keys(CL.docs).length) build();
  if (window.Account) { Account.onChange(watch); watch(); }
})();
