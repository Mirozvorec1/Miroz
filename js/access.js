// Права на настройки проекта.
//
// Создатель определяется по метаданным документа проекта — полю ownerId.
// Настройки (название, обложка, пароль, удаление, общие шрифты) может менять
// только владелец. Участники могут открывать доску и работать с элементами.
//
// Старые проекты без ownerId считаем доступными, иначе их нельзя было бы
// настроить; всё, что создаёт приложение, ownerId содержит.

window.ProjectAccess = (function () {
  function currentUserId() {
    if (window.currentUser && window.currentUser.uid) return window.currentUser.uid;
    if (window.APP_CONFIG && window.APP_CONFIG.localUser) {
      return window.APP_CONFIG.localUser.id;
    }
    return null;
  }

  function isOwner(project) {
    if (!project) return false;
    if (!project.ownerId) return !!project.id; // легаси-проекты без метаданных
    return project.ownerId === currentUserId();
  }

  return { isOwner, currentUserId };
})();
