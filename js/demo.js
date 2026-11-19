// Демо-режим для разработчика: ?demo=1.
//
// Кнопка «Тест» на экране входа открывает ?demo=1: сразу список проектов,
// без входа через Google и без обращения к Firebase.
//
// Проекты, элементы и настройки сохраняются только в localStorage этого
// браузера (через window.__LocalStore из js/storage.js). В Firestore и
// Realtime Database ничего не пишется.
//
// Файл подключается после js/storage.js и до js/firebase.js.

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('demo') !== '1') return;

  window.__DEMO_MODE__ = true;

  const DEMO_USER = {
    uid: 'demo-user',
    displayName: 'Тест',
    email: '',
    isAnonymous: true
  };
  window.currentUser = DEMO_USER;

  // Локальное хранилище использует эти данные для владельца проектов.
  window.APP_CONFIG.localUser = {
    id: DEMO_USER.uid,
    name: DEMO_USER.displayName,
    color: '#4262ff'
  };

  // Фиктивный Auth: пользователь уже «вошёл», регистрация не нужна.
  const DemoAuth = {
    async signInWithGoogle() {},
    async signOut() { location.href = 'index.html'; },
    onChange(cb) { setTimeout(() => cb(DEMO_USER), 0); }
  };

  window.Store = window.__LocalStore;
  window.Auth = DemoAuth;

  document.addEventListener('DOMContentLoaded', () => {
    // Ссылки «В меню» должны сохранять демо-режим.
    document.querySelectorAll('a[href="index.html"]').forEach(a => {
      a.setAttribute('href', 'index.html?demo=1');
    });

    if (document.getElementById('demo-badge')) return;
    const onBoard = !!document.getElementById('canvas-viewport');
    const onProfile = !!document.querySelector('.profile');
    const badge = document.createElement('div');
    badge.id = 'demo-badge';
    badge.className = 'demo-badge';
    badge.textContent = onBoard ? 'ТЕСТ · локально'
      : onProfile ? 'ТЕСТ · локальный профиль'
      : 'ТЕСТ · проекты в этом браузере';
    badge.title = 'Демо-режим: данные не записываются в базу';
    document.body.appendChild(badge);
  });
})();