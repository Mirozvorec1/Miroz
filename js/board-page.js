// Страница доски (board.html и сгенерированные <slug>.html).
// Определяет проект по window.PROJECT_ID (из файла) или ?id= из адреса.

(function () {
  const params = new URLSearchParams(location.search);
  const projectId = window.PROJECT_ID || params.get('id');
  const demoMode = params.get('demo') === '1';
  const titleInput = document.getElementById('board-title');
  const slugLabel = document.getElementById('board-slug');
  const settingsBtn = document.getElementById('btn-project-settings');
  let unsubProject = null;
  let currentProject = null;
  let currentIsOwner = false;

  function goHome(reason) {
    if (reason) alert(reason);
    location.replace('index.html' + (demoMode ? '?demo=1' : ''));
  }

  // Разблокировка проекта по паролю действует в пределах вкладки,
  // если в настройках проекта отключено «спрашивать при каждом входе».
  function unloadKey() { return 'miroz.unlocked.' + projectId; }

  function wantsEveryTime(project) {
    return !project || project.askPasswordEveryTime !== false;
  }

  function isUnlocked(project) {
    try { return sessionStorage.getItem(unloadKey()) === project.passwordHash; }
    catch (e) { return false; }
  }

  function rememberUnlocked(project) {
    try { sessionStorage.setItem(unloadKey(), project.passwordHash); } catch (e) { /* ignore */ }
  }

  async function ensurePassword(project) {
    if (!window.Password || !window.Password.hasPassword(project)) return true;

    // Одноразовый пропуск после ввода пароля в меню — не спрашиваем дважды.
    if (window.Password.takeOnce(project)) return true;

    if (wantsEveryTime(project)) {
      try { sessionStorage.removeItem(unloadKey()); } catch (e) { /* ignore */ }
    } else if (isUnlocked(project)) {
      return true;
    }

    const ok = await window.Password.ask(project);
    if (ok && !wantsEveryTime(project)) rememberUnlocked(project);
    return ok;
  }

  function openProjectSettings() {
    if (!currentProject || !window.ProjectSettings) return;
    if (!currentIsOwner) return;
    window.ProjectSettings.open(currentProject, {
      onSaved: (p) => {
        currentProject = p;
        if (titleInput) titleInput.value = p.name;
        document.title = p.name + ' — Miroz';
        window.Board.setDefaults(p);
        if (window.Settings) window.Settings.updateProject(p);
      },
      onDeleted: () => goHome()
    });
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
    const menuSettingsBtn = document.getElementById('menu-settings');
    if (menuSettingsBtn && window.Settings) {
      menuSettingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) menu.classList.add('hidden');
        window.Settings.openPopup({ anchor: menuBtn, projectId, project: currentProject });
      });
    }

    // Карандаш рядом с названием — та же плашка, что и в списке проектов.
    if (settingsBtn) settingsBtn.addEventListener('click', openProjectSettings);

    if (titleInput) {
      titleInput.addEventListener('change', async () => {
        if (!currentIsOwner) {
          titleInput.value = currentProject ? currentProject.name : titleInput.value;
          return;
        }
        const name = titleInput.value.trim() || projectId;
        titleInput.value = name;
        try {
          await window.Store.renameProject(projectId, name);
          if (currentProject) currentProject.name = name;
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

      currentProject = project;
      currentIsOwner = !window.ProjectAccess || window.ProjectAccess.isOwner(project);

      // Настройки и переименование — только для создателя проекта.
      if (settingsBtn) settingsBtn.classList.toggle('hidden', !currentIsOwner);
      if (titleInput) {
        titleInput.readOnly = !currentIsOwner;
        titleInput.title = currentIsOwner ? '' : 'Переименовать проект может только создатель';
      }

      if (titleInput) titleInput.value = project.name;
      if (slugLabel) slugLabel.textContent = '#' + projectId;
      document.title = project.name + ' — Miroz';

      // Проект с паролем не открываем без проверки.
      if (!(await ensurePassword(project))) { goHome(); return; }

      // Общие настройки проекта (шрифт/размер по умолчанию) — применяем и следим.
      window.Board.setDefaults(project);
      if (window.Settings) {
        window.Settings.bindProject(projectId, project, (p) => window.Board.setDefaults(p));
      }
      if (unsubProject) unsubProject();
      if (window.Store.subscribeProject) {
        unsubProject = window.Store.subscribeProject(projectId, (p) => {
          currentProject = Object.assign({}, currentProject, p);
          window.Board.setDefaults(p);
          if (window.Settings) window.Settings.updateProject(p);
        });
      }

      await window.Board.load(projectId);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();