// Страница доски (board.html и сгенерированные <slug>.html).
// Определяет проект по window.PROJECT_ID (из файла) или ?id= из адреса.

(function () {
  const projectId = window.PROJECT_ID || new URLSearchParams(location.search).get('id');
  const titleInput = document.getElementById('board-title');
  const slugLabel = document.getElementById('board-slug');
  let unsubProject = null;

  function goHome(reason) {
    if (reason) alert(reason);
    location.replace('index.html');
  }

  function init() {
    if (!projectId) { goHome(); return; }

    window.Board.init();
    if (window.ContextMenu && window.ContextMenu.init) window.ContextMenu.init();

    // Выпадающее меню (☰) с пунктом "В меню".
    const menuBtn = document.getElementById('btn-menu');
    const menu = document.getElementById('board-menu');
    if (menuBtn && menu) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
      });
      document.addEventListener('click', () => menu.classList.add('hidden'));
    }

    // Пункт "Настройки" открывает попап (локальные + общие настройки проекта).
    const settingsBtn = document.getElementById('menu-settings');
    if (settingsBtn && window.Settings) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) menu.classList.add('hidden');
        window.Settings.openPopup({ anchor: menuBtn, projectId });
      });
    }

    if (titleInput) {
      titleInput.addEventListener('change', async () => {
        const name = titleInput.value.trim() || projectId;
        titleInput.value = name;
        try {
          await window.Store.renameProject(projectId, name);
          document.title = name + ' — Miroz';
        } catch (err) {
          alert('Не удалось переименовать: ' + err.message);
        }
      });
    }

    window.Auth.onChange(async (user) => {
      if (!user) { goHome(); return; }

      let project;
      try {
        project = await window.Store.getProject(projectId);
      } catch (err) {
        goHome('Ошибка загрузки проекта: ' + err.message);
        return;
      }
      if (!project) { goHome('Проект «' + projectId + '» не найден'); return; }

      if (titleInput) titleInput.value = project.name;
      if (slugLabel) slugLabel.textContent = '#' + projectId;
      document.title = project.name + ' — Miroz';

      // Общие настройки проекта (шрифт/размер по умолчанию) — применяем и следим.
      window.Board.setDefaults(project);
      if (window.Settings) {
        window.Settings.bindProject(projectId, project, (p) => window.Board.setDefaults(p));
      }
      if (unsubProject) unsubProject();
      if (window.Store.subscribeProject) {
        unsubProject = window.Store.subscribeProject(projectId, (p) => {
          window.Board.setDefaults(p);
          if (window.Settings) window.Settings.updateProject(p);
        });
      }

      await window.Board.load(projectId);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
