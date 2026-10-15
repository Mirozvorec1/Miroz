// Присутствие (курсоры) на Firebase Realtime Database.
//
// Курсоры — эфемерные данные: дешевле и быстрее держать их в RTDB,
// а не в Firestore. Каждая вкладка = отдельная «сессия» (sessionId),
// поэтому один и тот же аккаунт в двух окнах видит два курсора.
//
// Структура:  presence/{projectId}/{sessionId} = { uid, name, color, x, y, updatedAt }
//
// Если databaseURL не задан или RTDB недоступна — модуль работает как
// заглушка (курсоры просто не показываются, ничего не падает).

window.Presence = (function () {
  const sessionId = Math.random().toString(36).slice(2, 10);
  let db = null;

  function init() {
    const cfg = window.APP_CONFIG.firebaseConfig;
    if (!cfg || !cfg.enabled) return;
    if (typeof firebase === 'undefined' || !firebase.database) {
      console.warn('[presence] firebase-database-compat не загружен — курсоры выключены');
      return;
    }
    if (!cfg.databaseURL) {
      console.warn('[presence] не задан databaseURL в config.js — курсоры выключены');
      return;
    }
    try {
      db = firebase.database();
    } catch (e) {
      console.warn('[presence]', e.message);
      db = null;
    }
  }

  function enabled() { return !!db; }

  // onOthers(users[]) вызывается при каждом изменении; users НЕ содержит
  // собственную сессию этого окна.
  function subscribe(projectId, onOthers, onError) {
    if (!db) { if (onOthers) onOthers([]); return function () {}; }

    const ref = db.ref('presence/' + projectId);
    const cb = snap => {
      const val = snap.val() || {};
      const users = [];
      Object.keys(val).forEach(sid => {
        if (sid === sessionId) return; // себя не показываем
        const u = val[sid];
        if (u) users.push({ sessionId: sid, ...u });
      });
      if (onOthers) onOthers(users);
    };
    const errCb = err => { if (onError) onError(err); };

    ref.on('value', cb, errCb);
    // Автоочистка при закрытии вкладки/потере связи.
    ref.child(sessionId).onDisconnect().remove();

    return function unsubscribe() {
      try {
        ref.child(sessionId).onDisconnect().cancel();
        ref.child(sessionId).remove();
        ref.off('value', cb);
      } catch (e) { /* ignore */ }
    };
  }

  function update(projectId, data) {
    if (!db) return;
    db.ref('presence/' + projectId + '/' + sessionId).set(data).catch(() => {});
  }

  function leave(projectId) {
    if (!db) return;
    db.ref('presence/' + projectId + '/' + sessionId).remove().catch(() => {});
  }

  init();

  return { enabled, subscribe, update, leave, sessionId };
})();
