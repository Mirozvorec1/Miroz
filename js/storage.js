// Слой данных.
//
// Сейчас — localStorage. Интерфейс специально сделан асинхронным,
// чтобы позже безболезненно подменить реализацию на Firebase.
//
// Пример подключения Firebase (когда дойдём до этого):
//   import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.x/firebase-app.js';
//   import { getFirestore, collection, getDocs, addDoc, doc, setDoc } from '.../firebase-firestore.js';
//   Затем переопределить методы Store (или создать FirestoreStore
//   с теми же методами и подставить его в window.Store).

window.__LocalStore = (function () {
  const KEY_PROJECTS = 'miroz.projects';
  const KEY_BOARD_PREFIX = 'miroz.board.';

  function readProjects() {
    try {
      return JSON.parse(localStorage.getItem(KEY_PROJECTS)) || [];
    } catch (e) {
      return [];
    }
  }

  function writeProjects(projects) {
    localStorage.setItem(KEY_PROJECTS, JSON.stringify(projects));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // --- Проекты ---

  async function listProjects() {
    return readProjects().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function createProject(name) {
    const now = Date.now();
    const project = {
      id: uid(),
      name: (name || 'Без названия').trim() || 'Без названия',
      createdAt: now,
      updatedAt: now,
      ownerId: window.APP_CONFIG.localUser.id
    };
    const projects = readProjects();
    projects.push(project);
    writeProjects(projects);
    return project;
  }

  async function renameProject(id, name) {
    const projects = readProjects();
    const p = projects.find(x => x.id === id);
    if (!p) return null;
    p.name = name;
    p.updatedAt = Date.now();
    writeProjects(projects);
    return p;
  }

  async function deleteProject(id) {
    writeProjects(readProjects().filter(x => x.id !== id));
    localStorage.removeItem(KEY_BOARD_PREFIX + id);
  }

  // --- Доска проекта ---

  async function getBoard(projectId) {
    try {
      const raw = localStorage.getItem(KEY_BOARD_PREFIX + projectId);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { projectId, nodes: [], view: { x: 0, y: 0, scale: 1 } };
  }

  async function saveBoard(projectId, board) {
    localStorage.setItem(KEY_BOARD_PREFIX + projectId, JSON.stringify(board));
    const projects = readProjects();
    const p = projects.find(x => x.id === projectId);
    if (p) {
      p.updatedAt = Date.now();
      writeProjects(projects);
    }
  }

  return {
    listProjects,
    createProject,
    renameProject,
    deleteProject,
    getBoard,
    saveBoard,
    uid
  };
})();

// Локальный режим по умолчанию. Если Firebase включён,
// js/firebase.js перезапишет window.Store на FirestoreStore.
window.Store = window.__LocalStore;
