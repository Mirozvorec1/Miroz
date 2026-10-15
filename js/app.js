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
  const npError = document.getElementById('np-error');
  const npPreview = document.getElementById('np-preview');

  const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/;

  let unsubProjects = null;

  // --- Роутер ---

  function showScreen(name) {
    screenLogin.classList.toggle('is-active', name === 'login');
    screenProjects.classList.toggle('is-active', name === 'projects');
  }

  function openBoard(slug) {
    location.href = 'board.html?id=' + encodeURIComponent(slug);
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
        <div class="project-card__thumb">◆</div>
        <div class="project-card__body">
          <p class="project-card__name"></p>
          <span class="project-card__meta"></span>
        </div>
        <button class="project-card__delete" title="Удалить">×</button>
      `;
      card.querySelector('.project-card__name').textContent = p.name;
      card.querySelector('.project-card__meta').textContent =
        '#' + p.id + ' · ' + formatDate(p.updatedAt);

      card.addEventListener('click', () => openBoard(p.id));
      card.querySelector('.project-card__delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Удалить проект «${p.name}»?`)) {
          await window.Store.deleteProject(p.id);
          if (!unsubProjects) renderProjects();
        }
      });

      grid.appendChild(card);
    });
  }

  function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // --- Модалка создания ---

  function openCreateModal() {
    npId.value = '';
    npName.value = '';
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
      await window.Store.createProject(slug, name);
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

    // Модалка
    document.getElementById('np-cancel').addEventListener('click', closeCreateModal);
    document.getElementById('np-create').addEventListener('click', submitCreate);
    modal.querySelectorAll('[data-close="modal-create"]').forEach(el =>
      el.addEventListener('click', closeCreateModal));

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

    // Реакция на смену пользователя.
    window.Auth.onChange((user) => {
      if (user) {
        userBadge.textContent = user.displayName || user.email || 'Пользователь';
        userBadge.title = user.email || '';
        document.getElementById('btn-logout').classList.remove('hidden');
        showScreen('projects');
        startProjects();
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
