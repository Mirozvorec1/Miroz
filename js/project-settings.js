// Общая плашка «Настройки проекта».
//
// Используется и на странице списка проектов (index.html), и на доске
// (board.html — кнопка с карандашом возле названия). Разметка создаётся
// динамически, чтобы не дублировать её в двух html-файлах.
//
// ProjectSettings.open(project, {
//   onSaved(project)   — после сохранения названия/обложки,
//   onDeleted(id)      — после удаления проекта
// })

window.ProjectSettings = (function () {
  let overlay = null;
  let passOverlay = null;
  let project = null;
  let opts = {};
  let els = {};

  function hasPassword() {
    return window.Password && window.Password.hasPassword(project);
  }

  function coverUrl(p) {
    return p && p.cover ? String(p.cover).trim() : '';
  }

  // После установки/смены пароля уводим в меню проектов и сразу показываем
  // плашку ввода пароля (index.html?unlock=<id>).
  function goToUnlock(id) {
    const demo = window.__DEMO_MODE__ ? '&demo=1' : '';
    location.href = 'index.html?unlock=' + encodeURIComponent(id) + demo;
  }

  function open(p, options) {
    if (!p) return false;
    // Менять настройки проекта может только его создатель (ownerId).
    if (window.ProjectAccess && !window.ProjectAccess.isOwner(p)) return false;
    close();
    project = p;
    opts = options || {};
    build();
    populate();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    setTimeout(() => els.name.focus(), 0);
    return true;
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.id = 'project-settings-modal';
    overlay.innerHTML =
      '<div class="modal__backdrop" data-role="backdrop"></div>' +
      '<div class="modal__card">' +
        '<h2 class="modal__title">Настройки проекта</h2>' +

        '<div class="field">' +
          '<span class="field__label">Обложка <em>— ссылка на картинку</em></span>' +
          '<div class="cover-preview">' +
            '<span data-role="cover-empty">Нет обложки</span>' +
            '<img data-role="cover-img" class="hidden" alt="" />' +
          '</div>' +
          '<input data-role="cover" class="field__input" placeholder="https://…" autocomplete="off" spellcheck="false" />' +
        '</div>' +

        '<label class="field">' +
          '<span class="field__label">Название</span>' +
          '<input data-role="name" class="field__input" autocomplete="off" />' +
        '</label>' +

        '<label class="field">' +
          '<span class="field__label">ID <em>— изменить нельзя</em></span>' +
          '<input data-role="id" class="field__input" readonly />' +
          '<span class="field__hint">Адрес доски: <code data-role="url"></code></span>' +
        '</label>' +

        '<label class="field">' +
          '<span class="field__label">Создатель проекта</span>' +
          '<input data-role="owner" class="field__input" readonly />' +
          '<span class="field__hint">Менять настройки проекта может только его создатель.</span>' +
        '</label>' +

        '<div class="field">' +
          '<span class="field__label">Пароль</span>' +
          '<div class="ps-password">' +
            '<span class="ps-password__state" data-role="pass-state"></span>' +
            '<span class="ps-password__actions">' +
              '<button type="button" class="btn ps-password__btn" data-role="change-pass">Изменить пароль</button>' +
              '<button type="button" class="btn ps-password__btn ps-password__btn--remove hidden" data-role="remove-pass">Удалить пароль</button>' +
            '</span>' +
          '</div>' +
          '<label class="check hidden" data-role="ask-wrap">' +
            '<input type="checkbox" data-role="ask-every-time" />' +
            '<span>Спрашивать пароль при каждом входе</span>' +
          '</label>' +
        '</div>' +

        '<p class="field__error hidden" data-role="error"></p>' +

        '<div class="modal__actions modal__actions--spread">' +
          '<button type="button" class="btn btn--danger" data-role="delete">Удалить проект</button>' +
          '<span>' +
            '<button type="button" class="btn btn--ghost" data-role="cancel">Отмена</button>' +
            '<button type="button" class="btn btn--primary" data-role="save">Сохранить</button>' +
          '</span>' +
        '</div>' +

        '<div class="danger hidden" data-role="confirm">' +
          '<p class="danger__text">' +
            'Удаление необратимо. Введите ID проекта <code data-role="confirm-id"></code>, ' +
            'чтобы подтвердить.' +
          '</p>' +
          '<input data-role="confirm-input" class="field__input" placeholder="введите ID" autocomplete="off" spellcheck="false" />' +
          '<div class="modal__actions">' +
            '<button type="button" class="btn btn--ghost" data-role="confirm-cancel">Отмена</button>' +
            '<button type="button" class="btn btn--danger" data-role="confirm-delete" disabled>Удалить навсегда</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    els = {
      backdrop: overlay.querySelector('[data-role="backdrop"]'),
      cover: overlay.querySelector('[data-role="cover"]'),
      coverImg: overlay.querySelector('[data-role="cover-img"]'),
      coverEmpty: overlay.querySelector('[data-role="cover-empty"]'),
      name: overlay.querySelector('[data-role="name"]'),
      id: overlay.querySelector('[data-role="id"]'),
      url: overlay.querySelector('[data-role="url"]'),
      owner: overlay.querySelector('[data-role="owner"]'),
      passState: overlay.querySelector('[data-role="pass-state"]'),
      changePass: overlay.querySelector('[data-role="change-pass"]'),
      removePass: overlay.querySelector('[data-role="remove-pass"]'),
      askWrap: overlay.querySelector('[data-role="ask-wrap"]'),
      askEveryTime: overlay.querySelector('[data-role="ask-every-time"]'),
      error: overlay.querySelector('[data-role="error"]'),
      deleteBtn: overlay.querySelector('[data-role="delete"]'),
      cancel: overlay.querySelector('[data-role="cancel"]'),
      save: overlay.querySelector('[data-role="save"]'),
      confirm: overlay.querySelector('[data-role="confirm"]'),
      confirmId: overlay.querySelector('[data-role="confirm-id"]'),
      confirmInput: overlay.querySelector('[data-role="confirm-input"]'),
      confirmCancel: overlay.querySelector('[data-role="confirm-cancel"]'),
      confirmDelete: overlay.querySelector('[data-role="confirm-delete"]')
    };

    els.backdrop.addEventListener('click', close);
    els.cancel.addEventListener('click', close);
    els.save.addEventListener('click', save);
    els.changePass.addEventListener('click', () =>
      openPasswordPopup(hasPassword() ? 'change' : 'set'));
    els.removePass.addEventListener('click', () => openPasswordPopup('remove'));
    els.askEveryTime.addEventListener('change', toggleAskEveryTime);
    els.deleteBtn.addEventListener('click', showDeleteConfirm);
    els.confirmCancel.addEventListener('click', hideDeleteConfirm);
    els.confirmInput.addEventListener('input', updateDeleteConfirm);
    els.confirmDelete.addEventListener('click', confirmDelete);
    els.cover.addEventListener('input', updateCoverPreview);
    els.coverImg.addEventListener('error', () => {
      els.coverImg.classList.add('hidden');
      els.coverEmpty.classList.remove('hidden');
    });
    els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  function populate() {
    hideError();
    hideDeleteConfirm();
    els.id.value = project.id;
    els.url.textContent = '/' + project.id + '.html';
    els.owner.value = project.ownerName || project.ownerId || '—';
    els.name.value = project.name || '';
    els.cover.value = coverUrl(project);
    refreshPasswordState();
    updateCoverPreview();
  }

  function refreshPasswordState() {
    if (!els.passState) return;
    const has = hasPassword();
    if (has) {
      els.passState.innerHTML = '<b>Установлен</b> · проект открывается по паролю';
      els.changePass.textContent = 'Изменить пароль';
      els.removePass.classList.remove('hidden');
    } else {
      els.passState.innerHTML = '<b>Не задан</b> · проект открывается без пароля';
      els.changePass.textContent = 'Установить пароль';
      els.removePass.classList.add('hidden');
    }
    els.askWrap.classList.toggle('hidden', !has);
    els.askEveryTime.checked = project.askPasswordEveryTime !== false;
  }

  // Настройка «спрашивать пароль при каждом входе» сохраняется сразу.
  async function toggleAskEveryTime() {
    const value = els.askEveryTime.checked;
    try {
      await window.Store.updateProject(project.id, { askPasswordEveryTime: value });
      project.askPasswordEveryTime = value;
      if (value) {
        // Старый пропуск вкладки больше не действует.
        try { sessionStorage.removeItem('miroz.unlocked.' + project.id); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.error(err);
      els.askEveryTime.checked = !value;
      showError('Не удалось сохранить настройку: ' + err.message);
    }
  }

  function updateCoverPreview() {
    const url = els.cover.value.trim();
    if (url) {
      els.coverImg.src = url;
      els.coverImg.classList.remove('hidden');
      els.coverEmpty.classList.add('hidden');
    } else {
      els.coverImg.classList.add('hidden');
      els.coverImg.removeAttribute('src');
      els.coverEmpty.classList.remove('hidden');
    }
  }

  function showError(text) {
    els.error.textContent = text;
    els.error.classList.remove('hidden');
  }

  function hideError() {
    els.error.textContent = '';
    els.error.classList.add('hidden');
  }

  async function save() {
    hideError();
    const name = els.name.value.trim() || project.id;
    const cover = els.cover.value.trim();
    els.save.disabled = true;
    try {
      await window.Store.updateProject(project.id, { name, cover });
      project.name = name;
      project.cover = cover;
      const saved = project;
      const cb = opts.onSaved;
      close();
      if (cb) cb(saved);
    } catch (err) {
      console.error(err);
      showError('Не удалось сохранить: ' + err.message);
    } finally {
      els.save.disabled = false;
    }
  }

  // --- Удаление ---

  function showDeleteConfirm() {
    els.confirmId.textContent = project.id;
    els.confirmInput.value = '';
    els.confirmDelete.disabled = true;
    els.confirm.classList.remove('hidden');
    els.confirmInput.focus();
  }

  function hideDeleteConfirm() {
    els.confirm.classList.add('hidden');
    els.confirmInput.value = '';
    els.confirmDelete.disabled = true;
  }

  function updateDeleteConfirm() {
    els.confirmDelete.disabled = els.confirmInput.value.trim() !== project.id;
  }

  async function confirmDelete() {
    if (els.confirmInput.value.trim() !== project.id) return;
    els.confirmDelete.disabled = true;
    hideError();
    try {
      const id = project.id;
      const cb = opts.onDeleted;
      await window.Store.deleteProject(id);
      close();
      if (cb) cb(id);
    } catch (err) {
      console.error(err);
      showError('Не удалось удалить проект: ' + err.message);
      els.confirmDelete.disabled = false;
    }
  }

  // --- Установка, смена и удаление пароля ---

  // mode: 'set' | 'change' | 'remove'
  function openPasswordPopup(mode) {
    if (passOverlay) return;
    const isRemove = mode === 'remove';
    const withCurrent = mode !== 'set';
    if (isRemove && !hasPassword()) return;
    hideError();

    const title = isRemove ? 'Удаление пароля'
      : (mode === 'set' ? 'Установка пароля' : 'Изменение пароля');

    passOverlay = document.createElement('div');
    passOverlay.className = 'modal modal--nested';
    passOverlay.innerHTML =
      '<div class="modal__backdrop" data-role="pass-backdrop"></div>' +
      '<div class="modal__card">' +
        '<h2 class="modal__title">' + title + '</h2>' +

        (isRemove
          ? '<p class="field__hint" style="margin:0 0 14px">' +
              'Проект снова будет открываться без пароля. ' +
              'Введите текущий пароль, чтобы подтвердить удаление.' +
            '</p>'
          : '') +

        (withCurrent
          ? '<label class="field">' +
              '<span class="field__label">Текущий пароль</span>' +
              '<input class="field__input" type="password" data-role="current-pass" autocomplete="current-password" />' +
            '</label>'
          : '') +

        (isRemove
          ? ''
          : '<div class="field">' +
              '<span class="field__label">Новый пароль</span>' +
              '<input class="field__input" type="password" data-role="new-pass" autocomplete="new-password" />' +
            '</div>') +

        '<label class="check"><input type="checkbox" data-role="show-pass" /><span>Показать пароль</span></label>' +

        '<p class="field__error hidden" data-role="pass-error"></p>' +
        '<div class="modal__actions">' +
          '<button type="button" class="btn btn--ghost" data-role="pass-cancel">Отмена</button>' +
          '<button type="button" class="btn ' + (isRemove ? 'btn--danger' : 'btn--primary') + '" data-role="pass-save">' +
            (isRemove ? 'Удалить пароль' : 'Сохранить') +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(passOverlay);

    const backdrop = passOverlay.querySelector('[data-role="pass-backdrop"]');
    const current = passOverlay.querySelector('[data-role="current-pass"]');
    const next = passOverlay.querySelector('[data-role="new-pass"]');
    const show = passOverlay.querySelector('[data-role="show-pass"]');
    const err = passOverlay.querySelector('[data-role="pass-error"]');
    const cancel = passOverlay.querySelector('[data-role="pass-cancel"]');
    const saveBtn = passOverlay.querySelector('[data-role="pass-save"]');

    function closePass() {
      if (!passOverlay) return;
      document.removeEventListener('keydown', onPassKey, true);
      passOverlay.remove();
      passOverlay = null;
    }

    function onPassKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      document.removeEventListener('keydown', onPassKey, true);
      if (passOverlay) { passOverlay.remove(); passOverlay = null; }
    }

    function passError(text) {
      err.textContent = text;
      err.classList.remove('hidden');
    }

    show.addEventListener('change', () => {
      const type = show.checked ? 'text' : 'password';
      if (current) current.type = type;
      if (next) next.type = type;
    });
    backdrop.addEventListener('click', closePass);
    cancel.addEventListener('click', closePass);
    document.addEventListener('keydown', onPassKey, true);

    // Проверка текущего пароля (для смены и удаления).
    async function checkCurrent() {
      const currentPass = current.value;
      if (!currentPass) { passError('Введите текущий пароль'); current.focus(); return false; }
      const ok = await window.Password.verify(project, currentPass);
      if (!ok) { passError('Текущий пароль неверный'); current.focus(); current.select(); return false; }
      return true;
    }

    async function removePassword() {
      err.classList.add('hidden');
      const currentPass = current.value;
      if (!currentPass) { passError('Введите текущий пароль'); current.focus(); return; }

      saveBtn.disabled = true;
      try {
        if (!(await checkCurrent())) return;
        await window.Store.updateProject(project.id, {
          passwordHash: '',
          passwordSalt: '',
          hasPassword: false
        });
        project.passwordHash = '';
        project.passwordSalt = '';
        project.hasPassword = false;
        // Сбрасываем разблокировку текущей вкладки — пароль больше не нужен.
        try { sessionStorage.removeItem('miroz.unlocked.' + project.id); } catch (e) { /* ignore */ }
        closePass();
        refreshPasswordState();
      } catch (e) {
        console.error('[password]', e);
        passError('Не удалось удалить пароль: ' + (e.message || e));
      } finally {
        saveBtn.disabled = false;
      }
    }

    async function applyPassword() {
      err.classList.add('hidden');
      const newPass = next.value;
      if (!newPass) { passError('Введите новый пароль'); next.focus(); return; }

      saveBtn.disabled = true;
      try {
        if (withCurrent && !(await checkCurrent())) return;

        const made = await window.Password.make(newPass);
        await window.Store.updateProject(project.id, {
          passwordHash: made.hash,
          passwordSalt: made.salt,
          hasPassword: true
        });
        project.passwordHash = made.hash;
        project.passwordSalt = made.salt;
        project.hasPassword = true;
        // Пароль установлен/изменён — по требованию показываем его ввод заново:
        // переходим в меню и открываем плашку разблокировки.
        try { sessionStorage.removeItem('miroz.unlocked.' + project.id); } catch (e) { /* ignore */ }
        closePass();
        goToUnlock(project.id);
      } catch (e) {
        console.error('[password]', e);
        passError('Не удалось изменить пароль: ' + (e.message || e));
      } finally {
        saveBtn.disabled = false;
      }
    }

    const submit = isRemove ? removePassword : applyPassword;
    saveBtn.addEventListener('click', submit);
    [current, next].forEach(inp => {
      if (!inp) return;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    });
    setTimeout(() => (current || next).focus(), 0);
  }

  // --- Закрытие ---

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (passOverlay) return; // его закрывает собственный обработчик/кнопка
    close();
  }

  function close() {
    if (passOverlay) { passOverlay.remove(); passOverlay = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKeyDown);
    if (opts.onClose) {
      const cb = opts.onClose;
      opts = {};
      cb();
    } else {
      opts = {};
    }
    project = null;
  }

  return { open, close };
})();