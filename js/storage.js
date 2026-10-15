// Слой данных (локальный режим, localStorage).
//
// Интерфейс асинхронный и совпадает с FirestoreStore из js/firebase.js,
// поэтому при включённом Firebase window.Store переключается без правок UI.
//
// Каждый элемент доски — отдельная запись (узел), как и в Firestore:
// это позволяет синхронизировать изменения по одному элементу.

window.__LocalStore = (function () {
  const KEY_PROJECTS = 'miroz.projects';
  const KEY_NODES = 'miroz.nodes.';
  const KEY_VIEW = 'miroz.view.';

  const DEFAULT_VIEW = () => ({ x: 0, y: 0, scale: 1 });

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (e) { return fallback; }
  }
  function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // --- Проекты ---

  async function listProjects() {
    return read(KEY_PROJECTS, []).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function touchProject(id) {
    const projects = read(KEY_PROJECTS, []);
    const p = projects.find(x => x.id === id);
    if (p) { p.updatedAt = Date.now(); write(KEY_PROJECTS, projects); }
  }

  async function createProject(name) {
    const now = Date.now();
    const project = {
      id: uid(),
      name: (name || 'Без названия').trim() || 'Без названия',
      ownerId: window.APP_CONFIG.localUser.id,
      ownerName: window.APP_CONFIG.localUser.name,
      members: [],
      createdAt: now,
      updatedAt: now
    };
    const projects = read(KEY_PROJECTS, []);
    projects.push(project);
    write(KEY_PROJECTS, projects);
    return project;
  }

  async function renameProject(id, name) {
    const projects = read(KEY_PROJECTS, []);
    const p = projects.find(x => x.id === id);
    if (p) { p.name = name; p.updatedAt = Date.now(); write(KEY_PROJECTS, projects); }
    return p;
  }

  async function deleteProject(id) {
    write(KEY_PROJECTS, read(KEY_PROJECTS, []).filter(x => x.id !== id));
    localStorage.removeItem(KEY_NODES + id);
    localStorage.removeItem(KEY_VIEW + id);
  }

  // --- Узлы доски ---

  async function getNodes(projectId) {
    return read(KEY_NODES + projectId, []);
  }

  async function addNode(projectId, node) {
    const nodes = read(KEY_NODES + projectId, []);
    nodes.push(node);
    write(KEY_NODES + projectId, nodes);
    touchProject(projectId);
  }

  async function updateNode(projectId, nodeId, patch) {
    const nodes = read(KEY_NODES + projectId, []);
    const n = nodes.find(x => x.id === nodeId);
    if (n) { Object.assign(n, patch); write(KEY_NODES + projectId, nodes); touchProject(projectId); }
  }

  async function removeNode(projectId, nodeId) {
    write(KEY_NODES + projectId, read(KEY_NODES + projectId, []).filter(x => x.id !== nodeId));
    touchProject(projectId);
  }

  // Локально realtime нет — подписка ничего не делает.
  function subscribeNodes() { return function unsubscribe() {}; }

  // --- Вид доски (персональный для каждого пользователя) ---

  async function getView(projectId) {
    return read(KEY_VIEW + projectId, DEFAULT_VIEW());
  }

  async function saveView(projectId, view) {
    write(KEY_VIEW + projectId, view);
  }

  return {
    listProjects,
    createProject,
    renameProject,
    deleteProject,
    getNodes,
    addNode,
    updateNode,
    removeNode,
    subscribeNodes,
    getView,
    saveView,
    uid
  };
})();

// Локальный режим по умолчанию. js/firebase.js перезапишет window.Store,
// если Firebase включён в config.js.
window.Store = window.__LocalStore;
