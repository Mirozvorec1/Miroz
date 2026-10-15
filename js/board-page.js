// Страница доски (board.html и сгенерированные <slug>.html).
// Определяет проект по window.PROJECT_ID (из файла) или ?id= из адреса.

(function () {
  const projectId = window.PROJECT_ID || new URLSearchParams(location.search).get('id');
  const titleInput = document.getElementById('board-title');
  const slugLabel = document.getElementById('board-slug');

  function goHome(reason) {
    if (reason) alert(reason);
    location.replace('index.html');
  }

  function init() {
    if (!projectId) { goHome(); return; }

    window.Board.init();

    // Выпадающее меню (☰) с пунктом "В меню".
    const menuBtn = document.getElementById('btn-menu');
    const menu = document.getElementById('board-menu');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'));

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

      titleInput.value = project.name;
      slugLabel.textContent = '#' + projectId;
      document.title = project.name + ' — Miroz';

      await window.Board.load(projectId);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
