// Пароли проектов.
//
// Пароль не хранится в базе в открытом виде: сохраняются только соль и хеш
// (PBKDF2-SHA-256 через Web Crypto, с запасным вариантом для file://).
//
// Внимание: это защита на уровне интерфейса. Правила Firestore разрешают
// чтение проекта любому вошедшему пользователю, поэтому настоящую защиту
// данных может дать только серверная проверка (Cloud Functions и т.п.).

window.Password = (function () {
  const ITERATIONS = 100000;

  function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function randomSalt() {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return toHex(bytes.buffer);
  }

  // Запасной вариант, если Web Crypto недоступен (например, file://).
  function fallbackHash(text) {
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let round = 0; round < 500; round++) {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
      }
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  async function hash(password, salt) {
    const pass = String(password == null ? '' : password);
    const sal = String(salt == null ? '' : salt);
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      try {
        const enc = new TextEncoder();
        const key = await window.crypto.subtle.importKey(
          'raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']
        );
        const bits = await window.crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: enc.encode(sal), iterations: ITERATIONS, hash: 'SHA-256' },
          key,
          256
        );
        return 'pbkdf2$' + toHex(bits);
      } catch (e) {
        console.warn('[password] Web Crypto недоступен, используется запасной хеш:', e && e.message);
      }
    }
    return 'fallback$' + fallbackHash(sal + ':' + pass);
  }

  function hasPassword(project) {
    return !!(project && project.passwordHash && project.passwordSalt);
  }

  // Возвращает { hash, salt } для сохранения в проекте.
  async function make(password) {
    const salt = randomSalt();
    return { salt, hash: await hash(password, salt) };
  }

  async function verify(project, password) {
    if (!hasPassword(project)) return true;
    const value = await hash(password, project.passwordSalt);
    return value === project.passwordHash;
  }

  // --- Диалог запроса пароля при открытии проекта ---

  function ask(project) {
    return new Promise(resolve => {
      let done = false;

      const overlay = document.createElement('div');
      overlay.className = 'modal modal--nested';
      overlay.innerHTML =
        '<div class="modal__backdrop" data-close="1"></div>' +
        '<div class="modal__card">' +
          '<h2 class="modal__title">Проект защищён паролем</h2>' +
          '<p class="field__hint" style="margin:0 0 14px">' +
            'Введите пароль проекта «' + escapeHtml(project.name || project.id) + '», чтобы открыть доску.' +
          '</p>' +
          '<div class="field">' +
            '<span class="field__label">Пароль</span>' +
            '<input class="field__input" type="password" data-role="pass" autocomplete="current-password" />' +
            '<label class="check"><input type="checkbox" data-role="show" /><span>Показать пароль</span></label>' +
          '</div>' +
          '<p class="field__error hidden" data-role="err"></p>' +
          '<div class="modal__actions">' +
            '<button class="btn btn--ghost" type="button" data-role="cancel">Отмена</button>' +
            '<button class="btn btn--primary" type="button" data-role="submit">Открыть</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);

      const input = overlay.querySelector('[data-role="pass"]');
      const show = overlay.querySelector('[data-role="show"]');
      const err = overlay.querySelector('[data-role="err"]');
      const submit = overlay.querySelector('[data-role="submit"]');
      const cancel = overlay.querySelector('[data-role="cancel"]');

      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') finish(false);
      }

      async function tryOpen() {
        const value = input.value;
        if (!value) { showError('Введите пароль'); return; }
        submit.disabled = true;
        try {
          if (await verify(project, value)) finish(true);
          else showError('Неверный пароль');
        } catch (e) {
          showError('Не удалось проверить пароль: ' + (e.message || e));
        } finally {
          submit.disabled = false;
        }
      }

      function showError(text) {
        err.textContent = text;
        err.classList.remove('hidden');
        input.focus();
        input.select();
      }

      show.addEventListener('change', () => {
        input.type = show.checked ? 'text' : 'password';
      });
      cancel.addEventListener('click', () => finish(false));
      overlay.querySelector('[data-close]').addEventListener('click', () => finish(false));
      submit.addEventListener('click', tryOpen);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); tryOpen(); }
      });
      document.addEventListener('keydown', onKey);
      setTimeout(() => input.focus(), 0);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { make, verify, hasPassword, ask, hash };
})();