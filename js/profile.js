// Страница профиля: почта, никнейм и аватар.
//
// Аватар выбирается файлом с устройства и сжимается в data URL — тем же
// способом, что и картинки на доске. Хранится в users/{uid}.avatar
// (Firestore) или в localStorage (локальный/демо-режим).

(function () {
  const nameInput = document.getElementById('profile-name');
  const emailInput = document.getElementById('profile-email');
  const avatarImg = document.getElementById('profile-avatar');
  const avatarInitial = document.getElementById('profile-initial');
  const avatarBox = document.getElementById('profile-avatar-box');
  const pickBtn = document.getElementById('btn-avatar-pick');
  const removeBtn = document.getElementById('btn-avatar-remove');
  const statusEl = document.getElementById('profile-status');
  const backLink = document.getElementById('profile-back');

  let user = null;
  let avatarData = '';
  let busy = false;
  let statusTimer = null;

  function uidOf(u) {
    return (u && (u.uid || u.id)) || '';
  }

  function displayName() {
    return (user && (user.displayName || user.email)) || 'Пользователь';
  }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('profile__status--error', !!isError);
    statusEl.classList.remove('hidden');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.add('hidden'), 3500);
  }

  function renderAvatar() {
    // Своя загруженная картинка важнее; если её нет — аватар из аккаунта
    // (photoURL Google, тот же, что виден в почте).
    const src = avatarData || (user && user.photoURL) || '';
    if (src) {
      avatarImg.src = src;
      avatarImg.classList.remove('hidden');
      avatarInitial.classList.add('hidden');
    } else {
      avatarImg.removeAttribute('src');
      avatarImg.classList.add('hidden');
      avatarInitial.classList.remove('hidden');
    }
    // Удалять можно только загруженное фото, не аватар по умолчанию.
    removeBtn.classList.toggle('hidden', !avatarData);
  }

  function renderUser() {
    const name = displayName();
    nameInput.value = name;
    emailInput.value = (user && user.email) || 'Не указана';
    avatarInitial.textContent = name.trim().charAt(0).toUpperCase() || '?';
    renderAvatar();
  }

  async function loadProfile() {
    const uid = uidOf(user);
    if (!uid || !window.Store || !window.Store.getProfile) return;
    try {
      const profile = await window.Store.getProfile(uid);
      avatarData = (profile && profile.avatar) || '';
      renderAvatar();
    } catch (err) {
      console.warn('[profile] не удалось загрузить профиль:', err);
    }
  }

  async function persistAvatar(value) {
    const uid = uidOf(user);
    if (!uid) return;
    if (!window.Store || !window.Store.saveProfile) {
      throw new Error('хранилище профиля недоступно');
    }
    await window.Store.saveProfile(uid, { avatar: value });
    avatarData = value;
    renderAvatar();
    showStatus(value ? 'Фото обновлено' : 'Фото удалено');
  }

  async function pickAvatar() {
    if (busy) return;
    if (!window.Images) {
      showStatus('Не удалось загрузить модуль изображений', true);
      return;
    }

    const file = await window.Images.pickFile();
    if (!file) return;

    busy = true;
    pickBtn.disabled = true;
    removeBtn.disabled = true;
    const oldText = pickBtn.textContent;
    pickBtn.textContent = 'Обработка…';
    try {
      const prepared = await window.Images.prepare(file, {
        maxSide: 320,
        budget: 150000,
        square: true
      });
      await persistAvatar(prepared.dataUrl);
    } catch (err) {
      console.error('[profile]', err);
      showStatus('Не удалось загрузить фото: ' + (err.message || err), true);
    } finally {
      busy = false;
      pickBtn.disabled = false;
      removeBtn.disabled = false;
      pickBtn.textContent = oldText;
    }
  }

  async function removeAvatar() {
    if (busy || !avatarData) return;
    busy = true;
    pickBtn.disabled = true;
    removeBtn.disabled = true;
    try {
      await persistAvatar('');
    } catch (err) {
      console.error('[profile]', err);
      showStatus('Не удалось удалить фото: ' + (err.message || err), true);
    } finally {
      busy = false;
      pickBtn.disabled = false;
      removeBtn.disabled = false;
    }
  }

  function init() {
    if (window.__DEMO_MODE__) backLink.href = 'index.html?demo=1';

    pickBtn.addEventListener('click', pickAvatar);
    avatarBox.addEventListener('click', pickAvatar);
    removeBtn.addEventListener('click', removeAvatar);
    document.getElementById('btn-logout').addEventListener('click', () => window.Auth.signOut());

    window.Auth.onChange(u => {
      if (!u) {
        location.href = 'index.html' + (window.__DEMO_MODE__ ? '?demo=1' : '');
        return;
      }
      user = u;
      renderUser();
      loadProfile();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
