// Основная логика: переключение экранов и список проектов.

(function () {
  const screenLogin = document.getElementById('screen-login');
  const screenProjects = document.getElementById('screen-projects');
  const screenBoard = document.getElementById('screen-board');
  const grid = document.getElementById('projects-grid');
  const empty = document.getElementById('projects-empty');
  const boardTitle = document.getElementById('board-title');
  const userBadge = document.getElementById('user-badge');
  const loginError = document.getElementById('login-error');

  let currentProject = null;

  // --- Роутер ---

  function showScreen(name) {
    screenLogin.classList.toggle('is-active', name === 'login');
    screenProjects.classList.toggle('is-active', name === 'projects');
    screenBoard.classList.toggle('is-active', name === 'board');
  }

  async function openProject(project) {
    currentProject = project;
    boardTitle.value = project.name;
    document.title = project.name + ' — Miroz';
    await window.Board.load(project.id);
    showScreen('board');
  }

  async function goToProjects() {
    currentProject = null;
    document.title = 'Miroz';
    showScreen('projects');
    await renderProjects();
  }

  // --- Список проектов ---

  async function renderProjects() {
    let projects = [];
    try {
      projects = await window.Store.listProjects();
    } catch (err) {
      console.error('Не удалось загрузить проекты:', err);
      alert('Ошибка загрузки проектов: ' + err.message +
        '\n\nПроверьте правила Firestore (см. комментарий в js/firebase.js).');
    }
    grid.innerHTML = '';

    const hasItems = projects.length > 0;
    empty.classList.toggle('hidden', hasItems);

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
      card.querySelector('.project-card__meta').textContent = formatDate(p.updatedAt);

      card.addEventListener('click', () => openProject(p));
      card.querySelector('.project-card__delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Удалить проект «${p.name}»?`)) {
          await window.Store.deleteProject(p.id);
          renderProjects();
        }
      });

      grid.appendChild(card);
    });
  }

  function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // --- Создание проекта ---

  async function createProjectFlow() {
    const name = prompt('Название проекта:', 'Новый проект');
    if (name === null) return;
    const project = await window.Store.createProject(name);
    await openProject(project);
  }

  // --- Инициализация ---

  function init() {
    window.Board.init({
      onSave: async (board) => {
        if (currentProject) await window.Store.saveBoard(currentProject.id, board);
      }
    });

    document.getElementById('btn-create-project').addEventListener('click', createProjectFlow);
    document.getElementById('btn-back').addEventListener('click', goToProjects);
    document.getElementById('btn-logout').addEventListener('click', () => window.Auth.signOut());

    document.getElementById('btn-google').addEventListener('click', async () => {
      loginError.classList.add('hidden');
      try {
        await window.Auth.signInWithGoogle();
      } catch (err) {
        loginError.textContent = 'Ошибка входа: ' + err.message;
        loginError.classList.remove('hidden');
      }
    });

    boardTitle.addEventListener('change', async () => {
      if (!currentProject) return;
      const name = boardTitle.value.trim() || 'Без названия';
      boardTitle.value = name;
      await window.Store.renameProject(currentProject.id, name);
      currentProject.name = name;
      document.title = name + ' — Miroz';
    });

    // Реакция на смену пользователя: показать вход или список проектов.
    window.Auth.onChange((user) => {
      if (user) {
        userBadge.textContent = user.displayName || user.email || 'Пользователь';
        userBadge.title = user.email || '';
        document.getElementById('btn-logout').classList.remove('hidden');
        goToProjects();
      } else {
        userBadge.textContent = 'Гость';
        userBadge.title = 'Не авторизован';
        document.getElementById('btn-logout').classList.add('hidden');
        showScreen('login');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
