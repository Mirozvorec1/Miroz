// Подключение Firebase: Auth (Google) + Firestore.
// Работает поверх compat-SDK (firebase-app/auth/firestore-compat.js),
// подключённого в index.html до этого файла.
//
// Если Firebase выключен в config.js или SDK не загрузился —
// остаётся локальный режим (window.Store из storage.js).

(function () {
  const cfg = window.APP_CONFIG.firebaseConfig;

  window.currentUser = null;

  // Заглушка Auth для локального режима.
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

  // ---------- FirestoreStore: тот же интерфейс, что у локального Store ----------
  const FirestoreStore = {
    uid,

    async listProjects() {
      const snap = await db.collection('projects')
        .orderBy('updatedAt', 'desc').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async createProject(name) {
      const user = window.currentUser;
      const now = Date.now();
      const id = uid();
      const project = {
        id,
        name: (name || 'Без названия').trim() || 'Без названия',
        ownerId: user ? user.uid : 'anon',
        ownerName: user ? (user.displayName || user.email || 'Гость') : 'Гость',
        members: user ? [user.uid] : [],
        createdAt: now,
        updatedAt: now
      };
      await db.collection('projects').doc(id).set(project);
      return project;
    },

    async renameProject(id, name) {
      await db.collection('projects').doc(id).update({ name, updatedAt: Date.now() });
      return { id, name };
    },

    async deleteProject(id) {
      await db.collection('projects').doc(id).collection('board').doc('main').delete().catch(() => {});
      await db.collection('projects').doc(id).delete();
    },

    async getBoard(projectId) {
      const ref = db.collection('projects').doc(projectId).collection('board').doc('main');
      const doc = await ref.get();
      if (doc.exists) return doc.data();
      return { projectId, nodes: [], view: { x: 0, y: 0, scale: 1 } };
    },

    async saveBoard(projectId, board) {
      const projectRef = db.collection('projects').doc(projectId);
      const boardRef = projectRef.collection('board').doc('main');
      await boardRef.set({ nodes: board.nodes || [], view: board.view || { x: 0, y: 0, scale: 1 } });
      await projectRef.update({ updatedAt: Date.now() });
    }
  };

  // ---------- Auth ----------
  const Auth = {
    async signInWithGoogle() {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    },
    async signOut() {
      await auth.signOut();
    },
    onChange(cb) {
      auth.onAuthStateChanged(user => {
        window.currentUser = user;
        cb(user);
      });
    }
  };

  window.Store = FirestoreStore;
  window.Auth = Auth;
})();
