// Подключение Firebase: Auth (Google) + Firestore с realtime-синхронизацией.
// Работает поверх compat-SDK, подключённого в index.html до этого файла.
//
// Модель данных:
//   projects/{pid}                 → name, ownerName, members, createdAt, updatedAt
//   projects/{pid}/nodes/{nodeId}  → type, x, y, text, createdBy, updatedAt
//   вид доски (pan/zoom) хранится локально у каждого пользователя.
//
// Если Firebase выключен в config.js или SDK не загрузился —
// остаётся локальный режим (window.Store из storage.js).

(function () {
  const cfg = window.APP_CONFIG.firebaseConfig;

  window.currentUser = null;

  const LocalAuth = {
    signInWithGoogle: async () => {},
    signOut: async () => {},
    onChange(cb) { cb(window.APP_CONFIG.localUser); }
  };

  if (!cfg || !cfg.enabled || typeof firebase === 'undefined' || !firebase.initializeApp) {
    console.warn('[firebase] Выключен или SDK не загружен — локальный режим.');
    window.Auth = LocalAuth;
    if (!window.Store) window.Store = window.__LocalStore;
    return;
  }

  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function projectsCol() { return db.collection('projects'); }
  function nodesCol(pid) { return projectsCol().doc(pid).collection('nodes'); }
  function viewKey(pid) { return 'miroz.view.' + pid; }

  // ---------- FirestoreStore ----------
  const FirestoreStore = {
    uid,

    // --- Проекты ---

    async listProjects() {
      const snap = await projectsCol().orderBy('updatedAt', 'desc').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async getProject(slug) {
      const doc = await projectsCol().doc(slug).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },

    // Realtime-список проектов. Возвращает функцию отписки.
    subscribeProjects(onChange) {
      return projectsCol().orderBy('updatedAt', 'desc').onSnapshot(snap => {
        onChange(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, err => console.error('[projects] snapshot error:', err));
    },

    async createProject(slug, name) {
      const user = window.currentUser;
      const ref = projectsCol().doc(slug);
      const existing = await ref.get();
      if (existing.exists) throw new Error('ID уже занят');

      const now = Date.now();
      const project = {
        id: slug,
        slug,
        name: (name || slug).trim() || slug,
        ownerId: user ? user.uid : 'anon',
        ownerName: user ? (user.displayName || user.email || 'Гость') : 'Гость',
        members: user ? [user.uid] : [],
        createdAt: now,
        updatedAt: now
      };
      await ref.set(project);
      return project;
    },

    async renameProject(id, name) {
      await projectsCol().doc(id).update({ name, updatedAt: Date.now() });
      return { id, name };
    },

    // Обновление редактируемых полей проекта (название, обложка, настройки и т.п.).
    async updateProject(id, patch) {
      const data = {};
      if (patch.name != null) data.name = String(patch.name).trim();
      if (patch.cover != null) data.cover = String(patch.cover);
      if (patch.defaultFontFamily != null) data.defaultFontFamily = String(patch.defaultFontFamily);
      if (patch.defaultFontSize != null) data.defaultFontSize = Number(patch.defaultFontSize) || 16;
      data.updatedAt = Date.now();
      await projectsCol().doc(id).update(data);
      return { id, ...data };
    },

    // Realtime-подписка на документ проекта (для общих настроек). Возвращает отписку.
    subscribeProject(id, onChange) {
      return projectsCol().doc(id).onSnapshot(doc => {
        if (doc.exists) onChange({ id: doc.id, ...doc.data() });
      }, err => console.error('[project] snapshot error:', err));
    },

    async deleteProject(id) {
      // Удаляем проект в любом случае, даже если не удалось почистить nodes
      // (например, из-за правил). Осиротевшие узлы не видны — проект удалён.
      try {
        const snap = await nodesCol(id).get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(projectsCol().doc(id));
        await batch.commit();
      } catch (e) {
        console.warn('[deleteProject] batch failed, deleting doc only:', e.message);
        await projectsCol().doc(id).delete();
      }
      localStorage.removeItem(viewKey(id));
    },

    // --- Узлы доски ---

    async getNodes(projectId) {
      const snap = await nodesCol(projectId).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async addNode(projectId, node) {
      const user = window.currentUser;
      const data = {
        type: node.type,
        x: node.x || 0,
        y: node.y || 0,
        text: node.text || '',
        createdBy: user ? user.uid : 'anon',
        updatedAt: Date.now()
      };
      if (node.fontFamily) data.fontFamily = node.fontFamily;
      if (node.fontSize) data.fontSize = node.fontSize;
      if (node.color) data.color = node.color;
      if (node.align) data.align = node.align;
      if (node.w != null) data.w = node.w;
      if (node.h != null) data.h = node.h;
      if (node.src) data.src = node.src;
      if (node.type === 'arrow') {
        if (node.fromId) data.fromId = node.fromId;
        if (node.toId) data.toId = node.toId;
        data.x1 = node.x1 || 0;
        data.y1 = node.y1 || 0;
        data.x2 = node.x2 || 0;
        data.y2 = node.y2 || 0;
        data.lineStyle = node.lineStyle || 'solid';
        data.startCap = node.startCap || 'none';
        data.endCap = node.endCap || 'arrow';
        data.shape = node.shape || 'straight';
        if (node.bend) data.bend = node.bend;
        if (node.startAnch) data.startAnch = { ux: node.startAnch.ux, uy: node.startAnch.uy };
        if (node.endAnch) data.endAnch = { ux: node.endAnch.ux, uy: node.endAnch.uy };
      }
      await nodesCol(projectId).doc(node.id).set(data);
      await projectsCol().doc(projectId).update({ updatedAt: Date.now() }).catch(() => {});
    },

    async updateNode(projectId, nodeId, patch) {
      // set+merge создаёт документ, если его ещё нет (иначе "No document to update").
      await nodesCol(projectId).doc(nodeId).set({ ...patch, updatedAt: Date.now() }, { merge: true });
    },

    async removeNode(projectId, nodeId) {
      await nodesCol(projectId).doc(nodeId).delete();
    },

    // Realtime-подписка на узлы. handlers: { onAdd, onModify, onRemove, onError }.
    subscribeNodes(projectId, handlers) {
      return nodesCol(projectId).onSnapshot(snap => {
        snap.docChanges().forEach(ch => {
          if (ch.type === 'removed') {
            handlers.onRemove(ch.doc.id);
          } else {
            const node = { id: ch.doc.id, ...ch.doc.data() };
            if (ch.type === 'added') handlers.onAdd(node);
            else handlers.onModify(node);
          }
        });
      }, err => {
        console.error('[nodes] snapshot error:', err);
        if (handlers.onError) handlers.onError(err);
      });
    },

    // --- Вид доски (локально у каждого пользователя) ---

    async getView(projectId) {
      try { return JSON.parse(localStorage.getItem(viewKey(projectId))) || { x: 0, y: 0, scale: 1 }; }
      catch (e) { return { x: 0, y: 0, scale: 1 }; }
    },

    async saveView(projectId, view) {
      localStorage.setItem(viewKey(projectId), JSON.stringify(view));
    }
  };

  // ---------- Auth ----------
  const Auth = {
    async signInWithGoogle() {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    },
    async signOut() { await auth.signOut(); },
    onChange(cb) {
      auth.onAuthStateChanged(user => { window.currentUser = user; cb(user); });
    }
  };

  window.Store = FirestoreStore;
  window.Auth = Auth;
})();
