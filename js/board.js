// Доска: холст, зум, панорамирование и создание элементов.
// Это базовая оболочка — наполнение (стикеры, фигуры, связи) будем расширять.

window.Board = (function () {
  let viewport, world;
  let board = null;
  let onSave = null;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 4;

  const view = { x: 0, y: 0, scale: 1 };
  let activeTool = 'select';
  let spaceDown = false;
  let panning = false;
  let panStart = null;
  let dragNode = null;
  let saveTimer = null;

  function init(opts) {
    viewport = document.getElementById('canvas-viewport');
    world = document.getElementById('canvas-world');
    onSave = opts && opts.onSave;

    bindEvents();
  }

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const grid = world.querySelector('.canvas-grid');
    if (grid) grid.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
    const zv = document.getElementById('zoom-value');
    if (zv) zv.textContent = Math.round(view.scale * 100) + '%';
  }

  function screenToWorld(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return {
      x: (clientX - r.left - view.x) / view.scale,
      y: (clientY - r.top - view.y) / view.scale
    };
  }

  // --- Загрузка / сохранение ---

  async function load(projectId) {
    board = await window.Store.getBoard(projectId);
    if (board.view) {
      view.x = board.view.x || 0;
      view.y = board.view.y || 0;
      view.scale = board.view.scale || 1;
    }
    render();
    applyView();
  }

  function scheduleSave() {
    if (!board) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      board.view = { x: view.x, y: view.y, scale: view.scale };
      if (onSave) onSave(board);
    }, 400);
  }

  // --- Отрисовка ---

  function render() {
    if (!board) return;
    world.querySelectorAll('.canvas-node').forEach(n => n.remove());
    board.nodes.forEach(renderNode);
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
      el.addEventListener('input', () => { node.text = el.textContent; scheduleSave(); });
    }
    world.appendChild(el);
  }

  // --- Создание элементов ---

  function addNode(type, x, y) {
    const node = {
      id: window.Store.uid(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      text: type === 'frame' ? '' : (type === 'text' ? 'Текст' : 'Стикер')
    };
    board.nodes.push(node);
    renderNode(node);
    scheduleSave();
    if (type !== 'frame') {
      const el = world.querySelector(`.canvas-node[data-id="${node.id}"]`);
      if (el) { el.focus(); document.execCommand && document.getSelection().selectAllChildren(el); }
    }
  }

  // --- События ---

  function bindEvents() {
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

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
      scheduleSave();
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
    scheduleSave();
  }

  function resetView() {
    view.x = 0; view.y = 0; view.scale = 1;
    applyView();
    scheduleSave();
  }

  function onMouseDown(e) {
    if (e.button === 1 || spaceDown) { startPan(e); return; }

    if (e.button === 0 && activeTool !== 'select') {
      const p = screenToWorld(e.clientX, e.clientY);
      addNode(activeTool, p.x, p.y);
      setTool('select');
      return;
    }

    const nodeEl = e.target.closest('.canvas-node');
    if (nodeEl && activeTool === 'select' && !e.target.isContentEditable) {
      const node = board.nodes.find(n => n.id === nodeEl.dataset.id);
      dragNode = { node, el: nodeEl, startX: e.clientX, startY: e.clientY, ox: node.x, oy: node.y };
      return;
    }

    if (!nodeEl) startPan(e);
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
    }
  }

  function onMouseUp() {
    if (panning) { panning = false; scheduleSave(); }
    if (dragNode) {
      dragNode.node.x = Math.round(dragNode.node.x);
      dragNode.node.y = Math.round(dragNode.node.y);
      dragNode = null;
      scheduleSave();
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

  return { init, load, applyView, resetView };
})();
