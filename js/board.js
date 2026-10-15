// Доска: холст, зум, панорамирование, элементы + realtime-синхронизация.
//
// Изменения других пользователей прилетают через Store.subscribeNodes и
// применяются к DOM на лету. Локальное перетаскивание/правка элемента не
// перебивается входящими апдейтами (пока элемент тащат или редактируют).

window.Board = (function () {
  let viewport, world;
  let projectId = null;
  let unsubscribe = null;

  const nodes = new Map();      // id -> данные узла
  const nodeEls = new Map();    // id -> DOM-элемент
  const draggingIds = new Set(); // узлы, которые сейчас тащим локально
  const textTimers = new Map();  // id -> таймер отложенной записи текста

  // Присутствие
  const cursorEls = new Map();   // sessionId -> DOM-элемент курсора
  let presenceUsers = [];
  let presenceUnsub = null;
  let presenceTrailTimer = null;
  let lastPresenceSent = 0;
  let latestPresence = null;
  let cursorRaf = null;
  let heartbeatTimer = null;

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 4;
  const view = { x: 0, y: 0, scale: 1 };

  let activeTool = 'select';
  let spaceDown = false;
  let panning = false;
  let panStart = null;
  let dragNode = null;
  let viewTimer = null;
  let warnedPermission = false;
  let dragSaveTimer = null;
  let dragSavePending = null;

  const HEARTBEAT_MS = 25000; // держим присутствие живым (даже в фоновой вкладке)

  // Показываем ошибку синхронизации один раз, чтобы не спамить.
  function handleError(err) {
    console.error('[board]', err);
    if (warnedPermission) return;
    warnedPermission = true;
    const msg = String((err && err.message) || err);
    if (/permission|insufficient|missing/i.test(msg)) {
      alert('Нет доступа к базе Firestore.\n\nОпубликуйте правила: Firestore → Rules. ' +
        'Коллекции projects/{id}/nodes и projects/{id}/presence должны быть разрешены.');
    } else {
      alert('Ошибка синхронизации доски: ' + msg);
    }
  }

  function init() {
    viewport = document.getElementById('canvas-viewport');
    world = document.getElementById('canvas-world');
    bindEvents();
  }

  // --- Вид ---

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const grid = world.querySelector('.canvas-grid');
    if (grid) grid.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
    const zv = document.getElementById('zoom-value');
    if (zv) zv.textContent = Math.round(view.scale * 100) + '%';
  }

  function scheduleViewSave() {
    if (!projectId) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      window.Store.saveView(projectId, { x: view.x, y: view.y, scale: view.scale });
    }, 400);
  }

  function screenToWorld(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return {
      x: (clientX - r.left - view.x) / view.scale,
      y: (clientY - r.top - view.y) / view.scale
    };
  }

  // --- Загрузка / выгрузка ---

  async function load(pid) {
    unload();
    projectId = pid;
    nodes.clear();
    nodeEls.clear();
    world.querySelectorAll('.canvas-node').forEach(n => n.remove());

    const v = await window.Store.getView(pid);
    view.x = v.x || 0;
    view.y = v.y || 0;
    view.scale = v.scale || 1;

    try {
      const list = await window.Store.getNodes(pid);
      list.forEach(renderOrAdd);
    } catch (err) {
      handleError(err);
    }
    applyView();
    renderPresence();

    unsubscribe = window.Store.subscribeNodes(pid, {
      onAdd: renderOrAdd,
      onModify: applyRemoteNode,
      onRemove: removeNodeById,
      onError: handleError
    });

    presenceUsers = [];
    presenceUnsub = window.Presence.subscribe(pid, renderCursors, handleError);
    sendJoinPresence();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    startCursorLoop();
  }

  function unload() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (presenceUnsub) { presenceUnsub(); presenceUnsub = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (presenceTrailTimer) { clearTimeout(presenceTrailTimer); presenceTrailTimer = null; }
    if (cursorRaf) { cancelAnimationFrame(cursorRaf); cursorRaf = null; }
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    if (projectId) window.Presence.leave(projectId);
    cursorEls.forEach(el => el.remove());
    cursorEls.clear();
    presenceUsers = [];
    latestPresence = null;
    projectId = null;
  }

  // --- Применение данных ---

  function renderOrAdd(node) {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, node);
    renderNode(node);
  }

  function applyRemoteNode(node) {
    const local = nodes.get(node.id);
    const el = nodeEls.get(node.id);
    if (!local || !el) { renderOrAdd(node); return; }

    const editing = document.activeElement === el;
    const dragging = draggingIds.has(node.id);

    local.type = node.type;
    if (!dragging) {
      local.x = node.x;
      local.y = node.y;
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
    }
    if (!editing) {
      local.text = node.text;
      el.textContent = node.text;
    }
  }

  function removeNodeById(id) {
    const el = nodeEls.get(id);
    if (el) el.remove();
    nodeEls.delete(id);
    nodes.delete(id);
  }

  function renderNode(node) {
    const el = document.createElement('div');
    el.className = 'canvas-node canvas-node--' + node.type;
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.textContent = node.text || '';

    if (node.type === 'sticky' || node.type === 'text') {
      el.contentEditable = 'true';
      el.addEventListener('input', () => {
        node.text = el.textContent;
        scheduleTextSave(node.id);
      });
    }
    nodeEls.set(node.id, el);
    world.appendChild(el);
  }

  function scheduleTextSave(id) {
    if (!projectId) return;
    clearTimeout(textTimers.get(id));
    textTimers.set(id, setTimeout(() => {
      const n = nodes.get(id);
      if (n) window.Store.updateNode(projectId, id, { text: n.text }).catch(handleError);
    }, 500));
  }

  // --- Создание элементов ---

  function addNode(type, x, y) {
    const user = window.currentUser;
    const node = {
      id: window.Store.uid(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      text: type === 'frame' ? '' : (type === 'text' ? 'Текст' : 'Стикер'),
      createdBy: user ? user.uid : 'anon'
    };
    nodes.set(node.id, node);
    renderNode(node);
    window.Store.addNode(projectId, node).catch(handleError);

    if (type !== 'frame') {
      const el = nodeEls.get(node.id);
      if (el) {
        el.focus();
        const sel = document.getSelection();
        if (sel) sel.selectAllChildren(el);
      }
    }
  }

  // --- Присутствие: чужие курсоры и онлайн-аватарки ---

  function myIdentity() {
    const u = window.currentUser;
    return {
      uid: (u && u.uid) || 'anon',
      name: (u && (u.displayName || u.email)) || 'Гость'
    };
  }

  function colorFor(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return `hsl(${h}, 70%, 45%)`;
  }

  function worldToScreen(x, y) {
    return { x: x * view.scale + view.x, y: y * view.scale + view.y };
  }

  function createCursorEl() {
    const el = document.createElement('div');
    el.className = 'cursor';
    el.innerHTML =
      '<svg class="cursor__svg" width="22" height="24" viewBox="0 0 22 24">' +
      '<path d="M2 1 L2 20 L7.5 15 L11 22.5 L14.5 20.5 L11 13.5 L18.5 13.5 Z"/>' +
      '</svg><span class="cursor__name"></span>';
    return el;
  }

  // Плавное движение: интерполируем позицию к цели в requestAnimationFrame,
  // поэтому сетевые задержки/пакеты не дают тряски.
  function startCursorLoop() {
    if (cursorRaf) return;
    const frame = () => {
      cursorEls.forEach(el => {
        const tx = Number(el.dataset.tx);
        const ty = Number(el.dataset.ty);
        if (!isFinite(tx) || !isFinite(ty)) return;
        let cx = Number(el.dataset.cx);
        let cy = Number(el.dataset.cy);
        if (!isFinite(cx) || !isFinite(cy)) { cx = tx; cy = ty; }
        cx += (tx - cx) * 0.3;
        cy += (ty - cy) * 0.3;
        el.dataset.cx = cx;
        el.dataset.cy = cy;
        const p = worldToScreen(cx, cy);
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      });
      cursorRaf = requestAnimationFrame(frame);
    };
    cursorRaf = requestAnimationFrame(frame);
  }

  function renderCursors(users) {
    presenceUsers = Array.isArray(users) ? users : [];
    const layer = document.getElementById('cursors');
    const alive = new Set();

    if (layer) {
      presenceUsers.forEach(u => {
        if (!u || !u.sessionId) return;          // себя Presence уже отфильтровал
        if (u.x == null || u.y == null) return;  // ещё не двигал курсором
        alive.add(u.sessionId);

        let el = cursorEls.get(u.sessionId);
        if (!el) {
          el = createCursorEl();
          cursorEls.set(u.sessionId, el);
          layer.appendChild(el);
        }
        const color = u.color || colorFor(u.uid || u.sessionId);
        if (el._color !== color) { el._color = color; el.style.setProperty('--c', color); }
        const name = u.name || 'Гость';
        if (el._name !== name) { el._name = name; el.querySelector('.cursor__name').textContent = name; }

        el.dataset.tx = Number(u.x);
        el.dataset.ty = Number(u.y);
      });

      cursorEls.forEach((el, sid) => {
        if (!alive.has(sid)) { el.remove(); cursorEls.delete(sid); }
      });
    }

    renderPresence();
  }

  function renderPresence() {
    const pres = document.getElementById('presence');
    if (!pres) return;
    const me = myIdentity();
    const people = [];
    const seen = new Set();

    // Все активные сессии присутствуют, пока соединение живо (RTDB onDisconnect).
    presenceUsers.forEach(u => {
      if (!u || !u.uid || seen.has(u.uid)) return;
      seen.add(u.uid);
      people.push(u);
    });
    if (!seen.has(me.uid)) people.unshift({ uid: me.uid, name: me.name, color: colorFor(me.uid) });

    pres.innerHTML = '';
    people.forEach(u => {
      const av = document.createElement('div');
      av.className = 'presence__avatar';
      av.style.background = u.color || colorFor(u.uid);
      av.textContent = (u.name || '?').slice(0, 1).toUpperCase();
      av.title = (u.uid === me.uid ? 'Вы: ' : '') + (u.name || '');
      pres.appendChild(av);
    });
  }

  // --- Отправка своей позиции курсора ---

  function myProfile() {
    const me = myIdentity();
    return { uid: me.uid, name: me.name, color: colorFor(me.uid) };
  }

  function sendJoinPresence() {
    latestPresence = { ...myProfile(), updatedAt: Date.now() };
    window.Presence.update(projectId, latestPresence);
  }

  function sendHeartbeat() {
    if (!projectId) return;
    if (!latestPresence) { sendJoinPresence(); return; }
    latestPresence.updatedAt = Date.now();
    window.Presence.update(projectId, latestPresence);
  }

  function onCursorMove(e) {
    if (!projectId || !window.Presence.enabled()) return;
    const me = myIdentity();
    const p = screenToWorld(e.clientX, e.clientY);
    latestPresence = {
      ...myProfile(),
      x: Math.round(p.x),
      y: Math.round(p.y),
      updatedAt: Date.now()
    };
    const now = Date.now();
    if (now - lastPresenceSent >= 70) {
      sendPresence();
    } else if (!presenceTrailTimer) {
      presenceTrailTimer = setTimeout(() => {
        presenceTrailTimer = null;
        sendPresence();
      }, 70 - (now - lastPresenceSent));
    }
  }

  function sendPresence() {
    lastPresenceSent = Date.now();
    if (latestPresence) window.Presence.update(projectId, latestPresence);
  }

  function onBeforeUnload() {
    if (projectId) window.Presence.leave(projectId);
  }

  // --- События ---

  function bindEvents() {
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('mousedown', onMouseDown);
    viewport.addEventListener('dblclick', onDblClick);
    viewport.addEventListener('mousemove', onCursorMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', onBeforeUnload);

    // Отключаем контекстное меню браузера (в т.ч. Яндекс) на холсте и элементах,
    // но оставляем его в полях ввода (заголовок, текстовые элементы).
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea')) return;
      e.preventDefault();
    });

    document.querySelectorAll('.tool').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    document.getElementById('zoom-in').addEventListener('click', () => zoomAt(0.2));
    document.getElementById('zoom-out').addEventListener('click', () => zoomAt(-0.2));
    document.getElementById('zoom-reset').addEventListener('click', resetView);
  }

  function setTool(tool) {
    activeTool = tool;
    viewport.dataset.tool = tool;
    document.querySelectorAll('.tool').forEach(b =>
      b.classList.toggle('is-active', b.dataset.tool === tool));
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(-e.deltaY * 0.0015, e.clientX, e.clientY);
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
      scheduleViewSave();
    }
  }

  function zoomAt(delta, clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    const cx = clientX == null ? r.width / 2 : clientX - r.left;
    const cy = clientY == null ? r.height / 2 : clientY - r.top;
    const worldX = (cx - view.x) / view.scale;
    const worldY = (cy - view.y) / view.scale;
    let next = view.scale * (1 + delta);
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    view.scale = next;
    view.x = cx - worldX * view.scale;
    view.y = cy - worldY * view.scale;
    applyView();
    scheduleViewSave();
  }

  function resetView() {
    view.x = 0; view.y = 0; view.scale = 1;
    applyView();
    scheduleViewSave();
  }

  function onMouseDown(e) {
    if (e.button === 1 || spaceDown) { startPan(e); return; }
    if (e.button !== 0) return;

    if (activeTool !== 'select') {
      const p = screenToWorld(e.clientX, e.clientY);
      addNode(activeTool, p.x, p.y);
      setTool('select');
      return;
    }

    const nodeEl = e.target.closest('.canvas-node');
    if (nodeEl) {
      if (document.activeElement === nodeEl) return; // идёт редактирование
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const node = nodes.get(nodeEl.dataset.id);
      if (!node) return;
      draggingIds.add(node.id);
      dragNode = { node, el: nodeEl, startX: e.clientX, startY: e.clientY, ox: node.x, oy: node.y };
      return;
    }
    startPan(e);
  }

  function onDblClick(e) {
    const el = e.target.closest('.canvas-node');
    if (el && el.isContentEditable) el.focus();
  }

  function startPan(e) {
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  }

  function onMouseMove(e) {
    if (panning) {
      view.x = panStart.vx + (e.clientX - panStart.x);
      view.y = panStart.vy + (e.clientY - panStart.y);
      applyView();
      return;
    }
    if (dragNode) {
      dragNode.node.x = dragNode.ox + (e.clientX - dragNode.startX) / view.scale;
      dragNode.node.y = dragNode.oy + (e.clientY - dragNode.startY) / view.scale;
      dragNode.el.style.left = dragNode.node.x + 'px';
      dragNode.el.style.top = dragNode.node.y + 'px';
      queueLiveMove(dragNode.node);
    }
  }

  // Другие пользователи видят перемещение элемента в реальном времени.
  function queueLiveMove(node) {
    dragSavePending = node;
    if (dragSaveTimer) return;
    flushLiveMove();
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      if (dragSavePending) flushLiveMove();
    }, 40);
  }

  function flushLiveMove() {
    const node = dragSavePending;
    dragSavePending = null;
    if (node && projectId) {
      window.Store.updateNode(projectId, node.id, { x: Math.round(node.x), y: Math.round(node.y) })
        .catch(handleError);
    }
  }

  function onMouseUp() {
    if (panning) { panning = false; scheduleViewSave(); }
    if (dragNode) {
      const { node, el } = dragNode;
      if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
      dragSavePending = null;
      node.x = Math.round(node.x);
      node.y = Math.round(node.y);
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      draggingIds.delete(node.id);
      window.Store.updateNode(projectId, node.id, { x: node.x, y: node.y })
        .catch(handleError);
      dragNode = null;
    }
  }

  function onKeyDown(e) {
    if (e.code === 'Space' && !isEditing()) {
      spaceDown = true;
      viewport.style.cursor = 'grab';
    }
    if (isEditing()) return;
    if (e.key === 'v' || e.key === '1') setTool('select');
    if (e.key === 'n' || e.key === 's' || e.key === '2') setTool('sticky');
    if (e.key === 't' || e.key === '3') setTool('text');
    if (e.key === 'f' || e.key === '4') setTool('frame');
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceDown = false;
      panning = false;
      viewport.style.cursor = '';
    }
  }

  function isEditing() {
    const a = document.activeElement;
    return a && (a.isContentEditable || a.tagName === 'INPUT');
  }

  return { init, load, unload, applyView, resetView };
})();
