// Стартовая страница: вход + список проектов + создание проекта.

(function () {
  const screenLogin = document.getElementById('screen-login');
  const screenProjects = document.getElementById('screen-projects');
  const grid = document.getElementById('projects-grid');
  const empty = document.getElementById('projects-empty');
  const userBadge = document.getElementById('user-badge');
  const loginError = document.getElementById('login-error');

  const modal = document.getElementById('modal-create');
  const npId = document.getElementById('np-id');
  const npName = document.getElementById('np-name');
  const npPassword = document.getElementById('np-password');
  const npShowPassword = document.getElementById('np-show-password');
  const npError = document.getElementById('np-error');
  const npPreview = document.getElementById('np-preview');

  const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/;

  const params = new URLSearchParams(location.search);
  let unlockHandled = false;

  let unsubProjects = null;

  // --- Роутер ---

  function showScreen(name) {
    screenLogin.classList.toggle('is-active', name === 'login');
    screenProjects.classList.toggle('is-active', name === 'projects');
  }

  function openBoard(slug) {
    const demo = window.__DEMO_MODE__ ? '&demo=1' : '';
    location.href = 'board.html?id=' + encodeURIComponent(slug) + demo;
  }

  // Открытие проекта из меню. Пароль спрашиваем здесь, до перехода на доску,
  // чтобы пользователь не видел содержимое проекта заранее.
  async function openProject(p) {
    if (!p) return;

    if (!window.Password || !window.Password.hasPassword(p)) {
      openBoard(p.id);
      return;
    }

    const everyTime = p.askPasswordEveryTime !== false;
    const unlockKey = 'miroz.unlocked.' + p.id;
    let unlocked = false;
    try { unlocked = sessionStorage.getItem(unlockKey) === p.passwordHash; }
    catch (e) { /* ignore */ }

    if (!everyTime && unlocked) {
      try { sessionStorage.removeItem('miroz.passonce.' + p.id); } catch (e) { /* ignore */ }
      openBoard(p.id);
      return;
    }

    const ok = await window.Password.ask(p, { cancelText: 'Отмена' });
    if (!ok) return;

    // Пропуск на один переход: доска не спросит пароль повторно.
    window.Password.rememberOnce(p);
    if (!everyTime) {
      try { sessionStorage.setItem(unlockKey, p.passwordHash); } catch (e) { /* ignore */ }
    }
    openBoard(p.id);
  }

  // После установки/смены пароля ProjectSettings уводит сюда:
  // index.html?unlock=<id>. Показываем плашку ввода пароля; отмена оставляет
  // пользователя в меню проектов.
  async function handleUnlockFromUrl() {
    if (unlockHandled) return;
    const id = params.get('unlock');
    if (!id) return;
    unlockHandled = true;

    // Убираем параметр, чтобы обновление страницы не повторяло запрос.
    params.delete('unlock');
    const qs = params.toString();
    try {
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) { /* ignore */ }

    let project = null;
    try {
      project = await window.Store.getProject(id);
    } catch (err) {
      console.error('Не удалось загрузить проект для разблокировки:', err);
      return;
    }
    if (!project) return;

    if (!window.Password || !window.Password.hasPassword(project)) {
      openBoard(project.id);
      return;
    }

    const ok = await window.Password.ask(project, { cancelText: 'Отмена' });
    if (!ok) return;
    window.Password.rememberOnce(project);
    openBoard(project.id);
  }

  // --- Список проектов ---

  function startProjects() {
    stopProjects();
    if (window.Store.subscribeProjects) {
      unsubProjects = window.Store.subscribeProjects(renderProjectList);
    } else {
      renderProjects();
    }
  }

  function stopProjects() {
    if (unsubProjects) { unsubProjects(); unsubProjects = null; }
  }

  async function renderProjects() {
    try {
      renderProjectList(await window.Store.listProjects());
    } catch (err) {
      console.error('Не удалось загрузить проекты:', err);
      alert('Ошибка загрузки проектов: ' + err.message +
        '\n\nПроверьте правила Firestore (Firestore → Rules).');
    }
  }

  function renderProjectList(projects) {
    grid.innerHTML = '';
    empty.classList.toggle('hidden', projects.length > 0);

    projects.forEach(p => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.innerHTML = `
        <div class="project-card__thumb">
          <span class="project-card__glyph">◆</span>
          <img class="project-card__thumb-img hidden" alt="" />
        </div>
        <div class="project-card__body">
          <p class="project-card__name"></p>
          <span class="project-card__meta"></span>
        </div>
        <button class="project-card__settings" title="Настройки">⚙</button>
      `;
      card.querySelector('.project-card__name').textContent = p.name;
      card.querySelector('.project-card__meta').textContent =
        '#' + p.id + ' · ' + formatDate(p.updatedAt) +
        (p.hasPassword ? ' · 🔒' : '') +
        (p.ownerName ? ' · 👤 ' + p.ownerName : '');

      const img = card.querySelector('.project-card__thumb-img');
      const glyph = card.querySelector('.project-card__glyph');
      const url = coverUrl(p);
      if (url) {
        img.src = url;
        img.classList.remove('hidden');
        glyph.classList.add('hidden');
        img.addEventListener('error', () => {
          img.classList.add('hidden');
          glyph.classList.remove('hidden');
        });
      }

      card.addEventListener('click', () => openProject(p));
      const gear = card.querySelector('.project-card__settings');
      if (window.ProjectAccess && !window.ProjectAccess.isOwner(p)) {
        gear.classList.add('hidden');
      }
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings(p);
      });

      grid.appendChild(card);
    });
  }

  function coverUrl(p) {
    return p && p.cover ? String(p.cover).trim() : '';
  }

  // --- Настройки проекта ---

  function openSettings(p) {
    const opened = window.ProjectSettings.open(p, {
      onSaved: () => { if (!unsubProjects) renderProjects(); },
      onDeleted: () => { if (!unsubProjects) renderProjects(); }
    });
    if (!opened) alert('Настройки проекта может менять только его создатель.');
  }

  function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // --- Модалка создания ---

  function openCreateModal() {
    npId.value = '';
    npName.value = '';
    npPassword.value = '';
    npPassword.type = 'password';
    npShowPassword.checked = false;
    npError.classList.add('hidden');
    updatePreview();
    modal.classList.remove('hidden');
    npId.focus();
  }

  function closeCreateModal() { modal.classList.add('hidden'); }

  function sanitizeSlug(value) {
    return value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  function updatePreview() {
    const slug = npId.value.trim();
    npPreview.textContent = '/' + (slug || 'id') + '.html';
  }

  async function submitCreate() {
    const slug = npId.value.trim();
    const name = npName.value.trim() || slug;

    if (!SLUG_RE.test(slug)) {
      npError.textContent = 'ID: 3–40 символов, только a–z, 0–9, «-» и «_» (не в начале/конце).';
      npError.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('np-create');
    btn.disabled = true;
    npError.classList.add('hidden');
    try {
      const password = npPassword.value;
      const opts = {};
      if (password) {
        const made = await window.Password.make(password);
        opts.passwordHash = made.hash;
        opts.passwordSalt = made.salt;
      }
      await window.Store.createProject(slug, name, opts);
      // Создатель только что задал пароль — не спрашиваем его сразу.
      if (opts.passwordHash && window.Password) {
        window.Password.rememberOnce({ id: slug, passwordHash: opts.passwordHash });
      }
      closeCreateModal();
      openBoard(slug);
    } catch (err) {
      npError.textContent = err.message;
      npError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  // --- Инициализация ---

  function init() {
    document.getElementById('btn-logout').addEventListener('click', () => window.Auth.signOut());
    document.getElementById('btn-create-project').addEventListener('click', openCreateModal);

    document.getElementById('btn-google').addEventListener('click', async () => {
      loginError.classList.add('hidden');
      try {
        await window.Auth.signInWithGoogle();
      } catch (err) {
        loginError.textContent = 'Ошибка входа: ' + err.message;
        loginError.classList.remove('hidden');
      }
    });

    // Демо-режим для разработчика: локальные проекты без входа и без базы.
    document.getElementById('btn-test').addEventListener('click', () => {
      location.href = 'index.html?demo=1';
    });

    // Модалка
    document.getElementById('np-cancel').addEventListener('click', closeCreateModal);
    document.getElementById('np-create').addEventListener('click', submitCreate);
    modal.querySelectorAll('[data-close="modal-create"]').forEach(el =>
      el.addEventListener('click', closeCreateModal));

    npShowPassword.addEventListener('change', () => {
      npPassword.type = npShowPassword.checked ? 'text' : 'password';
    });

    npId.addEventListener('input', () => {
      const caret = npId.selectionStart;
      const clean = sanitizeSlug(npId.value);
      if (clean !== npId.value) {
        npId.value = clean;
        npId.setSelectionRange(Math.min(caret, clean.length), Math.min(caret, clean.length));
      }
      npError.classList.add('hidden');
      updatePreview();
    });
    npId.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreate(); });
    npName.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreate(); });
    npPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreate(); });

    // Реакция на смену пользователя.
    window.Auth.onChange((user) => {
      if (user) {
        userBadge.textContent = user.displayName || user.email || 'Пользователь';
        userBadge.title = user.email || '';
        document.getElementById('btn-logout').classList.remove('hidden');
        showScreen('projects');
        startProjects();
        handleUnlockFromUrl();
      } else {
        stopProjects();
        closeCreateModal();
        userBadge.textContent = 'Гость';
        userBadge.title = 'Не авторизован';
        document.getElementById('btn-logout').classList.add('hidden');
        showScreen('login');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
