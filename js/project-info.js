// Окно «Информация о проекте»: всё, что не нужно держать на карточке.
// Открывается по кнопке «i» в списке проектов.

window.ProjectInfo = (function () {
  let overlay = null;
  let els = {};

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.id = 'project-info-modal';
    overlay.innerHTML =
      '<div class="modal__backdrop" data-role="backdrop"></div>' +
      '<div class="modal__card modal__card--info">' +
        '<h2 class="modal__title">Информация о проекте</h2>' +

        '<div class="cover-preview info-cover">' +
          '<span data-role="cover-empty">Нет обложки</span>' +
          '<img data-role="cover-img" class="hidden" alt="" />' +
        '</div>' +

        '<dl class="info-list">' +
          '<div class="info-row"><dt>Название</dt><dd data-role="name"></dd></div>' +
          '<div class="info-row"><dt>ID проекта</dt><dd><code data-role="id"></code></dd></div>' +
          '<div class="info-row"><dt>Дата создания</dt><dd data-role="created"></dd></div>' +
          '<div class="info-row"><dt>Создатель</dt><dd data-role="owner"></dd></div>' +
          '<div class="info-row"><dt>Доступ</dt><dd data-role="privacy"></dd></div>' +
          '<div class="info-row"><dt>Последняя правка</dt><dd data-role="updated"></dd></div>' +
          '<div class="info-row"><dt>Последнюю правку сделал</dt><dd data-role="updated-by"></dd></div>' +
        '</dl>' +
        '<p class="field__hint info-hint">Время указано по настройкам вашего устройства.</p>' +

        '<div class="modal__actions">' +
          '<button type="button" class="btn btn--primary" data-role="close">Закрыть</button>' +
        '</div>' +
      '</div>';

    els = {
      backdrop: overlay.querySelector('[data-role="backdrop"]'),
      close: overlay.querySelector('[data-role="close"]'),
      coverBox: overlay.querySelector('.info-cover'),
      coverImg: overlay.querySelector('[data-role="cover-img"]'),
      coverEmpty: overlay.querySelector('[data-role="cover-empty"]'),
      name: overlay.querySelector('[data-role="name"]'),
      id: overlay.querySelector('[data-role="id"]'),
      created: overlay.querySelector('[data-role="created"]'),
      owner: overlay.querySelector('[data-role="owner"]'),
      privacy: overlay.querySelector('[data-role="privacy"]'),
      updated: overlay.querySelector('[data-role="updated"]'),
      updatedBy: overlay.querySelector('[data-role="updated-by"]')
    };

    els.backdrop.addEventListener('click', close);
    els.close.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  function dateOnly(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  // Дата + часы и минуты в локальном времени устройства пользователя.
  function dateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return dateOnly(ts) + ', ' + d.toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit'
    });
  }

  function isPrivate(project) {
    return (window.Password && window.Password.hasPassword(project)) || !!project.hasPassword;
  }

  function populate(project) {
    els.name.textContent = project.name || project.id || '—';
    els.id.textContent = project.id || '—';
    els.created.textContent = dateOnly(project.createdAt);
    els.owner.textContent = project.ownerName || project.ownerId || '—';
    els.privacy.textContent = isPrivate(project) ? '🔒 Приватный (по паролю)' : 'Публичный';
    els.updated.textContent = dateTime(project.updatedAt);
    els.updatedBy.textContent = project.updatedBy || '—';

    const cover = project.cover ? String(project.cover).trim() : '';
    if (cover) {
      els.coverBox.style.backgroundColor = '';
      els.coverBox.style.backgroundImage = '';
      els.coverBox.removeAttribute('title');
      els.coverImg.src = cover;
      els.coverImg.classList.remove('hidden');
      els.coverEmpty.classList.add('hidden');
    } else {
      // Обложки нет — показываем ровный цвет, закреплённый за проектом.
      els.coverBox.style.backgroundColor = window.ProjectCover
        ? window.ProjectCover.colorFor(project) : '';
      // Иначе CSS-градиент перекроет цвет и блок останется серым.
      els.coverBox.style.backgroundImage = 'none';
      els.coverBox.title = 'Обложка не задана — показан цвет проекта';
      els.coverImg.removeAttribute('src');
      els.coverImg.classList.add('hidden');
      els.coverEmpty.classList.add('hidden');
    }
  }

  function open(project) {
    if (!project) return false;
    close();
    build();
    populate(project);
    document.body.appendChild(overlay);
    setTimeout(() => els.close.focus(), 0);
    return true;
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKeyDown);
    els = {};
  }

  return { open, close };
})();
