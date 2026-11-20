// Доска: холст, зум, панорамирование, элементы + realtime-синхронизация.
//
// Изменения других пользователей прилетают через Store.subscribeNodes и
// применяются к DOM на лету. Локальное перетаскивание/правка элемента не
// перебивается входящими апдейтами (пока элемент тащат или редактируют).

window.Board = (function () {
  let viewport, world;
  let gridEl = null;   // фон-сетка (живёт в viewport, тайлится бесконечно)
  let arrowLayer = null; // SVG-слой стрелок-коннекторов
  let guidesLayer = null; // слой линий выравнивания (smart guides)
  let selBox = null;   // рамка вокруг группы выделенных элементов
  let projectId = null;
  let unsubscribe = null;        // подписка Firestore на узлы (только в live-режиме)
  let soloMode = false;          // true — в проекте только мы, realtime выключен

  const FONT_FAMILIES = [
    { label: 'Simple', value: '' },
    { label: 'Bookish', value: 'Georgia, "Times New Roman", serif' },
    { label: 'Technical', value: '"Courier New", monospace' },
    { label: 'Scribbled', value: '"Comic Sans MS", "Segoe UI", cursive' }
  ];
  const FONT_SIZES = [
    { label: 'Small', value: 12 },
    { label: 'Medium', value: 16 },
    { label: 'Large', value: 24 },
    { label: 'Extra large', value: 32 },
    { label: 'Huge', value: 48 }
  ];
  const CONNECTOR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2.5 8h10M9 4.5L12.5 8 9 11.5"/></svg>';
  const DEFAULT_FONT_SIZE = 16; // базовый кегль текста (см. макет)
  const RESIZE_STEP = 10;       // шаг изменения размера за уголки
  const TEXT_COLORS = [
    '#1a1a1a', '#4b5563', '#e5484d', '#f76808', '#f5c400', '#30a46c',
    '#00b8d9', '#0091ff', '#8e4ec6', '#e93d82', '#ffffff', '#d1d5db'
  ];
  const TEXT_COLORS_LIGHT = [
    '#f3f4f6', '#fca5a5', '#fdba74', '#fde68a', '#a7f3d0', '#99f6e4',
    '#bae6fd', '#c4b5fd', '#fbcfe8', '#f9a8d4', '#e5e7eb', '#ffe4e6'
  ];
  const ALIGN_ITEMS = [
    { value: 'left', label: 'По левому краю' },
    { value: 'center', label: 'По центру' },
    { value: 'right', label: 'По правому краю' },
    { value: 'justify', label: 'По ширине' }
  ];

  const nodes = new Map();      // id -> данные узла
  const nodeEls = new Map();    // id -> DOM-элемент
  const arrowEls = new Map();   // id -> SVG-группа стрелки
  const draggingIds = new Set(); // узлы, которые сейчас тащим локально
  const textTimers = new Map();  // id -> таймер отложенной записи текста
  const selectedIds = new Set(); // выделенные элементы

  // Блокировка: кто выделил узел — тот им и владеет (вычисляется из presence).
  let lockState = { owners: new Map(), colorOf: new Map(), nameOf: new Map(), self: null };

  // Буфер обмена и история (только собственные действия)
  let clipboard = [];
  const history = [];
  let historyLock = false;
  // Отменённые действия — для повтора (Ctrl+Y / Ctrl+Shift+Z).
  const redoStack = [];

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
  const GRID_SIZE = 40;   // шаг точек фона (должен совпадать с CSS .canvas-grid)
  const view = { x: 0, y: 0, scale: 1 };

  let activeTool = 'select';
  let activeFigure = 'rect';
  try { activeFigure = localStorage.getItem('miroz.figure') || 'rect'; } catch (e) { /* ignore */ }
  let activeArrowShape = 'straight';
  try {
    activeArrowShape = (window.Settings && window.Settings.arrowShape()) || 'straight';
  } catch (e) { /* ignore */ }
  let arrowCursorEl = null;
  let figurePreview = null;
  let arrowCursorHiEl = null;
  let arrowCursorSnap = null;
  // Общие настройки проекта: стандартный шрифт и кегль новых элементов.
  let boardDefaults = { fontFamily: '', fontSize: DEFAULT_FONT_SIZE };
  let spaceDown = false;
  let panning = false;
  let panStart = null;
  let dragGroup = null;   // { startX, startY, items:[{node, el, ox, oy}] }
  let clickCandidate = null; // { id, wasSelected, moved } — отличаем клик от перетаскивания
  let resizing = null;    // { id, corner, startX, startY, ox, oy, ow, oh }
  let marquee = null;     // { start, rect, el, base }
  let lastRmb = { id: null, t: 0 };
  let lastCursorWorld = null;   // последняя позиция курсора в мировых координатах
  let viewTimer = null;
  let warnedPermission = false;
  let dragSaveTimer = null;
  let dragSavePending = null;

  const HEARTBEAT_MS = 25000; // держим присутствие живым (даже в фоновой вкладке)
  // Позицию курсора шлём только в ответ на действия (клик, перетаскивание,
  // зум и т.п.), не чаще чем раз в PRESENCE_ACTION_MS. Простое «ведение»
  // мышью по экрану запросов не создаёт.
  const PRESENCE_ACTION_MS = 200;

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

    // Сетку-фон переносим из world в viewport: она не должна уезжать при
    // панорамировании, а её смещение задаётся через background-position.
    gridEl = world.querySelector('.canvas-grid');
    if (gridEl && gridEl.parentNode === world) viewport.insertBefore(gridEl, world);

    // Рамка вокруг выделения + ручки изменения размера + шарики-коннекторы.
    selBox = document.createElement('div');
    selBox.className = 'sel-box hidden';
    selBox.innerHTML =
      '<div class="sel-handle" data-corner="nw"></div>' +
      '<div class="sel-handle" data-corner="ne"></div>' +
      '<div class="sel-handle" data-corner="sw"></div>' +
      '<div class="sel-handle" data-corner="se"></div>' +
      '<div class="sel-handle sel-handle--side" data-corner="e"></div>' +
      '<div class="sel-handle sel-handle--side" data-corner="w"></div>' +
      '<div class="sel-handle sel-handle--h" data-corner="n"></div>' +
      '<div class="sel-handle sel-handle--h" data-corner="s"></div>' +
      '<button class="sel-ball" type="button" data-ball="n" title="Создать стрелку вверх">' + CONNECTOR_ICON + '</button>' +
      '<button class="sel-ball" type="button" data-ball="e" title="Создать стрелку вправо">' + CONNECTOR_ICON + '</button>' +
      '<button class="sel-ball" type="button" data-ball="s" title="Создать стрелку вниз">' + CONNECTOR_ICON + '</button>' +
      '<button class="sel-ball" type="button" data-ball="w" title="Создать стрелку влево">' + CONNECTOR_ICON + '</button>';
    viewport.appendChild(selBox);

    // Слой линий выравнивания (smart guides) — фиксированный, поверх холста.
    guidesLayer = document.createElement('div');
    guidesLayer.className = 'guides-layer hidden';
    guidesLayer.innerHTML = '<div class="guide"></div><div class="guide"></div>';
    viewport.appendChild(guidesLayer);

    // Слой стрелок-коннекторов (внутри world — трансформируется вместе с видом).
    arrowLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowLayer.setAttribute('class', 'arrow-layer');
    world.appendChild(arrowLayer);

    if (window.ElementMenu && window.ElementMenu.init) window.ElementMenu.init();

    bindEvents();
  }

  // --- Вид ---

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    if (gridEl) {
      gridEl.style.backgroundSize = `${GRID_SIZE * view.scale}px ${GRID_SIZE * view.scale}px`;
      gridEl.style.backgroundPosition = `${view.x}px ${view.y}px`;
    }
    const zv = document.getElementById('zoom-value');
    if (zv && document.activeElement !== zv) zv.value = Math.round(view.scale * 100) + '%';
    updateSelectionBox();
    updateTextToolbar();
    refreshArrows();
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
    selectedIds.clear();
    history.length = 0;
    clipboard = [];
    world.querySelectorAll('.canvas-node').forEach(n => n.remove());

    const v = await window.Store.getView(pid);
    view.x = v.x || 0;
    view.y = v.y || 0;
    view.scale = v.scale || 1;

    applyView();
    renderPresence();

    // Оптимизация под лимит Firestore: пока в проекте только мы, realtime-подписку
    // не держим. Узлы читаем один раз (getNodes), свои правки пишем как обычно.
    // Как только через presence появится другой участник — включаем live-режим
    // (subscribeNodes) и получаем обновления в реальном времени.
    soloMode = true;
    try {
      const list = await window.Store.getNodes(pid);
      list.forEach(renderOrAdd);
    } catch (err) {
      handleError(err);
    }

    presenceUsers = [];
    presenceUnsub = window.Presence.subscribe(pid, renderCursors, handleError);
    sendJoinPresence();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    startCursorLoop();
    // Без присутствия (RTDB) нельзя узнать о других участниках — держим live.
    const presenceOn = window.Presence && window.Presence.enabled && window.Presence.enabled();
    if (presenceOn) maybeGoLive(); else startLive();
  }

  // Включает realtime-подписку на узлы.
  function startLive() {
    if (unsubscribe || !projectId) return;
    soloMode = false;
    unsubscribe = window.Store.subscribeNodes(projectId, {
      // Первый снимок отдаёт все документы как added: существующие локальные
      // узлы не пересоздаём, а применяем к ним свежие данные.
      onAdd: (n) => { if (nodes.has(n.id)) applyRemoteNode(n); else renderOrAdd(n); },
      onModify: applyRemoteNode,
      onRemove: removeNodeById,
      onError: handleError
    });
  }

  // Включает realtime, когда в проекте появился ещё кто-то.
  function maybeGoLive() {
    if (!soloMode || !projectId || unsubscribe) return;
    if (!presenceUsers.length) return;
    startLive();
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
    lockState = { owners: new Map(), colorOf: new Map(), nameOf: new Map(), self: null };
    latestPresence = null;
    hideTextToolbar();
    selectedIds.clear();
    history.length = 0;
    dragGroup = null;
    marquee = null;
    hideGuides();
    soloMode = false;
    projectId = null;
  }

  // --- Применение данных ---

  function renderOrAdd(node) {
    if (nodes.has(node.id)) return;
    sanitizeNodeNumbers(node);
    nodes.set(node.id, node);
    if (node.type === 'arrow') { renderArrow(node); return; }
    renderNode(node);
  }

  // Приводим числовые поля узла к конечным значениям (в базе мог осесть NaN).
  function sanitizeNodeNumbers(node) {
    ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'bend'].forEach(k => {
      const v = Number(node[k]);
      if (node[k] !== undefined && !isFinite(v)) node[k] = 0;
    });
  }

  function applyRemoteNode(node) {
    sanitizeNodeNumbers(node);
    const local = nodes.get(node.id);

    if (node.type === 'arrow') {
      if (!local) { renderOrAdd(node); return; }
      ['color', 'lineStyle', 'startCap', 'endCap', 'fromId', 'toId', 'x1', 'y1', 'x2', 'y2', 'shape', 'bend', 'c1', 'c2', 'manualPoints', 'startAnch', 'endAnch']
        .forEach(k => { if (node[k] !== undefined) local[k] = node[k]; });
      updateArrow(local);
      return;
    }

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
    if (node.w !== undefined || node.h !== undefined) {
      if (node.w !== undefined) local.w = node.w;
      if (node.h !== undefined) local.h = node.h;
      applyNodeBox(el, local);
    }

    // Изображение: обновляем только источник.
    if (node.type === 'image') {
      if (node.src !== undefined && node.src !== local.src) {
        local.src = node.src;
        const im = el.querySelector('img');
        if (im && im.getAttribute('src') !== node.src) im.src = node.src;
      }
      return;
    }

    ['fontFamily', 'fontSize', 'color', 'align', 'figure', 'fill', 'stroke', 'strokeStyle', 'strokeWidth', 'opacity'].forEach(k => {
      if (node[k] !== undefined) local[k] = node[k];
    });
    applyNodeTextStyle(el, local);
    applyNodeAppearance(el, local);
    if (!editing && node.type !== 'frame') {
      local.text = (node.type === 'sticky' && node.text === 'Стикер') ? '' : node.text;
      el.innerHTML = sanitizeHtml(local.text || '');
      updateStickyPlaceholder(el, local);
    }
    if (node.type === 'frame') ensureFigureShape(el, local.figure || 'rect');
    refreshArrows();
  }

  function removeNodeById(id) {
    const el = nodeEls.get(id);
    if (el) el.remove();
    nodeEls.delete(id);
    removeArrowEl(id);
    const existed = nodes.get(id);
    nodes.delete(id);
    selectedIds.delete(id);
    // Стрелки, привязанные к удалённому элементу, тоже убираем.
    if (existed && existed.type !== 'arrow') cleanupArrowsFor(id);
  }

  function updateStickyPlaceholder(el, node) {
    if (!el || !node) return;
    const empty = node.type === 'sticky' && !(node.text && node.text.trim());
    el.classList.toggle('is-placeholder', empty);
    if (empty) el.setAttribute('data-placeholder', 'Стикер');
    else el.removeAttribute('data-placeholder');
  }

  function renderNode(node) {
    const el = document.createElement('div');
    el.className = 'canvas-node canvas-node--' + node.type;
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    applyNodeBox(el, node);

    if (node.type === 'frame') {
      ensureFigureShape(el, node.figure || 'rect');
    } else if (node.type === 'image') {
      const img = document.createElement('img');
      img.src = node.src || '';
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    } else {
      // Старые стикеры с текстом «Стикер» считаем пустыми — это был плейсхолдер.
      if (node.type === 'sticky' && node.text === 'Стикер') node.text = '';
      el.innerHTML = sanitizeHtml(node.text || '');
      applyNodeTextStyle(el, node);
      updateStickyPlaceholder(el, node);
    }
    applyNodeAppearance(el, node);
    if (selectedIds.has(node.id)) el.classList.add('is-selected');

    if (node.type === 'sticky' || node.type === 'text') {
      el.contentEditable = 'true';
      el.addEventListener('input', () => {
        node.text = el.innerHTML;
        updateStickyPlaceholder(el, node);
        scheduleTextSave(node.id);
        updateSelectionBox();     // элемент растёт вниз — тянем рамку и панель
        updateTextToolbar();
      });
      // История правки текста: фиксируем значение до и после редактирования.
      el.addEventListener('focus', () => { el._textBefore = node.text || ''; });
      el.addEventListener('blur', () => {
        if (el._textBefore !== undefined && el._textBefore !== node.text) {
          const before = el._textBefore;
          const after = node.text || '';
          el._textBefore = undefined;
          const applyText = value => {
            const n = nodes.get(node.id);
            const nodeEl = nodeEls.get(node.id);
            if (n) n.text = value;
            if (nodeEl) nodeEl.innerHTML = sanitizeHtml(value);
            updateStickyPlaceholder(nodeEl, n);
            if (projectId) window.Store.updateNode(projectId, node.id, { text: value }).catch(handleError);
            updateSelectionBox();
            updateTextToolbar();
          };
          pushHistory({ undo: () => applyText(before), redo: () => applyText(after) });
        }
      });
    }
    applyLockState(el, node.id);
    nodeEls.set(node.id, el);
    world.appendChild(el);
  }

  function applyNodeTextStyle(el, node) {
    el.style.fontFamily = node.fontFamily || '';
    el.style.fontSize = node.fontSize ? node.fontSize + 'px' : '';
    el.style.color = node.color || '';
    el.style.textAlign = node.align || '';
  }

  // Яркость цвета — чтобы текст на цветном стикере оставался читаемым.
  function contrastText(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').replace(/^#/, ''));
    if (!m) return '';
    const n = m[1];
    const lum = (0.299 * parseInt(n.slice(0, 2), 16) +
      0.587 * parseInt(n.slice(2, 4), 16) +
      0.114 * parseInt(n.slice(4, 6), 16)) / 255;
    return lum < 0.55 ? '#ffffff' : '#1a1a1a';
  }

  const FIGURE_SIZES = {
    rect: { w: 180, h: 180 },
    rectangle: { w: 280, h: 160 },
    ellipse: { w: 200, h: 140 },
    diamond: { w: 170, h: 170 },
    triangle: { w: 180, h: 160 },
    'triangle-down': { w: 180, h: 160 },
    circle: { w: 170, h: 170 }
  };

  function figureShapeDef(figure) {
    switch (figure) {
      case 'rectangle': return { tag: 'rect', attrs: { x: 2, y: 2, width: 96, height: 96, rx: 1 } };
      case 'ellipse': return { tag: 'ellipse', attrs: { cx: 50, cy: 50, rx: 48, ry: 34 } };
      case 'circle': return { tag: 'circle', attrs: { cx: 50, cy: 50, r: 47 } };
      case 'diamond': return { tag: 'polygon', attrs: { points: '50,2 98,50 50,98 2,50' } };
      case 'triangle': return { tag: 'polygon', attrs: { points: '50,2 98,98 2,98' } };
      case 'triangle-down': return { tag: 'polygon', attrs: { points: '2,2 98,2 50,98' } };
      default: return { tag: 'rect', attrs: { x: 2, y: 2, width: 96, height: 96, rx: 1 } };
    }
  }

  function ensureFigureShape(el, figure) {
    let svg = el.querySelector('.figure-svg');
    if (!svg) {
      svg = svgEl('svg', {
        class: 'figure-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none'
      });
      el.appendChild(svg);
    }
    // Прямоугольники тянутся по боксу, остальные фигуры сохраняют пропорции
    // и не превращаются в растянутые «блинчики».
    svg.setAttribute('preserveAspectRatio',
      (figure === 'rect' || figure === 'rectangle') ? 'none' : 'xMidYMid meet');
    const def = figureShapeDef(figure);
    let shape = svg.querySelector('.figure-shape');
    if (!shape || shape.tagName.toLowerCase() !== def.tag) {
      if (shape) shape.remove();
      shape = svgEl(def.tag, { class: 'figure-shape', 'vector-effect': 'non-scaling-stroke' });
      svg.appendChild(shape);
    }
    Object.keys(def.attrs).forEach(k => shape.setAttribute(k, def.attrs[k]));
    return shape;
  }

  // Заливка/обводка/прозрачность стикера и фигуры (frame).
  function applyNodeAppearance(el, node) {
    if (!el || !node) return;
    if (node.type !== 'sticky' && node.type !== 'frame') return;

    if (node.type === 'frame') {
      const shape = ensureFigureShape(el, node.figure || 'rect');
      // Стандартный вид фигуры: белая заливка и сплошная тёмная обводка.
      // Важно: стили задаём именно inline, иначе CSS-правило .figure-shape
      // перекрывает SVG-атрибуты и изменения не видны.
      shape.style.fill = node.fill || '#ffffff';
      const style = node.strokeStyle || 'solid';
      if (style === 'none') {
        shape.style.stroke = 'none';
        shape.style.strokeWidth = '0';
        shape.style.strokeDasharray = 'none';
      } else {
        shape.style.stroke = node.stroke || '#1a1a1a';
        shape.style.strokeWidth = (Number(node.strokeWidth) || 2) + 'px';
        shape.style.strokeDasharray = style === 'dashed' ? '6 4' : 'none';
      }
      el.style.background = '';
      el.style.border = 'none';
      el.style.opacity = node.opacity != null ? String(node.opacity) : '';
      return;
    }

    if (node.fill) {
      el.style.background = node.fill;
      if (node.type === 'sticky' && !node.color) el.style.color = contrastText(node.fill);
    } else {
      el.style.background = '';
      if (node.type === 'sticky' && !node.color) el.style.color = '';
    }

    if (node.type === 'frame') {
      if (node.strokeStyle === 'none') {
        el.style.border = 'none';
      } else if (node.stroke || node.strokeStyle || node.strokeWidth) {
        const width = Math.max(0, Number(node.strokeWidth) || 2);
        const style = node.strokeStyle === 'solid' ? 'solid' : 'dashed';
        el.style.border = width + 'px ' + style + ' ' + (node.stroke || '#b9bfcb');
      } else {
        el.style.border = '';
      }
    }

    el.style.opacity = node.opacity != null ? String(node.opacity) : '';
  }

  // Габариты элемента. У текста и стикера высота — минимальная: при вводе
  // текста элемент растёт вниз сам. У рамки фиксированные ширина и высота.
  function applyNodeBox(el, node) {
    el.style.width = node.w != null ? node.w + 'px' : '';
    const grows = node.type === 'text' || node.type === 'sticky';
    if (grows) {
      el.style.minHeight = node.h != null ? node.h + 'px' : '';
      el.style.height = '';
    } else {
      el.style.minHeight = '';
      el.style.height = node.h != null ? node.h + 'px' : '';
    }
  }

  // Защита от вставки чужого HTML: убираем скрипты и опасные обработчики.
  function sanitizeHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html == null ? '' : String(html);
    tmp.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button')
      .forEach(n => n.remove());
    const walk = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT);
    while (walk.nextNode()) {
      const el = walk.currentNode;
      Array.prototype.slice.call(el.attributes).forEach(a => {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(a.name);
        else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(a.value)) {
          el.removeAttribute(a.name);
        }
      });
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return tmp.innerHTML;
  }

  // Более щадящая очистка для вставки со сторонних сайтов: сохраняем базовое
  // оформление (теги + безопасные инлайн-стили), выкидываем скрипты/опасные URL.
  const PASTE_TAGS = new Set([
    'p', 'div', 'br', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
    'del', 'ins', 'mark', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'hr', 'small', 'big',
    'font', 'center', 'table', 'thead', 'tbody', 'tr', 'td', 'th'
  ]);
  const PASTE_STYLE_PROPS = new Set([
    'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
    'text-align', 'color', 'background-color', 'font-family', 'font-size',
    'line-height', 'vertical-align', 'white-space'
  ]);

  function sanitizePastedHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html == null ? '' : String(html);
    tmp.querySelectorAll('script, style, iframe, object, embed, link, meta, form, ' +
      'input, textarea, select, button, svg, canvas, video, audio, picture, source, img, noscript')
      .forEach(n => n.remove());

    const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT);
    const unwrap = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const tag = el.tagName.toLowerCase();

      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (!/^(https?:|mailto:|\/|#)/i.test(href)) el.removeAttribute('href');
        else { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }

      const style = el.getAttribute('style');
      if (style) {
        const kept = style.split(';').map(s => s.trim()).filter(Boolean).filter(decl => {
          const prop = decl.split(':')[0].trim().toLowerCase();
          return PASTE_STYLE_PROPS.has(prop) && !/url\s*\(|expression|javascript:/i.test(decl);
        });
        if (kept.length) el.setAttribute('style', kept.join('; '));
        else el.removeAttribute('style');
      }

      if (tag === 'font') {
        let extra = '';
        const color = el.getAttribute('color') || '';
        const size = el.getAttribute('size') || '';
        if (color && /^#?[0-9a-f]+$/i.test(color)) extra += 'color:' + (color[0] === '#' ? color : '#' + color) + ';';
        if (size && /^\d+$/.test(size)) extra += 'font-size:' + Math.round(Number(size) * 16 / 3) + 'px;';
        if (extra) el.setAttribute('style', (el.getAttribute('style') || '') + ';' + extra);
      }

      Array.prototype.slice.call(el.attributes).forEach(a => {
        const name = a.name.toLowerCase();
        if (name === 'style' || name === 'colspan' || name === 'rowspan') return;
        if (tag === 'a' && (name === 'href' || name === 'target' || name === 'rel')) return;
        el.removeAttribute(a.name);
      });

      if (!PASTE_TAGS.has(tag)) unwrap.push(el);
    }

    unwrap.forEach(el => {
      const p = el.parentNode;
      if (!p) return;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    });
    return tmp.innerHTML;
  }

  function scheduleTextSave(id) {
    if (!projectId) return;
    clearTimeout(textTimers.get(id));
    textTimers.set(id, setTimeout(() => {
      const n = nodes.get(id);
      if (n) window.Store.updateNode(projectId, id, { text: n.text }).catch(handleError);
    }, 500));
  }

  // --- Создание / размещение элементов ---

  function placeNode(node, focus) {
    nodes.set(node.id, node);
    if (node.type === 'arrow') renderArrow(node);
    else renderNode(node);
    if (projectId) window.Store.addNode(projectId, node).catch(handleError);
    if (focus) {
      const el = nodeEls.get(node.id);
      if (el) {
        el.focus();
        const sel = document.getSelection();
        if (sel) sel.selectAllChildren(el);
      }
    }
  }

  function removeLocalAndRemote(id) {
    removeNodeById(id);
    if (projectId) window.Store.removeNode(projectId, id).catch(handleError);
  }

  function addNode(type, x, y, opts) {
    const user = window.currentUser;
    const node = {
      id: window.Store.uid(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      text: type === 'text' ? 'Текст' : '',
      createdBy: user ? user.uid : 'anon'
    };
    if (type === 'text' || type === 'sticky') {
      if (boardDefaults.fontFamily) node.fontFamily = boardDefaults.fontFamily;
      if (boardDefaults.fontSize) node.fontSize = boardDefaults.fontSize;
    }
    if (type === 'frame') {
      node.figure = (opts && opts.figure) || activeFigure;
      // Стандартный стиль: белая заливка, сплошная тёмная обводка.
      node.fill = '#ffffff';
      node.stroke = '#1a1a1a';
      node.strokeStyle = 'solid';
      node.strokeWidth = 2;
      const size = FIGURE_SIZES[node.figure] || FIGURE_SIZES.rect;
      node.w = size.w;
      node.h = size.h;
    }
    // У стикера «Стикер» — только плейсхолдер, фокус и выделение не нужны.
    const focus = type === 'text';
    placeNode(node, focus);
    pushHistory({
      undo: () => removeLocalAndRemote(node.id),
      redo: () => { placeNode(node, focus); selectOnly(node.id); }
    });
  }

  // --- Изображения ---
  //
  // Firebase Storage требует платный план, поэтому картинку сжимаем в браузере
  // и кладём data URL прямо в документ узла (лимит Firestore — 1 МиБ на документ,
  // а каждый узел — отдельный документ).

  const IMG_DISPLAY_MAX = 420;     // размер на доске по умолчанию (длинная сторона)
  const IMG_SOURCE_MAX = 1400;     // максимум сохраняемой стороны
  const IMG_BUDGET = 600000;       // бюджет длины data URL (лимит Firestore ~1 МиБ)

  let webpOk = null;

  function webpSupported() {
    if (webpOk != null) return webpOk;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      webpOk = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { webpOk = false; }
    return webpOk;
  }

  function loadImageEl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function drawScaled(source, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // Сжимает картинку до бюджета IMG_BUDGET, понижая качество, затем размер.
  async function prepareImageData(file) {
    const img = await loadImageEl(file);
    const ow = img.naturalWidth || img.width;
    const oh = img.naturalHeight || img.height;
    if (!ow || !oh) throw new Error('empty image');

    const scale = Math.min(1, IMG_SOURCE_MAX / Math.max(ow, oh));
    let w = Math.round(ow * scale);
    let h = Math.round(oh * scale);
    let canvas = drawScaled(img, w, h);

    const keepAlpha = /^image\/(png|webp|gif|svg)/i.test(file.type) && webpSupported();
    const mime = keepAlpha ? 'image/webp' : 'image/jpeg';

    let quality = 0.85;
    let dataUrl = canvas.toDataURL(mime, quality);
    while (dataUrl.length > IMG_BUDGET && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL(mime, quality);
    }

    let dim = 1;
    while (dataUrl.length > IMG_BUDGET && dim > 0.35) {
      dim -= 0.15;
      const tw = Math.round(w * dim);
      const th = Math.round(h * dim);
      canvas = drawScaled(canvas, tw, th);
      w = tw; h = th;
      dataUrl = canvas.toDataURL(mime, quality);
    }

    if (dataUrl.length > IMG_BUDGET) throw new Error('image too large');
    return { dataUrl, w, h };
  }

  function pickImageAt(x, y) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) insertImage(f, x, y);
    });
    input.click();
  }

  // Вставляет картинку как элемент доски (data URL в узле).
  async function insertImage(file, x, y) {
    if (!file || !/^image\//.test(file.type)) return;
    let prepared;
    try {
      prepared = await prepareImageData(file);
    } catch (err) {
      console.warn('[image]', err);
      alert('Не удалось вставить изображение: ' + (err.message || err));
      return;
    }

    const disp = drawScale(prepared.w, prepared.h, IMG_DISPLAY_MAX);
    const node = {
      id: window.Store.uid(),
      type: 'image',
      x: Math.round(x),
      y: Math.round(y),
      text: '',
      src: prepared.dataUrl,
      w: disp.w,
      h: disp.h,
      createdBy: window.currentUser ? window.currentUser.uid : 'anon'
    };
    placeNode(node, false);
    selectOnly(node.id);
    refreshSelection();
    pushHistory({
      undo: () => removeLocalAndRemote(node.id),
      redo: () => { placeNode(node, false); selectOnly(node.id); }
    });
  }

  function drawScale(w, h, maxSide) {
    const k = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.round(w * k), h: Math.round(h * k) };
  }

  // --- Выделение ---

  function refreshSelection() {
    const multi = selectedIds.size > 1;
    nodeEls.forEach((el, id) => {
      const on = selectedIds.has(id);
      el.classList.toggle('is-selected', on);
      el.classList.toggle('is-in-group', on && multi);
    });
    arrowEls.forEach((g, id) => g.classList.toggle('is-selected', selectedIds.has(id)));
    updateSelectionBox();
    updateTextToolbar();
  }

  // Рамка вокруг выделения (одиночного или группы) с ручками.
  // Мировые границы узла: для стрелок берём концы и ручки изгиба.
  function worldBoundsOf(n) {
    if (!n) return null;
    if (n.type === 'arrow') {
      const ep = arrowEndpoints(n);
      const geo = arrowGeometry(n);
      let minX = Math.min(ep.x1, ep.x2), minY = Math.min(ep.y1, ep.y2);
      let maxX = Math.max(ep.x1, ep.x2), maxY = Math.max(ep.y1, ep.y2);
      (geo.handles || []).forEach(h => {
        minX = Math.min(minX, h.x); minY = Math.min(minY, h.y);
        maxX = Math.max(maxX, h.x); maxY = Math.max(maxY, h.y);
      });
      const m = 8;
      return { x: minX - m, y: minY - m, x2: maxX + m, y2: maxY + m };
    }
    const el = nodeEls.get(n.id);
    if (!el) return null;
    return {
      x: n.x, y: n.y,
      x2: n.x + (el.offsetWidth || 0),
      y2: n.y + (el.offsetHeight || 0)
    };
  }

  function updateSelectionBox() {
    if (!selBox) return;
    if (selectedIds.size === 0) { selBox.classList.add('hidden'); return; }

    const only = selectedIds.size === 1 ? nodes.get([...selectedIds][0]) : null;
    if (only && only.type === 'arrow') { selBox.classList.add('hidden'); return; }
    if (only && only.type === 'image') { /* картинку тоже можно тянуть за ручки */ }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedIds.forEach(id => {
      const b = worldBoundsOf(nodes.get(id));
      if (!b) return;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x2);
      maxY = Math.max(maxY, b.y2);
    });
    if (!isFinite(minX)) { selBox.classList.add('hidden'); return; }

    const single = selectedIds.size === 1;
    // Для группы немного расширяем рамку, чтобы личные обводки не вылезали.
    const pad = single ? 0 : 6;
    const a = worldToScreen(minX - pad, minY - pad);
    const b = worldToScreen(maxX + pad, maxY + pad);
    selBox.style.left = a.x + 'px';
    selBox.style.top = a.y + 'px';
    selBox.style.width = (b.x - a.x) + 'px';
    selBox.style.height = (b.y - a.y) + 'px';
    selBox.classList.toggle('sel-box--single', single);
    selBox.classList.toggle('sel-box--text', !!(single && only && only.type === 'text'));
    selBox.classList.remove('hidden');
    refreshArrows();
  }

  // --- Тонкие обёртки панели элемента (текст/стрелка) — в js/element-menu.js ---

  function updateTextToolbar() { if (window.ElementMenu) window.ElementMenu.update(); }
  function hideTextToolbar() { if (window.ElementMenu) window.ElementMenu.hide(); }
  function closeToolbarMenu() { if (window.ElementMenu) window.ElementMenu.closeMenu(); }

  function rgbToHex(str) {
    return String(str).replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)/gi, (m, r, g, b) =>
      '#' + [r, g, b].map(n => Number(n).toString(16).padStart(2, '0')).join(''));
  }

  // --- Стрелки-коннекторы ---

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ARROW_DEFAULT_COLOR = '#1a1a1a';
  let arrowDraw = null;   // { fromId, start, cursor, preview }
  let arrowDrag = null;   // { id, kind, axis, ... } — перетаскивание ручки стрелки

  function arrowDash(style) {
    switch (style) {
      case 'dashed': return '10 6';
      case 'dotted': return '1 6';
      case 'dashdot': return '12 5 1 5';
      default: return '';
    }
  }

  function rectOf(id) {
    const n = nodes.get(id);
    const el = nodeEls.get(id);
    if (!n || !el) return null;
    const x = Number(n.x), y = Number(n.y);
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x, y, w: el.offsetWidth || 0, h: el.offsetHeight || 0 };
  }

  // Точка на границе прямоугольника в направлении target.
  function borderPoint(rect, target) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = target.x - cx, dy = target.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const sx = dx ? (rect.w / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (rect.h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  // Ближайшая точка на границе прямоугольника к точке p.
  function nearestBorderPoint(rect, p) {
    const cl = (v, a, b) => Math.max(a, Math.min(v, b));
    const l = Math.abs(p.x - rect.x), r = Math.abs(rect.x + rect.w - p.x);
    const t = Math.abs(p.y - rect.y), bt = Math.abs(rect.y + rect.h - p.y);
    const m = Math.min(l, r, t, bt);
    if (m === l) return { x: rect.x, y: cl(p.y, rect.y, rect.y + rect.h) };
    if (m === r) return { x: rect.x + rect.w, y: cl(p.y, rect.y, rect.y + rect.h) };
    if (m === t) return { x: cl(p.x, rect.x, rect.x + rect.w), y: rect.y };
    return { x: cl(p.x, rect.x, rect.x + rect.w), y: rect.y + rect.h };
  }

  // Ближайшая сторона прямоугольника ('n'/'e'/'s'/'w') и якорь по её середине.
  function sideOf(rect, p) {
    const l = Math.abs(p.x - rect.x);
    const r = Math.abs(rect.x + rect.w - p.x);
    const t = Math.abs(p.y - rect.y);
    const b = Math.abs(rect.y + rect.h - p.y);
    const m = Math.min(l, r, t, b);
    if (m === l) return 'w';
    if (m === r) return 'e';
    if (m === t) return 'n';
    return 's';
  }

  function sideAnchor(rect, p) {
    const side = sideOf(rect, p);
    if (side === 'w') return { ux: -rect.w / 2, uy: 0 };
    if (side === 'e') return { ux: rect.w / 2, uy: 0 };
    if (side === 'n') return { ux: 0, uy: -rect.h / 2 };
    return { ux: 0, uy: rect.h / 2 };
  }

  // Сторона, обращённая к точке p (по направлению из центра, а не по
  // расстоянию до грани — иначе цель по правую руку выбирала бы верх).
  function facingSide(rect, p) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = p.x - cx, dy = p.y - cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w';
    return dy >= 0 ? 's' : 'n';
  }

  // Точка на стенке, обращённой к p. Стенка выбирается направлением, а
  // положение на ней — проекцией p, поэтому стрелка цепляется к любому месту
  // грани, а не только к её середине.
  function sidePoint(rect, p, wallHint) {
    const side = wallHint || facingSide(rect, p);
    const x0 = rect.x, x1 = rect.x + rect.w;
    const y0 = rect.y, y1 = rect.y + rect.h;
    const cl = (v, a, b) => Math.max(a, Math.min(v, b));
    if (side === 'w') return { x: x0, y: cl(p.y, y0, y1) };
    if (side === 'e') return { x: x1, y: cl(p.y, y0, y1) };
    if (side === 'n') return { x: cl(p.x, x0, x1), y: y0 };
    return { x: cl(p.x, x0, x1), y: y1 };
  }

  function outwardOffset(rect, p, amount) {
    const side = sideOf(rect, p);
    if (side === 'w') return { x: -amount, y: 0 };
    if (side === 'e') return { x: amount, y: 0 };
    if (side === 'n') return { x: 0, y: -amount };
    return { x: 0, y: amount };
  }

  function borderNormal(rect, p) {
    const o = outwardOffset(rect, p, 1);
    const len = Math.hypot(o.x, o.y) || 1;
    return { x: o.x / len, y: o.y / len };
  }

  // Магнит при рисовании стрелки: ищем ближайший элемент в радиусе radiusPx
  // и притягиваем конец к его границе.
  function findSnapTarget(clientX, clientY, excludeId, radiusPx) {
    const p = screenToWorld(clientX, clientY);
    const rad = (radiusPx || 18) / view.scale;
    let best = null;
    nodes.forEach(n => {
      if (n.type === 'arrow' || n.id === excludeId) return;
      const rect = rectOf(n.id);
      if (!rect) return;
      if (p.x < rect.x - rad || p.x > rect.x + rect.w + rad) return;
      if (p.y < rect.y - rad || p.y > rect.y + rect.h + rad) return;
      const point = nearestBorderPoint(rect, p);
      const d = Math.hypot(point.x - p.x, point.y - p.y);
      if (!best || d < best.d) best = { id: n.id, point, rect, d };
    });
    return best;
  }

  // Точка привязки конца стрелки на границе элемента. По умолчанию — по
  // направлению к другому концу; если задан якорь (startAnch/endAnch) — по нему.
  function anchorTarget(node, which, rect, otherCenter) {
    const anch = which === 'start' ? node.startAnch : node.endAnch;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    if (anch && (anch.ux || anch.uy)) return { x: cx + anch.ux, y: cy + anch.uy };
    return otherCenter;
  }

  function arrowEndpoints(node) {
    const rf = node.fromId ? rectOf(node.fromId) : null;
    const rt = node.toId ? rectOf(node.toId) : null;
    const ca = rf ? { x: rf.x + rf.w / 2, y: rf.y + rf.h / 2 } : null;
    const cb = rt ? { x: rt.x + rt.w / 2, y: rt.y + rt.h / 2 } : null;
    const freeA = { x: node.x1 || 0, y: node.y1 || 0 };
    const freeB = { x: node.x2 || 0, y: node.y2 || 0 };
    // Прямая стрелка магнитится обеими концами к сторонам, обращённым друг
    // к другу. Если один объект переместить, сторона перевыбирается сама —
    // линия не будет проходить сквозь объекты. Гибкие сохраняют ручной якорь.
    const shape = node.shape || 'straight';
    const storedA = rf ? anchorTarget(node, 'start', rf, cb || freeB) : null;
    const storedB = rt ? anchorTarget(node, 'end', rt, ca || freeA) : null;
    // anchorTarget уже возвращает абсолютную точку на грани.
    const storedAPoint = storedA;
    const storedBPoint = storedB;
    // Начало стрелки остаётся там, где его поставил пользователь.
    const rawA = rf ? storedA : freeA;
    // Конец магнитится к той стенке/зоне, куда его притащил пользователь.
    const rawB = rt ? storedB : freeB;
    const a = rf ? borderPoint(rf, rawA) : rawA;
    const b = rt ? borderPoint(rt, rawB) : rawB;
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // Маркеры поворачиваются по касательной самой линии (для всех форм),
  // поэтому при перемещении объекта курсор следует за изгибом стрелки.
  function arrowCapAngles(node, geo, e) {
    return { start: geo.startAngle + Math.PI, end: geo.endAngle };
  }

  // Управляющие точки дуги: направление линии плюс внешняя нормаль,
  // чтобы кривая огибала объекты и её касательная следовала за линией.
  function curveControls(a, b, rf, rt, k) {
    const travel = unit(a, b);
    const na = rf ? borderNormal(rf, a) : { x: -travel.x, y: -travel.y };
    const nb = rt ? borderNormal(rt, b) : { x: -travel.x, y: -travel.y };
    const mix = (p, q) => {
      const v = { x: p.x * 0.6 + q.x * 0.4, y: p.y * 0.6 + q.y * 0.4 };
      const len = Math.hypot(v.x, v.y) || 1;
      return { x: v.x / len, y: v.y / len };
    };
    const d1 = mix(travel, na);
    const d2 = mix(travel, { x: -nb.x, y: -nb.y });
    return {
      c1: { x: a.x + d1.x * k, y: a.y + d1.y * k },
      c2: { x: b.x - d2.x * k, y: b.y - d2.y * k },
      d1, d2
    };
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVGNS, name);
    if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    return el;
  }

  function addCap(group, x, y, angle, type, color) {
    if (!type || type === 'none') return;
    const deg = angle * 180 / Math.PI;
    const g = svgEl('g', { transform: 'translate(' + x + ' ' + y + ') rotate(' + deg + ')' });
    if (type === 'arrow') {
      g.appendChild(svgEl('path', { d: 'M0 0 L-12 -6 L-12 6 Z', fill: color }));
    } else if (type === 'triangle') {
      g.appendChild(svgEl('path', { d: 'M0 0 L-13 -8 L-13 8 Z', fill: 'none', stroke: color, 'stroke-width': 1.5 }));
    } else if (type === 'circle') {
      g.appendChild(svgEl('circle', { cx: -6, cy: 0, r: 5, fill: color }));
    } else if (type === 'diamond') {
      g.appendChild(svgEl('path', { d: 'M0 0 L-7 -5 L-14 0 L-7 5 Z', fill: 'none', stroke: color, 'stroke-width': 1.5 }));
    }
    group.appendChild(g);
  }

  function unit(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  // Ломаная с скруглёнными углами (для формы «гибкая с прямыми углами»).
  function roundedPath(pts, r) {
    if (pts.length < 3) {
      const a = pts[0], b = pts[pts.length - 1];
      return 'M ' + a.x + ' ' + a.y + ' L ' + b.x + ' ' + b.y;
    }
    let d = 'M ' + pts[0].x + ' ' + pts[0].y;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const vIn = unit(p1, p0), vOut = unit(p1, p2);
      const lenIn = Math.hypot(p0.x - p1.x, p0.y - p1.y) / 2;
      const lenOut = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
      const rIn = Math.min(r, lenIn), rOut = Math.min(r, lenOut);
      const a = { x: p1.x + vIn.x * rIn, y: p1.y + vIn.y * rIn };
      const b = { x: p1.x + vOut.x * rOut, y: p1.y + vOut.y * rOut };
      d += ' L ' + a.x + ' ' + a.y + ' Q ' + p1.x + ' ' + p1.y + ' ' + b.x + ' ' + b.y;
    }
    const last = pts[pts.length - 1];
    d += ' L ' + last.x + ' ' + last.y;
    return d;
  }

  // Сторона, к которой примыкает точка: 'h' — вертикальная грань (вход
  // горизонтальный), 'v' — горизонтальная грань (вход вертикальный).
  function attachOrient(rect, pt) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    return Math.abs(pt.x - cx) >= Math.abs(pt.y - cy) ? 'h' : 'v';
  }

  // Геометрия стрелки по её форме. Возвращает path, углы наконечников
  // и ручки: начало, изгиб (для elbow), конец.
  function arrowGeometry(node) {
    const e = arrowEndpoints(node);
    const ax = e.x1, ay = e.y1, bx = e.x2, by = e.y2;
    const dx = bx - ax, dy = by - ay;
    const shape = node.shape || 'straight';
    const rf = node.fromId ? rectOf(node.fromId) : null;
    const rt = node.toId ? rectOf(node.toId) : null;

    if (shape === 'curved') {
      const dist = Math.hypot(dx, dy);
      const k = Math.max(40, Math.min(180, dist * 0.35));
      const ctrl = curveControls({ x: ax, y: ay }, { x: bx, y: by }, rf, rt, k);
      const startAngle = Math.atan2(ctrl.c1.y - ay, ctrl.c1.x - ax);
      const endAngle = Math.atan2(by - ctrl.c2.y, bx - ctrl.c2.x);
      return {
        path: 'M ' + ax + ' ' + ay + ' C ' + ctrl.c1.x + ' ' + ctrl.c1.y + ' ' +
          ctrl.c2.x + ' ' + ctrl.c2.y + ' ' + bx + ' ' + by,
        startAngle, endAngle,
        handles: [
          { kind: 'start', x: ax, y: ay, axis: 'xy' },
          { kind: 'end', x: bx, y: by, axis: 'xy' }
        ]
      };
    }

    if (shape === 'curved-manual') {
      // Точки лежат на самой кривой: сплайн Catmull–Rom проходит через них.
      const a = { x: ax, y: ay }, b = { x: bx, y: by };
      let mid = [];
      if (Array.isArray(node.manualPoints) && node.manualPoints.length) {
        mid = node.manualPoints
          .filter(p => p && isFinite(p.x) && isFinite(p.y))
          .map(p => ({ x: p.x, y: p.y }));
      } else if (node.c1 || node.c2) {
        if (node.c1) mid.push({ x: node.c1.x, y: node.c1.y });
        if (node.c2) mid.push({ x: node.c2.x, y: node.c2.y });
      } else {
        const dist = Math.hypot(dx, dy);
        const k = Math.max(40, Math.min(180, dist * 0.35));
        const ctrl = curveControls(a, b, rf, rt, k);
        mid = [ctrl.c1, ctrl.c2];
      }
      const all = [a].concat(mid, [b]);
      const segs = [];
      let d = 'M ' + all[0].x + ' ' + all[0].y;
      for (let i = 0; i < all.length - 1; i++) {
        const p0 = all[i - 1] || all[i];
        const p1 = all[i], p2 = all[i + 1];
        const p3 = all[i + 2] || all[i + 1];
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
        const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
        d += ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + p2.x + ' ' + p2.y;
        segs.push({ p0, p1, c1, c2 });
      }
      const first = segs[0], last = segs[segs.length - 1];
      const startAngle = Math.atan2(first.c1.y - a.y, first.c1.x - a.x);
      const endAngle = Math.atan2(b.y - last.c2.y, b.x - last.c2.x);
      const handles = [{ kind: 'start', x: a.x, y: a.y, axis: 'xy' }];
      mid.forEach((p, i) => handles.push({ kind: 'point', index: i, x: p.x, y: p.y, axis: 'xy' }));
      handles.push({ kind: 'end', x: b.x, y: b.y, axis: 'xy' });
      return { path: d, startAngle, endAngle, handles, segments: segs };
    }

    if (shape === 'elbow') {
      const bend = node.bend || 0;
      const oA = rf ? attachOrient(rf, { x: ax, y: ay }) : null;
      const oB = rt ? attachOrient(rt, { x: bx, y: by }) : null;
      const mixedHV = oA === 'h' && oB === 'v';
      const mixedVH = oA === 'v' && oB === 'h';
      let pts, hMid;
      if (mixedHV || mixedVH) {
        // Г-образный маршрут: угол задан однозначно.
        const cor = { x: mixedHV ? bx : ax, y: mixedHV ? ay : by };
        pts = [{ x: ax, y: ay }, cor, { x: bx, y: by }];
        hMid = null;
      } else {
        let horiz;
        if (oA === 'h' || oB === 'h') horiz = true;
        else if (oA === 'v' || oB === 'v') horiz = false;
        else horiz = Math.abs(dx) >= Math.abs(dy);
        if (horiz) {
          let midX = (ax + bx) / 2 + bend;
          // Ломаная огибает объект, если конец прикреплён к вертикальной грани.
          if (rt && oB === 'h') {
            const side = sideOf(rt, { x: bx, y: by });
            if (side === 'w') midX = Math.min(midX, rt.x - 32);
            if (side === 'e') midX = Math.max(midX, rt.x + rt.w + 32);
          }
          if (rf && oA === 'h') {
            const side = sideOf(rf, { x: ax, y: ay });
            if (side === 'w') midX = Math.min(midX, rf.x - 32);
            if (side === 'e') midX = Math.max(midX, rf.x + rf.w + 32);
          }
          pts = [{ x: ax, y: ay }, { x: midX, y: ay }, { x: midX, y: by }, { x: bx, y: by }];
          hMid = { kind: 'bend', x: midX, y: (ay + by) / 2, axis: 'x' };
        } else {
          let midY = (ay + by) / 2 + bend;
          if (rt && oB === 'v') {
            const side = sideOf(rt, { x: bx, y: by });
            if (side === 'n') midY = Math.min(midY, rt.y - 32);
            if (side === 's') midY = Math.max(midY, rt.y + rt.h + 32);
          }
          if (rf && oA === 'v') {
            const side = sideOf(rf, { x: ax, y: ay });
            if (side === 'n') midY = Math.min(midY, rf.y - 32);
            if (side === 's') midY = Math.max(midY, rf.y + rf.h + 32);
          }
          pts = [{ x: ax, y: ay }, { x: ax, y: midY }, { x: bx, y: midY }, { x: bx, y: by }];
          hMid = { kind: 'bend', x: (ax + bx) / 2, y: midY, axis: 'y' };
        }
      }
      const handles = [{ kind: 'start', x: ax, y: ay, axis: 'xy' }];
      if (hMid) handles.push(hMid);
      handles.push({ kind: 'end', x: bx, y: by, axis: 'xy' });
      const startAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      const n = pts.length;
      const endAngle = Math.atan2(pts[n - 1].y - pts[n - 2].y, pts[n - 1].x - pts[n - 2].x);
      return { path: roundedPath(pts, 12), startAngle, endAngle, handles };
    }

    // straight
    const ang = Math.atan2(dy, dx);
    return {
      path: 'M ' + ax + ' ' + ay + ' L ' + bx + ' ' + by,
      startAngle: ang, endAngle: ang,
      handles: [
        { kind: 'start', x: ax, y: ay, axis: 'xy' },
        { kind: 'end', x: bx, y: by, axis: 'xy' }
      ]
    };
  }

  function renderArrow(node) {
    if (!arrowLayer || arrowEls.has(node.id)) return;
    const g = svgEl('g', { class: 'arrow' });
    g.dataset.id = node.id;
    g.appendChild(svgEl('path', { class: 'arrow__line' }));
    g.appendChild(svgEl('path', { class: 'arrow__hit' }));
    g.appendChild(svgEl('g', { class: 'arrow__caps' }));
    const addHandle = (kind, index) => {
      const h = svgEl('g', { class: 'arrow__handle', 'data-kind': kind });
      if (index != null) h.setAttribute('data-index', String(index));
      h.appendChild(svgEl('circle', { class: 'arrow__hitarea', r: 9 }));
      // Все маркеры — обычные точки, а не мини-стрелочки.
      h.appendChild(svgEl('circle', {
        class: 'arrow__dot',
        r: (kind === 'start' || kind === 'end') ? 4.5 : 3.5
      }));
      g.appendChild(h);
    };
    addHandle('start');
    addHandle('bend');
    for (let i = 0; i < 12; i++) addHandle('point', i);
    addHandle('end');
    arrowLayer.appendChild(g);
    arrowEls.set(node.id, g);
    updateArrow(node);
  }

  function updateArrow(node) {
    const g = arrowEls.get(node.id);
    if (!g) return;
    const geo = arrowGeometry(node);
    const color = node.color || ARROW_DEFAULT_COLOR;
    const line = g.querySelector('.arrow__line');
    const hit = g.querySelector('.arrow__hit');
    [line, hit].forEach(p => p.setAttribute('d', geo.path));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', 1.5);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-dasharray', arrowDash(node.lineStyle));

    const caps = g.querySelector('.arrow__caps');
    while (caps.firstChild) caps.removeChild(caps.firstChild);
    const e = arrowEndpoints(node);
    const capAngles = arrowCapAngles(node, geo, e);
    addCap(caps, e.x1, e.y1, capAngles.start, node.startCap || 'none', color);
    addCap(caps, e.x2, e.y2, capAngles.end, node.endCap || 'arrow', color);

    const handles = geo.handles || [];
    const selectors = [{ kind: 'start' }, { kind: 'bend' }];
    for (let i = 0; i < 12; i++) selectors.push({ kind: 'point', index: i });
    selectors.push({ kind: 'end' });
    selectors.forEach(sel => {
      const el = g.querySelector('.arrow__handle[data-kind="' + sel.kind + '"]' +
        (sel.index != null ? '[data-index="' + sel.index + '"]' : ''));
      if (!el) return;
      const h = handles.find(x => x.kind === sel.kind &&
        (sel.index == null || x.index === sel.index));
      if (h) {
        const angle = sel.kind === 'start' ? capAngles.start : sel.kind === 'end' ? capAngles.end : 0;
        el.setAttribute('transform',
          'translate(' + h.x + ' ' + h.y + ') rotate(' + angle * 180 / Math.PI + ')');
        el.setAttribute('data-axis', h.axis);
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    });
    g.classList.toggle('is-selected', selectedIds.has(node.id));
  }

  function refreshArrows() {
    nodes.forEach(n => { if (n.type === 'arrow') updateArrow(n); });
  }

  function removeArrowEl(id) {
    const g = arrowEls.get(id);
    if (g) g.remove();
    arrowEls.delete(id);
  }

  function setArrowStyle(id, patch, live) {
    const n = nodes.get(id);
    if (!n || n.type !== 'arrow') return;
    if (patch.shape) setActiveArrowShape(patch.shape);
    const before = {};
    Object.keys(patch).forEach(k => { before[k] = n[k]; });
    Object.assign(n, patch);
    updateArrow(n);
    if (projectId) window.Store.updateNode(projectId, id, patch).catch(handleError);
    if (!live) {
      const applyArrowPatch = values => {
        const nn = nodes.get(id);
        if (!nn) return;
        Object.assign(nn, values);
        updateArrow(nn);
        if (projectId) window.Store.updateNode(projectId, id, values).catch(() => {});
      };
      pushHistory({
        undo: () => applyArrowPatch(before),
        redo: () => applyArrowPatch(patch)
      });
    }
  }

  function createArrow(fromId, toId, freeX, freeY, opts) {
    opts = opts || {};
    const shape = opts.shape || (window.Settings ? window.Settings.arrowShape() : 'straight');
    const node = {
      id: window.Store.uid(),
      type: 'arrow',
      x: Math.round(freeX || 0),
      y: Math.round(freeY || 0),
      fromId: fromId || null,
      toId: toId || null,
      x1: opts.start ? Math.round(opts.start.x) : 0,
      y1: opts.start ? Math.round(opts.start.y) : 0,
      x2: Math.round(freeX || 0),
      y2: Math.round(freeY || 0),
      color: ARROW_DEFAULT_COLOR,
      lineStyle: 'solid',
      startCap: 'none',
      endCap: 'arrow',
      shape,
      startAnch: opts.startAnch || null,
      endAnch: opts.endAnch || null,
      createdBy: window.currentUser ? window.currentUser.uid : 'anon'
    };
    placeNode(node, false);
    selectOnly(node.id);
    refreshSelection();
  }

  // --- Интерактивное рисование стрелки из шарика ---

  function startArrowDraw(e, fromId) {
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const rf = rectOf(fromId);
    const grab = screenToWorld(e.clientX, e.clientY);
    const start = rf ? borderPoint(rf, grab) : grab;
    const preview = svgEl('line', {
      x1: start.x, y1: start.y, x2: start.x, y2: start.y,
      stroke: '#4262ff', 'stroke-width': 2, 'stroke-dasharray': '6 4',
      'stroke-linecap': 'round', 'pointer-events': 'none'
    });
    if (arrowLayer) arrowLayer.appendChild(preview);
    // Свободная стрелка (начало в пустом месте) не должна зависеть от фигур.
    arrowDraw = { fromId, free: !fromId, start, cursor: start, preview, snap: null, hiEl: null };
    viewport.style.cursor = 'crosshair';
  }

  function updateArrowDraw(e) {
    if (!arrowDraw) return;
    const p = screenToWorld(e.clientX, e.clientY);
    const a = arrowDraw.start;

    const snap = arrowDraw.free ? null : findSnapTarget(e.clientX, e.clientY, arrowDraw.fromId);
    if (arrowDraw.hiEl && (!snap || arrowDraw.hiEl !== nodeEls.get(snap.id))) {
      arrowDraw.hiEl.classList.remove('arrow-target');
      arrowDraw.hiEl = null;
    }
    if (snap) {
      arrowDraw.hiEl = nodeEls.get(snap.id) || null;
      if (arrowDraw.hiEl) arrowDraw.hiEl.classList.add('arrow-target');
    }
    arrowDraw.snap = snap;
    let end = snap ? snap.point : p;
    if (!isFinite(end.x) || !isFinite(end.y)) end = p;
    arrowDraw.cursor = end;

    const pr = arrowDraw.preview;
    pr.setAttribute('x1', a.x); pr.setAttribute('y1', a.y);
    pr.setAttribute('x2', end.x); pr.setAttribute('y2', end.y);
  }

  // Перетаскивание ручек стрелки: изгиб (bend) и якоря начала/конца.
  function startArrowDrag(e, id, kind, axis, index) {
    const n = nodes.get(id);
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    const ep = arrowEndpoints(n);
    arrowDrag = {
      id, kind, axis: axis || 'xy',
      index: index != null ? Number(index) : null,
      startX: e.clientX, startY: e.clientY,
      base: { bend: n.bend || 0, x1: n.x1 || 0, y1: n.y1 || 0, x2: n.x2 || 0, y2: n.y2 || 0 },
      baseFromId: n.fromId || null,
      baseToId: n.toId || null,
      baseStartAnch: n.startAnch ? { ux: n.startAnch.ux, uy: n.startAnch.uy } : null,
      baseEndAnch: n.endAnch ? { ux: n.endAnch.ux, uy: n.endAnch.uy } : null,
      baseC1: null,
      baseC2: null,
      basePoint: null,
      baseManualPoints: Array.isArray(n.manualPoints)
        ? n.manualPoints.map(p => ({ x: p.x, y: p.y })) : null,
      epStart: { x: ep.x1, y: ep.y1 },
      epEnd: { x: ep.x2, y: ep.y2 },
      hiEl: null
    };
    // Если ручная точка ещё не сохранена — берём её текущее вычисленное
    // положение, иначе первый drag прыгнет в ноль.
    const geo = arrowGeometry(n);
    const hp = (geo.handles || []).find(h => h.kind === 'point' && h.index === arrowDrag.index);
    if (arrowDrag.kind === 'point' && !arrowDrag.basePoint && hp) {
      arrowDrag.basePoint = { x: hp.x, y: hp.y };
    }
    viewport.style.cursor = axis === 'y' ? 'ns-resize' : axis === 'x' ? 'ew-resize' : 'move';
  }

  // Та же подсветка цели, что и при рисовании новой стрелки.
  function setArrowTargetHighlight(state, snap) {
    const el = snap ? nodeEls.get(snap.id) : null;
    if (state.hiEl && state.hiEl !== el) {
      state.hiEl.classList.remove('arrow-target');
      state.hiEl = null;
    }
    if (el) {
      state.hiEl = el;
      el.classList.add('arrow-target');
    }
  }

  function applyEndpointDrag(n, which, r, mx, my) {
    const anchored = which === 'start' ? !!n.fromId : !!n.toId;
    const baseEP = which === 'start' ? r.epStart : r.epEnd;
    const px = baseEP.x + mx, py = baseEP.y + my;
    if (anchored) {
      const rect = rectOf(which === 'start' ? n.fromId : n.toId);
      if (!rect) return;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      // Прямая: стенка навстречу другому концу, позиция на ней — по курсору.
      // Гибные продолжают скользить по границе (огибают объект).
      // Конец следует за курсором по границе объекта — магнетизм без
      // авто-подмены стенки.
      const dir = { ux: px - cx, uy: py - cy };
      if (which === 'start') n.startAnch = dir; else n.endAnch = dir;
    } else if (which === 'start') {
      n.x1 = Math.round(r.base.x1 + mx);
      n.y1 = Math.round(r.base.y1 + my);
    } else {
      n.x2 = Math.round(r.base.x2 + mx);
      n.y2 = Math.round(r.base.y2 + my);
    }
  }

  function updateArrowDrag(e) {
    const r = arrowDrag;
    const n = r && nodes.get(r.id);
    if (!n) return;
    const dx = (e.clientX - r.startX) / view.scale;
    const dy = (e.clientY - r.startY) / view.scale;
    if (r.kind === 'point' && r.basePoint) {
      const pts = Array.isArray(n.manualPoints) ? n.manualPoints.slice() : [];
      const base = r.basePoint;
      pts[r.index] = { x: Math.round(base.x + dx), y: Math.round(base.y + dy) };
      n.manualPoints = pts;
    } else if (r.kind === 'bend') {
      n.bend = Math.round((r.base.bend || 0) + (r.axis === 'y' ? dy : dx));
    } else {
      // При перетаскивании конца ищем объект под курсором: можно перекинуть
      // стрелку на другой объект или перевести её на другую сторону того же.
      const exclude = r.kind === 'start' ? n.toId : n.fromId;
      const snap = findSnapTarget(e.clientX, e.clientY, exclude);
      setArrowTargetHighlight(r, snap);
      if (snap) {
        const rect = snap.rect;
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        const anch = { ux: snap.point.x - cx, uy: snap.point.y - cy };
        if (r.kind === 'start') {
          n.fromId = snap.id;
          n.startAnch = anch;
          n.x1 = Math.round(snap.point.x);
          n.y1 = Math.round(snap.point.y);
        } else {
          n.toId = snap.id;
          n.endAnch = anch;
          n.x2 = Math.round(snap.point.x);
          n.y2 = Math.round(snap.point.y);
        }
      } else {
        const mx = r.axis === 'y' ? 0 : dx;
        const my = r.axis === 'x' ? 0 : dy;
        if (r.kind === 'start' || r.kind === 'end') {
          // Утащили конец с объекта на пустое место — открепляем его.
          const isStart = r.kind === 'start';
          const ep = isStart ? r.epStart : r.epEnd;
          n[isStart ? 'fromId' : 'toId'] = null;
          n[isStart ? 'startAnch' : 'endAnch'] = null;
          n[isStart ? 'x1' : 'x2'] = Math.round(ep.x + mx);
          n[isStart ? 'y1' : 'y2'] = Math.round(ep.y + my);
        } else {
          applyEndpointDrag(n, r.kind, r, mx, my);
        }
      }
    }
    updateArrow(n);
  }

  function endArrowDrag() {
    if (!arrowDrag) return;
    const r = arrowDrag;
    arrowDrag = null;
    if (r.hiEl) r.hiEl.classList.remove('arrow-target');
    viewport.style.cursor = '';
    const n = nodes.get(r.id);
    if (!n) return;
    const before = {
      bend: r.base.bend, x1: r.base.x1, y1: r.base.y1, x2: r.base.x2, y2: r.base.y2,
      fromId: r.baseFromId, toId: r.baseToId,
      startAnch: r.baseStartAnch, endAnch: r.baseEndAnch,
      c1: r.baseC1, c2: r.baseC2,
      manualPoints: r.baseManualPoints || null
    };
    const after = {
      bend: n.bend || 0, x1: n.x1 || 0, y1: n.y1 || 0, x2: n.x2 || 0, y2: n.y2 || 0,
      fromId: n.fromId || null, toId: n.toId || null,
      startAnch: n.startAnch || null, endAnch: n.endAnch || null,
      c1: n.c1 ? { x: n.c1.x, y: n.c1.y } : null,
      c2: n.c2 ? { x: n.c2.x, y: n.c2.y } : null,
      manualPoints: Array.isArray(n.manualPoints)
        ? n.manualPoints.map(p => ({ x: p.x, y: p.y })) : null
    };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (projectId) window.Store.updateNode(projectId, r.id, after).catch(handleError);
    const applyArrowGeometry = values => {
      const nn = nodes.get(r.id);
      if (!nn) return;
      Object.assign(nn, values);
      updateArrow(nn);
      if (projectId) window.Store.updateNode(projectId, r.id, values).catch(() => {});
    };
    pushHistory({
      undo: () => applyArrowGeometry(before),
      redo: () => applyArrowGeometry(after)
    });
  }

  function cubicPoint(s, t) {
    const u = 1 - t;
    return {
      x: u * u * u * s.p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p1.x,
      y: u * u * u * s.p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p1.y
    };
  }

  // Добавить новую точку на кривой в месте, ближайшем к курсору.
  function addArrowPoint(id, clientX, clientY) {
    const n = nodes.get(id);
    if (!n || n.shape !== 'curved-manual') return;
    const p = screenToWorld(clientX, clientY);
    const geo = arrowGeometry(n);
    const segs = geo.segments || [];
    let best = null;
    segs.forEach((s, si) => {
      for (let k = 1; k < 24; k++) {
        const q = cubicPoint(s, k / 24);
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || d < best.d) best = { x: q.x, y: q.y, si, d };
      }
    });
    if (!best) return;

    const before = Array.isArray(n.manualPoints)
      ? n.manualPoints.map(q => ({ x: q.x, y: q.y })) : null;
    const pts = before ? before.slice() : [];
    if (!before) {
      (geo.handles || []).forEach(h => {
        if (h.kind === 'point') pts[h.index] = { x: h.x, y: h.y };
      });
      for (let i = pts.length - 1; i >= 0; i--) if (!pts[i]) pts.splice(i, 1);
    }
    pts.splice(Math.min(best.si, pts.length), 0, {
      x: Math.round(best.x), y: Math.round(best.y)
    });

    n.manualPoints = pts;
    const after = pts.map(q => ({ x: q.x, y: q.y }));
    updateArrow(n);
    if (projectId) window.Store.updateNode(projectId, id, { manualPoints: after }).catch(handleError);
    const apply = values => {
      const nn = nodes.get(id);
      if (!nn) return;
      nn.manualPoints = values ? values.map(q => ({ x: q.x, y: q.y })) : null;
      updateArrow(nn);
      if (projectId) window.Store.updateNode(projectId, id, { manualPoints: nn.manualPoints }).catch(() => {});
    };
    pushHistory({ undo: () => apply(before), redo: () => apply(after) });
  }

  function finishArrowDraw(e) {
    if (!arrowDraw) return;
    const fromId = arrowDraw.fromId;
    const free = arrowDraw.free;
    const startPt = arrowDraw.start;
    const p = screenToWorld(e.clientX, e.clientY);
    // Свободная стрелка не ищет фигуры ни в начале, ни в конце.
    const recomputed = free ? null : findSnapTarget(e.clientX, e.clientY, fromId);
    let snap = free ? null : (recomputed || arrowDraw.snap);
    if (arrowDraw.hiEl) arrowDraw.hiEl.classList.remove('arrow-target');
    if (arrowDraw.preview) arrowDraw.preview.remove();
    arrowDraw = null;
    viewport.style.cursor = '';

    const rawEnd = snap ? snap.point : p;
    const a = startPt;
    // Слишком короткая стрелка — игнорируем (случайный клик по шарику).
    if (Math.hypot(rawEnd.x - a.x, rawEnd.y - a.y) < 12) return;

    const shape = activeArrowShape ||
      (window.Settings && window.Settings.arrowShape ? window.Settings.arrowShape() : 'straight');
    const fromRect0 = rectOf(fromId);
    const fromCenter = fromRect0
      ? { x: fromRect0.x + fromRect0.w / 2, y: fromRect0.y + fromRect0.h / 2 }
      : startPt;
    let toId = null;
    let endAnch = null;
    if (snap) {
      toId = snap.id;
      const rect = snap.rect;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      endAnch = { ux: snap.point.x - cx, uy: snap.point.y - cy };
    } else if (!free) {
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      const targetNodeEl = targetEl && targetEl.closest ? targetEl.closest('.canvas-node') : null;
      if (targetNodeEl) {
        const tid = targetNodeEl.dataset.id;
        if (tid && tid !== fromId) toId = tid;
      }
    }

    // Начало стрелки крепим туда, где пользователь взялся за шарик.
    let startAnch = null;
    const rf = rectOf(fromId);
    if (rf) {
      const cx = rf.x + rf.w / 2, cy = rf.y + rf.h / 2;
      // Стартова сторона фиксируется тем, откуда пользователь начал тянуть.
      startAnch = { ux: a.x - cx, uy: a.y - cy };
    }

    createArrow(fromId, toId, rawEnd.x, rawEnd.y, {
      endAnch, startAnch, shape, start: startPt
    });
    const newId = [...selectedIds][0];
    const created = nodes.get(newId) ? snapshot(nodes.get(newId)) : null;
    pushHistory({
      undo: () => removeLocalAndRemote(newId),
      redo: () => { if (created) { placeNode({ ...created }, false); selectOnly(created.id); } }
    });
  }

  // Удаляем стрелки, привязанные к исчезнувшему элементу.
  function cleanupArrowsFor(id) {
    [...arrowEls.keys()].forEach(aid => {
      const n = nodes.get(aid);
      if (n && (n.fromId === id || n.toId === id)) removeLocalAndRemote(aid);
    });
  }

  function selectOnly(id) {
    selectedIds.clear();
    if (id) selectedIds.add(id);
    syncSelection();
  }

  function setSelection(ids) {
    selectedIds.clear();
    ids.forEach(id => selectedIds.add(id));
    syncSelection();
  }

  function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    syncSelection();
  }

  function clearSelection() {
    if (!selectedIds.size) return;
    selectedIds.clear();
    syncSelection();
  }

  // Применяем выделение, пересчитываем блокировки и рассылаем своё выделение.
  function syncSelection() {
    refreshSelection();
    recomputeLocks();
    broadcastSelection();
  }

  // --- Блокировка: узел принадлежит тому, кто его выделил ---

  function selfSession() { return (window.Presence && window.Presence.sessionId) || 'self'; }

  // Владельца выбираем детерминированно (наименьший sessionId), чтобы у всех
  // участников совпадал результат, даже если узел выделили двое.
  function computeLocks() {
    const owners = new Map();
    const colorOf = new Map();
    const nameOf = new Map();
    const me = myIdentity();
    const self = selfSession();
    colorOf.set(self, colorFor(me.uid));
    nameOf.set(self, me.name);

    const claim = (id, sid) => {
      const cur = owners.get(id);
      if (!cur || sid < cur) owners.set(id, sid);
    };
    selectedIds.forEach(id => claim(id, self));
    presenceUsers.forEach(u => {
      if (!u || !u.sessionId) return;
      colorOf.set(u.sessionId, u.color || colorFor(u.uid || u.sessionId));
      nameOf.set(u.sessionId, u.name || 'Гость');
      const sel = Array.isArray(u.sel) ? u.sel : [];
      sel.forEach(id => claim(id, u.sessionId));
    });
    lockState = { owners, colorOf, nameOf, self };
    return lockState;
  }

  function isLockedByOther(id) {
    const o = lockState.owners.get(id);
    return !!o && o !== lockState.self;
  }

  function applyLockState(el, id) {
    const owner = lockState.owners.get(id);
    const lockedByOther = !!owner && owner !== lockState.self;
    el.classList.toggle('is-locked', lockedByOther);
    const n = nodes.get(id);
    const editable = n && (n.type === 'sticky' || n.type === 'text');
    if (lockedByOther) {
      el.style.setProperty('--lock-color', lockState.colorOf.get(owner) || '#ff5a5a');
      el.title = 'Редактирует: ' + (lockState.nameOf.get(owner) || 'другой участник');
      if (el.isContentEditable) el.contentEditable = 'false';
    } else {
      el.style.removeProperty('--lock-color');
      el.removeAttribute('title');
      if (editable && !el.isContentEditable) el.contentEditable = 'true';
    }
  }

  // Возвращает true, если пришлось снять с себя чужую блокировку.
  function recomputeLocks() {
    computeLocks();
    let selChanged = false;
    selectedIds.forEach(id => {
      if (isLockedByOther(id)) { selectedIds.delete(id); selChanged = true; }
    });
    nodeEls.forEach((el, id) => applyLockState(el, id));
    if (selChanged) refreshSelection();
    return selChanged;
  }

  // --- История (только собственные действия) ---

  function pushHistory(entry) {
    if (historyLock) return;
    history.push(entry);
    if (history.length > 200) history.shift();
    // Новое действие ломает цепочку повтора.
    redoStack.length = 0;
  }

  function undo() {
    if (!history.length) return;
    const entry = history.pop();
    historyLock = true;
    try { entry.undo(); } catch (e) { console.error('[undo]', e); }
    historyLock = false;
    if (entry.redo) redoStack.push(entry);
    else redoStack.length = 0;
    // Отмена удаления убирает id из selectedIds внутри removeNodeById, поэтому
    // одного pruneSelection() мало: всегда пересчитываем рамку и панель.
    pruneSelection();
    syncSelection();
  }

  function redo() {
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    historyLock = true;
    try { entry.redo(); } catch (e) { console.error('[redo]', e); }
    historyLock = false;
    history.push(entry);
    pruneSelection();
    syncSelection();
  }

  // Если после отмены часть выделенных элементов исчезла (например, отмена
  // создания/вставки) — убираем их из выделения и перерисовываем рамку.
  function pruneSelection() {
    let changed = false;
    selectedIds.forEach(id => { if (!nodes.has(id)) { selectedIds.delete(id); changed = true; } });
    if (changed) syncSelection();
  }

  // --- Буфер обмена ---

  function snapshot(node) {
    return {
      id: node.id, type: node.type, x: node.x, y: node.y,
      w: node.w, h: node.h, figure: node.figure,
      text: node.text || '', src: node.src, createdBy: node.createdBy,
      fontFamily: node.fontFamily, fontSize: node.fontSize,
      color: node.color, align: node.align,
      fill: node.fill, stroke: node.stroke, strokeStyle: node.strokeStyle,
      strokeWidth: node.strokeWidth, opacity: node.opacity,
      fromId: node.fromId, toId: node.toId,
      x1: node.x1, y1: node.y1, x2: node.x2, y2: node.y2,
      lineStyle: node.lineStyle, startCap: node.startCap, endCap: node.endCap,
      shape: node.shape, bend: node.bend,
      c1: node.c1, c2: node.c2,
      manualPoints: node.manualPoints
        ? node.manualPoints.map(p => ({ x: p.x, y: p.y })) : null,
      startAnch: node.startAnch, endAnch: node.endAnch
    };
  }

  // Переводим data URL узла-картинки в PNG-блоб: PNG понимают Discord,
  // Telegram, почта и другие приложения, куда пользователь вставит картинку.
  function imageSrcToPngBlob(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width || 1;
          c.height = img.naturalHeight || img.height || 1;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(blob => blob ? resolve(blob) : reject(new Error('пустой PNG')), 'image/png');
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('не удалось прочитать изображение'));
      img.src = src;
    });
  }

  // Помимо внутреннего буфера доски кладём картинку в системный буфер,
  // чтобы её можно было вставить в другое приложение (например, Discord).
  async function writeImagesToSystemClipboard(snapshots) {
    if (!navigator.clipboard || !navigator.clipboard.write ||
        typeof ClipboardItem === 'undefined') return;
    const images = snapshots.filter(n => n && n.type === 'image' && n.src).slice(0, 5);
    if (!images.length) return;
    const writeItems = values => navigator.clipboard.write(
      values.map(value => new ClipboardItem({ 'image/png': value }))
    );

    try {
      // Promise внутри ClipboardItem можно отдать сразу — вызов остаётся
      // внутри пользовательского жеста (Ctrl+C / пункт меню).
      await writeItems(images.map(n => imageSrcToPngBlob(n.src)));
    } catch (err) {
      // Некоторые браузеры не принимают Promise в ClipboardItem — повторяем
      // уже с готовыми блобами.
      try {
        const blobs = await Promise.all(images.map(n => imageSrcToPngBlob(n.src)));
        await writeItems(blobs);
      } catch (err2) {
        console.warn('[clipboard] не удалось записать изображение в системный буфер:', err2);
      }
    }
  }

  function copySelected() {
    clipboard = [...selectedIds].map(id => nodes.get(id)).filter(Boolean).map(snapshot);
    writeImagesToSystemClipboard(clipboard);
  }

  function cutSelected() {
    if (!selectedIds.size) return;
    copySelected();
    deleteSelected();
  }

  function pasteClipboard(atWorld) {
    if (!clipboard.length) return;
    let minX = Infinity, minY = Infinity;
    clipboard.forEach(s => {
      minX = Math.min(minX, Number(s.x) || 0);
      minY = Math.min(minY, Number(s.y) || 0);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    // Offset: либо к курсору (верхний левый угол группы), либо +24.
    const dx = atWorld ? Math.round(atWorld.x - minX) : 24;
    const dy = atWorld ? Math.round(atWorld.y - minY) : 24;
    const created = clipboard.map(s => {
      const c = { ...s, id: window.Store.uid(), x: (Number(s.x) || 0) + dx, y: (Number(s.y) || 0) + dy };
      if (c.type === 'arrow') {
        c.x1 = (Number(s.x1) || 0) + dx; c.y1 = (Number(s.y1) || 0) + dy;
        c.x2 = (Number(s.x2) || 0) + dx; c.y2 = (Number(s.y2) || 0) + dy;
      }
      return c;
    });
    created.forEach(n => placeNode(n, false));
    setSelection(created.map(n => n.id));
    pushHistory({
      undo: () => created.forEach(n => removeLocalAndRemote(n.id)),
      redo: () => {
        created.forEach(n => placeNode({ ...n }, false));
        setSelection(created.map(n => n.id));
      }
    });
  }

  function deleteSelected() {
    if (!selectedIds.size) return;
    const snaps = [];
    selectedIds.forEach(id => { const n = nodes.get(id); if (n) snaps.push(snapshot(n)); });
    if (!snaps.length) return;
    historyLock = true;
    snaps.forEach(s => removeLocalAndRemote(s.id));
    historyLock = false;
    selectedIds.clear();
    syncSelection();
    pushHistory({
      undo: () => { snaps.forEach(s => placeNode({ ...s }, false)); setSelection(snaps.map(s => s.id)); },
      redo: () => { snaps.forEach(s => removeLocalAndRemote(s.id)); selectedIds.clear(); }
    });
  }

  function duplicateSelected() {
    if (!selectedIds.size) return;
    const snaps = [];
    selectedIds.forEach(id => { const n = nodes.get(id); if (n) snaps.push(snapshot(n)); });
    if (!snaps.length) return;
    const created = snaps.map(s => {
      const c = { ...s, id: window.Store.uid(), x: (s.x || 0) + 24, y: (s.y || 0) + 24 };
      if (c.type === 'arrow') { c.x2 = (s.x2 || 0) + 24; c.y2 = (s.y2 || 0) + 24; }
      return c;
    });
    created.forEach(n => placeNode(n, false));
    setSelection(created.map(n => n.id));
    pushHistory({
      undo: () => created.forEach(n => removeLocalAndRemote(n.id)),
      redo: () => {
        created.forEach(n => placeNode({ ...n }, false));
        setSelection(created.map(n => n.id));
      }
    });
  }

  // --- Выравнивание и распределение выделенных элементов ---

  function alignableNodes() {
    const list = [];
    selectedIds.forEach(id => {
      const n = nodes.get(id);
      const el = nodeEls.get(id);
      if (n && el && n.type !== 'arrow') list.push({ n, el });
    });
    return list;
  }

  function selectionBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedIds.forEach(id => {
      const b = worldBoundsOf(nodes.get(id));
      if (!b) return;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x2);
      maxY = Math.max(maxY, b.y2);
    });
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function restorePositions(before) {
    before.forEach(o => {
      const nn = nodes.get(o.id);
      const ne = nodeEls.get(o.id);
      if (nn) { nn.x = o.x; nn.y = o.y; }
      if (ne && nn) { ne.style.left = nn.x + 'px'; ne.style.top = nn.y + 'px'; }
      if (projectId) window.Store.updateNode(projectId, o.id, { x: o.x, y: o.y }).catch(() => {});
    });
    updateSelectionBox();
    refreshArrows();
    if (window.ElementMenu) window.ElementMenu.update();
  }

  function alignSelection(mode) {
    const list = alignableNodes();
    if (list.length < 2) return;
    const b = selectionBounds();
    if (!b) return;
    const before = list.map(({ n }) => ({ id: n.id, x: n.x, y: n.y }));
    list.forEach(({ n, el }) => {
      const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
      if (mode === 'left') n.x = Math.round(b.x);
      else if (mode === 'center') n.x = Math.round(b.x + (b.w - w) / 2);
      else if (mode === 'right') n.x = Math.round(b.x + b.w - w);
      else if (mode === 'top') n.y = Math.round(b.y);
      else if (mode === 'middle') n.y = Math.round(b.y + (b.h - h) / 2);
      else if (mode === 'bottom') n.y = Math.round(b.y + b.h - h);
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      if (projectId) window.Store.updateNode(projectId, n.id, { x: n.x, y: n.y }).catch(handleError);
    });
    updateSelectionBox();
    refreshArrows();
    if (window.ElementMenu) window.ElementMenu.update();
    const after = list.map(({ n }) => ({ id: n.id, x: n.x, y: n.y }));
    pushHistory({
      undo: () => restorePositions(before),
      redo: () => restorePositions(after)
    });
  }

  function distributeSelection(axis) {
    const list = alignableNodes();
    if (list.length < 3) return;
    const horiz = axis === 'h';
    const before = list.map(({ n }) => ({ id: n.id, x: n.x, y: n.y }));
    const items = list.map(({ n, el }) => ({
      n, el,
      size: (horiz ? el.offsetWidth : el.offsetHeight) || 0,
      pos: horiz ? n.x : n.y
    }));
    items.sort((a, b) => a.pos - b.pos);
    const first = items[0], last = items[items.length - 1];
    const start = horiz ? first.n.x : first.n.y;
    const end = horiz ? last.n.x + last.size : last.n.y + last.size;
    const sum = items.reduce((s, it) => s + it.size, 0);
    const gap = (end - start - sum) / (items.length - 1);
    let cursor = start;
    items.forEach(it => {
      if (horiz) it.n.x = Math.round(cursor); else it.n.y = Math.round(cursor);
      it.el.style.left = it.n.x + 'px';
      it.el.style.top = it.n.y + 'px';
      if (projectId) window.Store.updateNode(projectId, it.n.id, { x: it.n.x, y: it.n.y }).catch(handleError);
      cursor += it.size + gap;
    });
    updateSelectionBox();
    refreshArrows();
    if (window.ElementMenu) window.ElementMenu.update();
    const after = list.map(({ n }) => ({ id: n.id, x: n.x, y: n.y }));
    pushHistory({
      undo: () => restorePositions(before),
      redo: () => restorePositions(after)
    });
  }

  // Сброс изображения к «оригинальному» размеру (с ограничением по стороне).
  function resetImageSize(id) {
    const n = nodes.get(id);
    const el = nodeEls.get(id);
    if (!n || n.type !== 'image' || !n.src) return;
    const before = { w: n.w, h: n.h };
    const img = new Image();
    img.onload = () => {
      const size = drawScale(img.naturalWidth || img.width, img.naturalHeight || img.height, IMG_DISPLAY_MAX);
      n.w = size.w;
      n.h = size.h;
      const after = { w: n.w, h: n.h };
      if (el) applyNodeBox(el, n);
      updateSelectionBox();
      refreshArrows();
      if (projectId) window.Store.updateNode(projectId, id, after).catch(handleError);
      const applySize = value => {
        const nn = nodes.get(id);
        if (nn) { nn.w = value.w; nn.h = value.h; }
        const ne = nodeEls.get(id);
        if (ne && nn) applyNodeBox(ne, nn);
        updateSelectionBox();
        refreshArrows();
        if (projectId) window.Store.updateNode(projectId, id, value).catch(handleError);
      };
      pushHistory({
        undo: () => applySize(before),
        redo: () => applySize(after)
      });
    };
    img.src = n.src;
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

  // Одному пользователю — один курсор (даже если открыто несколько вкладок):
  // оставляем сессию с самой свежей активностью.
  function dedupeCursors(users) {
    const byUid = new Map();
    users.forEach(u => {
      if (!u || !u.sessionId) return;
      if (u.x == null || u.y == null) return;   // без позиции курсора показывать нечего
      const key = u.uid || u.sessionId;
      const prev = byUid.get(key);
      if (!prev || (u.updatedAt || 0) >= (prev.updatedAt || 0)) byUid.set(key, u);
    });
    return [...byUid.values()];
  }

  function renderCursors(users) {
    presenceUsers = Array.isArray(users) ? users : [];
    const layer = document.getElementById('cursors');
    const alive = new Set();

    if (layer) {
      dedupeCursors(presenceUsers).forEach(u => {
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
    maybeGoLive();
    // Чужое выделение могло измениться — пересчитываем блокировки и подсветку.
    if (recomputeLocks()) broadcastSelection();
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

  // Единый payload присутствия: профиль + последняя позиция курсора + выделение.
  function presencePayload(extra) {
    const base = latestPresence || {};
    const payload = { ...myProfile(), sel: [...selectedIds], updatedAt: Date.now() };
    if (base.x != null) payload.x = base.x;
    if (base.y != null) payload.y = base.y;
    return Object.assign(payload, extra || {});
  }

  function sendJoinPresence() {
    latestPresence = presencePayload();
    window.Presence.update(projectId, latestPresence);
  }

  function sendHeartbeat() {
    if (!projectId) return;
    if (!latestPresence) { sendJoinPresence(); return; }
    latestPresence = presencePayload();
    window.Presence.update(projectId, latestPresence);
  }

  // Мгновенно рассылаем своё выделение (для чужой подсветки и блокировки).
  function broadcastSelection() {
    if (!projectId || !window.Presence.enabled()) return;
    lastPresenceSent = Date.now();
    latestPresence = presencePayload();
    window.Presence.update(projectId, latestPresence);
  }

  // Позиция курсора для отправки: берём из события, иначе — последнюю известную.
  function cursorPoint(e) {
    if (e && typeof e.clientX === 'number') {
      lastCursorWorld = screenToWorld(e.clientX, e.clientY);
    }
    return lastCursorWorld;
  }

  // Отправляет позицию курсора в ответ на действие пользователя (клик,
  // перетаскивание, зум…). С троттлингом, чтобы не спамить базу.
  function pushCursor(e, immediate) {
    if (!projectId || !window.Presence.enabled()) return;
    const p = cursorPoint(e);
    if (!p) return;
    latestPresence = presencePayload({ x: Math.round(p.x), y: Math.round(p.y) });
    const now = Date.now();
    const gap = immediate ? 100 : PRESENCE_ACTION_MS;
    if (now - lastPresenceSent >= gap) {
      sendPresence();
    } else if (!presenceTrailTimer) {
      presenceTrailTimer = setTimeout(() => {
        presenceTrailTimer = null;
        sendPresence();
      }, gap - (now - lastPresenceSent));
    }
  }

  function sendPresence() {
    if (!projectId || !latestPresence) return;
    lastPresenceSent = Date.now();
    window.Presence.update(projectId, latestPresence);
  }

  function onBeforeUnload() {
    if (projectId) window.Presence.leave(projectId);
  }

  // --- События ---

  function bindEvents() {
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('mousedown', onMouseDown);
    viewport.addEventListener('dblclick', (e) => {
      const hit = e.target.closest('.arrow__hit');
      const g = hit && hit.closest('.arrow');
      const id = g && g.dataset.id;
      if (!id) return;
      e.preventDefault();
      addArrowPoint(id, e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('paste', onPaste);
    viewport.addEventListener('dragover', onDragOver);
    viewport.addEventListener('drop', onDrop);

    // Отключаем контекстное меню браузера (в т.ч. в Яндекс.Браузере) на холсте
    // и элементах — вместо него показываем своё (см. js/contextmenu.js).
    // В полях ввода (заголовок, поля модалок) оставляем нативное меню.
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea')) return;
      e.preventDefault();
    });

    arrowCursorEl = document.createElement('div');
    arrowCursorEl.className = 'arrow-cursor hidden';
    viewport.appendChild(arrowCursorEl);

    figurePreview = document.createElement('div');
    figurePreview.className = 'figure-preview hidden';
    viewport.appendChild(figurePreview);
    refreshFigurePreview();

    document.querySelectorAll('.tool').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.id === 'btn-figure') { toggleFiguresPopover(); return; }
        if (btn.id === 'btn-arrow') { toggleArrowsPopover(); return; }
        setTool(btn.dataset.tool);
      });
    });
    document.querySelectorAll('.figure-btn[data-arrow-shape]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveArrowShape(btn.dataset.arrowShape);
        closeArrowsPopover();
        setTool('arrow');
      });
    });
    setActiveArrowShape(activeArrowShape);
    document.querySelectorAll('.figure-btn[data-figure]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveFigure(btn.dataset.figure);
        closeFiguresPopover();
        setTool('frame');
      });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tool-figure')) {
        closeFiguresPopover();
        closeArrowsPopover();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeFiguresPopover();
        closeArrowsPopover();
        if (activeTool === 'arrow') setTool('select');
      }
    });
    setActiveFigure(activeFigure);
    document.getElementById('zoom-in').addEventListener('click', () => zoomAt(zoomStep()));
    document.getElementById('zoom-out').addEventListener('click', () => zoomAt(-zoomStep()));
    document.getElementById('zoom-reset').addEventListener('click', resetView);

    // Ручной ввод масштаба в процентах.
    const zv = document.getElementById('zoom-value');
    if (zv) {
      const applyZoomInput = () => {
        const pct = parseInt(String(zv.value).replace(/[^\d]/g, ''), 10);
        if (isFinite(pct) && pct > 0) setScalePercent(pct);
        else zv.value = Math.round(view.scale * 100) + '%';
      };
      zv.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyZoomInput(); zv.blur(); }
        if (e.key === 'Escape') { zv.value = Math.round(view.scale * 100) + '%'; zv.blur(); }
      });
      zv.addEventListener('blur', applyZoomInput);
      zv.addEventListener('focus', () => zv.select());
    }
  }

  // Устанавливает масштаб в процентах относительно центра холста.
  function setScalePercent(pct) {
    const r = viewport.getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const worldX = (cx - view.x) / view.scale;
    const worldY = (cy - view.y) / view.scale;
    let next = pct / 100;
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    view.scale = next;
    view.x = cx - worldX * view.scale;
    view.y = cy - worldY * view.scale;
    applyView();
    scheduleViewSave();
  }

  function zoomStep() {
    return window.Settings ? window.Settings.zoomStep() : 0.2;
  }

  // --- Перетаскивание файлов и вставка из буфера ---

  function onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e) {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    const p = screenToWorld(e.clientX, e.clientY);
    let off = 0;
    Array.prototype.forEach.call(files, (f) => {
      if (f && /^image\//.test(f.type)) {
        insertImage(f, p.x + off, p.y + off);
        off += 24;
      }
    });
  }

  function viewCenterWorld() {
    const r = viewport.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;

    const activeEl = document.activeElement;
    const editing = activeEl && activeEl.isContentEditable;

    // Поля ввода (заголовок и т.п.) — вставку делает сам браузер.
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;

    // Картинка из буфера (вне режима правки) → элемент-изображение.
    let imageFile = null;
    if (cd.items) {
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          imageFile = it.getAsFile();
          break;
        }
      }
    }
    if (imageFile && !editing) {
      e.preventDefault();
      const p = viewCenterWorld();
      insertImage(imageFile, p.x, p.y);
      return;
    }

    const html = cd.getData ? cd.getData('text/html') : '';
    const text = cd.getData ? cd.getData('text/plain') : '';

    if (editing) {
      // Правка: вставляем очищенный HTML с сохранением оформления.
      if (!html && !text) return;
      e.preventDefault();
      if (html) document.execCommand('insertHTML', false, sanitizePastedHtml(html));
      else document.execCommand('insertText', false, text);
      return;
    }

    if (!html && !text) return;
    e.preventDefault();
    const p = viewCenterWorld();
    const content = sanitizePastedHtml(html) || escapeHtml(text);
    const node = {
      id: window.Store.uid(),
      type: 'text',
      x: Math.round(p.x),
      y: Math.round(p.y),
      text: content,
      createdBy: window.currentUser ? window.currentUser.uid : 'anon'
    };
    if (boardDefaults.fontFamily) node.fontFamily = boardDefaults.fontFamily;
    if (boardDefaults.fontSize) node.fontSize = boardDefaults.fontSize;
    placeNode(node, false);
    selectOnly(node.id);
    refreshSelection();
    pushHistory({
      undo: () => removeLocalAndRemote(node.id),
      redo: () => { placeNode(node, false); selectOnly(node.id); }
    });
  }

  function refreshFigurePreview() {
    if (!figurePreview) return;
    const size = FIGURE_SIZES[activeFigure] || FIGURE_SIZES.rect;
    figurePreview.style.width = size.w + 'px';
    figurePreview.style.height = size.h + 'px';
    ensureFigureShape(figurePreview, activeFigure);
    const shape = figurePreview.querySelector('.figure-shape');
    if (!shape) return;
    shape.style.fill = 'rgba(140, 148, 160, .28)';
    shape.style.stroke = '#7b8494';
    shape.style.strokeWidth = '2px';
    shape.style.strokeDasharray = '6 4';
  }

  function setActiveFigure(figure) {
    const btn = document.querySelector('.figure-btn[data-figure="' + figure + '"]');
    if (!btn) return;
    activeFigure = figure;
    try { localStorage.setItem('miroz.figure', figure); } catch (e) { /* ignore */ }
    document.querySelectorAll('.figure-btn[data-figure]').forEach(b =>
      b.classList.toggle('is-active', b.dataset.figure === figure));
    const icon = document.getElementById('figure-icon');
    if (icon) icon.innerHTML = btn.querySelector('svg').outerHTML;
    refreshFigurePreview();
  }

  function figuresPopover() { return document.getElementById('figures-popover'); }
  function openFiguresPopover() {
    const pop = figuresPopover();
    if (pop) pop.classList.remove('hidden');
  }
  function closeFiguresPopover() {
    const pop = figuresPopover();
    if (pop) pop.classList.add('hidden');
  }
  function toggleFiguresPopover() {
    const pop = figuresPopover();
    if (!pop) return;
    if (pop.classList.contains('hidden')) openFiguresPopover();
    else closeFiguresPopover();
  }

  function setActiveArrowShape(shape) {
    const btn = document.querySelector('.figure-btn[data-arrow-shape="' + shape + '"]');
    if (!btn) return;
    activeArrowShape = shape;
    // Выбор формы в тулбаре одновременно меняет «начальную форму» в настройках.
    if (window.Settings && window.Settings.setLocal) {
      window.Settings.setLocal({ arrowShape: shape });
    }
    document.querySelectorAll('.figure-btn[data-arrow-shape]').forEach(b =>
      b.classList.toggle('is-active', b.dataset.arrowShape === shape));
    const icon = document.getElementById('arrow-icon');
    if (icon) icon.innerHTML = btn.querySelector('svg').outerHTML;
  }

  function arrowsPopover() { return document.getElementById('arrows-popover'); }
  function openArrowsPopover() {
    const pop = arrowsPopover();
    if (pop) pop.classList.remove('hidden');
  }
  function closeArrowsPopover() {
    const pop = arrowsPopover();
    if (pop) pop.classList.add('hidden');
  }
  function toggleArrowsPopover() {
    const pop = arrowsPopover();
    if (!pop) return;
    if (pop.classList.contains('hidden')) openArrowsPopover();
    else closeArrowsPopover();
  }

  function clearArrowCursor() {
    if (arrowCursorHiEl) arrowCursorHiEl.classList.remove('arrow-target');
    arrowCursorHiEl = null;
    arrowCursorSnap = null;
    if (arrowCursorEl) arrowCursorEl.classList.add('hidden');
  }

  // Точка на курсоре в режиме стрелки: прилипает к стенке объекта под мышкой.
  function updateArrowCursor(e) {
    if (activeTool !== 'arrow' || !arrowCursorEl) { clearArrowCursor(); return; }
    const snap = findSnapTarget(e.clientX, e.clientY, null);
    const el = snap ? nodeEls.get(snap.id) : null;
    if (arrowCursorHiEl && arrowCursorHiEl !== el) {
      arrowCursorHiEl.classList.remove('arrow-target');
      arrowCursorHiEl = null;
    }
    if (el) {
      arrowCursorHiEl = el;
      el.classList.add('arrow-target');
    }
    arrowCursorSnap = snap;
    const p = snap ? snap.point : screenToWorld(e.clientX, e.clientY);
    const s = worldToScreen(p.x, p.y);
    arrowCursorEl.style.left = s.x + 'px';
    arrowCursorEl.style.top = s.y + 'px';
    arrowCursorEl.classList.toggle('is-snapped', !!snap);
    arrowCursorEl.classList.remove('hidden');
  }

  function setTool(tool) {
    if (tool !== 'arrow') clearArrowCursor();
    activeTool = tool;
    viewport.dataset.tool = tool;
    document.querySelectorAll('.tool').forEach(b =>
      b.classList.toggle('is-active', b.dataset.tool === tool));

    // Серый призрак фигуры: курсор находится в её левом верхнем углу.
    if (figurePreview) {
      if (tool === 'frame') {
        refreshFigurePreview();
        if (lastCursorWorld) {
          const p = worldToScreen(lastCursorWorld.x, lastCursorWorld.y);
          figurePreview.style.left = p.x + 'px';
          figurePreview.style.top = p.y + 'px';
        }
        figurePreview.classList.remove('hidden');
      } else {
        figurePreview.classList.add('hidden');
      }
    }
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
    pushCursor(e, false);
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
    if (e.target.closest('.text-toolbar')) return;   // клики по панели форматирования

    // Клик — одно из действий, по которым обновляем свой курсор у других.
    pushCursor(e, true);

    const handle = e.target.closest('.sel-handle');
    if (handle && e.button === 0 && selectedIds.size === 1) {
      startResize(e, handle.dataset.corner);
      return;
    }

    const ball = e.target.closest('.sel-ball');
    if (ball && e.button === 0 && selectedIds.size === 1) {
      startArrowDraw(e, [...selectedIds][0]);
      return;
    }

    const aHandle = e.target.closest('.arrow__handle');
    if (aHandle && e.button === 0) {
      const ag = aHandle.closest('.arrow');
      if (ag && ag.dataset.id) {
        startArrowDrag(e, ag.dataset.id, aHandle.getAttribute('data-kind'),
          aHandle.getAttribute('data-axis'), aHandle.getAttribute('data-index'));
        return;
      }
    }

    if (e.button === 1) { startPan(e); return; }   // СКМ — перемещение доски
    if (e.button === 2) { maybeEditFromRmb(e); return; } // ПКМ: выделить / двойной ПКМ — правка
    if (e.button !== 0) return;
    if (spaceDown) { startPan(e); return; }

    if (activeTool === 'arrow' && e.button === 0) {
      // Точка уже примагничена к стенке (см. updateArrowCursor). От неё и
      // начинаем тянуть стрелку обычным механизмом.
      const snap = findSnapTarget(e.clientX, e.clientY, null);
      const fromId = snap ? snap.id : null;
      clearArrowCursor();
      setTool('select');
      startArrowDraw(e, fromId);
      return;
    }

    if (activeTool !== 'select') {
      const p = screenToWorld(e.clientX, e.clientY);
      if (activeTool === 'image') pickImageAt(p.x, p.y);
      else addNode(activeTool, p.x, p.y, { figure: activeFigure });
      setTool('select');
      return;
    }

    // Ручные режимы: линию можно схватить в любом месте и тянуть ближайшую
    // ручку изгиба. Обычные стрелки по-прежнему только выделяются кликом.
    const arrowHit = e.target.closest('.arrow__hit');
    if (arrowHit && e.button === 0) {
      const ag = arrowHit.closest('.arrow');
      const id = ag && ag.dataset.id;
      const n = id ? nodes.get(id) : null;
      if (n && selectedIds.has(id) &&
          (n.shape === 'elbow' || n.shape === 'curved-manual')) {
        const p = screenToWorld(e.clientX, e.clientY);
        const geo = arrowGeometry(n);
        let best = null;
        (geo.handles || []).forEach(h => {
          if (h.kind !== 'bend' && h.kind !== 'point') return;
          const d = Math.hypot(h.x - p.x, h.y - p.y);
          if (!best || d < best.d) best = { h, d };
        });
        if (best) {
          startArrowDrag(e, id, best.h.kind, best.h.axis, best.h.index);
          return;
        }
      }
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (id) {
        if (e.shiftKey) toggleSelection(id);
        else selectOnly(id);
      }
      return;
    }

    const arrowEl = e.target.closest('.arrow');
    if (arrowEl) {
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (e.shiftKey) toggleSelection(arrowEl.dataset.id);
      else selectOnly(arrowEl.dataset.id);
      return;
    }

    const nodeEl = e.target.closest('.canvas-node');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      if (isLockedByOther(id)) return;            // занят другим участником
      if (document.activeElement === nodeEl) return; // идёт редактирование
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (e.shiftKey) { toggleSelection(id); return; }
      const wasSelected = selectedIds.has(id);
      if (!wasSelected) selectOnly(id);
      // Клик по уже выделенному (без перетаскивания) включает режим ввода.
      clickCandidate = { id, wasSelected, moved: false, x: e.clientX, y: e.clientY };
      startDragGroup(e);
      return;
    }

    // ЛКМ по пустому месту: сначала выходим из режима ввода, затем снимаем выделение.
    if (isEditing()) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return;
    }
    startMarquee(e);
  }

  // Одиночная ЛКМ / первый ПКМ — только выделение; двойной ПКМ — редактирование.
  function maybeEditFromRmb(e) {
    const nodeEl = e.target.closest('.canvas-node');
    if (!nodeEl) { clearSelection(); return; }
    const id = nodeEl.dataset.id;
    if (isLockedByOther(id)) return;

    const now = Date.now();
    const isDouble = lastRmb.id === id && (now - lastRmb.t) < 450;
    lastRmb = { id: isDouble ? null : id, t: now };

    if (!selectedIds.has(id)) selectOnly(id);
    if (isDouble) startEditingNode(id);
  }

  function startEditingNode(id, clientX, clientY) {
    const n = nodes.get(id);
    const el = nodeEls.get(id);
    if (!n || !el || !el.isContentEditable || isLockedByOther(id)) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;
    if (clientX != null && document.caretRangeFromPoint) {
      try {
        const r = document.caretRangeFromPoint(clientX, clientY);
        if (r && el.contains(r.startContainer)) range = r;
      } catch (e) { /* ignore */ }
    }
    sel.removeAllRanges();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.addRange(range);
  }

  // --- Изменение размера за ручки (уголки — с шагом, бока — только ширина) ---

  function snapSize(v) {
    const step = (window.Settings && window.Settings.resizeStep) ? window.Settings.resizeStep() : RESIZE_STEP;
    const s = step > 0 ? step : 1;
    return Math.round(v / s) * s;
  }

  function startResize(e, corner) {
    const id = [...selectedIds][0];
    const n = nodes.get(id);
    const el = nodeEls.get(id);
    if (!n || !el || isLockedByOther(id)) return;
    e.preventDefault();
    closeToolbarMenu();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    resizing = {
      id, corner,
      startX: e.clientX, startY: e.clientY,
      ox: n.x, oy: n.y,
      ow: el.offsetWidth || 0, oh: el.offsetHeight || 0,
      origW: n.w, origH: n.h
    };
    viewport.style.cursor =
      (corner === 'e' || corner === 'w') ? 'ew-resize'
        : (corner === 'n' || corner === 's') ? 'ns-resize'
        : (corner === 'nw' || corner === 'se') ? 'nwse-resize' : 'nesw-resize';
  }

  function doResize(e) {
    const r = resizing;
    const n = nodes.get(r.id);
    const el = nodeEls.get(r.id);
    if (!n || !el) return;
    const dx = (e.clientX - r.startX) / view.scale;
    const dy = (e.clientY - r.startY) / view.scale;
    const MIN = 60;
    const side = r.corner === 'e' || r.corner === 'w';

    let x = r.ox, y = r.oy, w = r.ow, h = r.oh;

    if (side) {
      // Боковая ручка — меняем только ширину, высота следует за текстом.
      w = r.corner === 'e' ? r.ow + dx : r.ow - dx;
      w = Math.max(MIN, snapSize(w));
      if (r.corner === 'w') x = r.ox + (r.ow - w);
    } else {
      const hasH = r.corner.indexOf('e') >= 0 || r.corner.indexOf('w') >= 0;
      const hasV = r.corner.indexOf('n') >= 0 || r.corner.indexOf('s') >= 0;

      if (hasH) w = r.corner.indexOf('e') >= 0 ? r.ow + dx : r.ow - dx;
      if (hasV) h = r.corner.indexOf('s') >= 0 ? r.oh + dy : r.oh - dy;

      if (hasH && hasV) {
        // Угловая ручка — масштабируем пропорционально (общий размер).
        const relW = r.ow ? w / r.ow : 1;
        const relH = r.oh ? h / r.oh : 1;
        let k = Math.abs(relW - 1) >= Math.abs(relH - 1) ? relW : relH;
        const minK = Math.max(MIN / (r.ow || MIN), MIN / (r.oh || MIN));
        k = Math.max(k, minK);
        w = Math.round(r.ow * k);
        h = Math.round(r.oh * k);
      } else {
        // Боковая ручка (n/s) — тянем только по одной оси, элемент искажается.
        w = Math.max(MIN, snapSize(w));
        h = Math.max(MIN, snapSize(h));
      }
      if (r.corner.indexOf('w') >= 0) x = r.ox + (r.ow - w);
      if (r.corner.indexOf('n') >= 0) y = r.oy + (r.oh - h);
    }

    // Притягиваем ресайз к другим объектам и показываем направляющие.
    const snapped = computeResizeSnap(r, { x, y, w, h });
    if (snapped) {
      x = snapped.x; y = snapped.y; w = snapped.w; h = snapped.h;
      showGuides(snapped.guides);
    } else {
      hideGuides();
    }

    n.w = Math.round(w);
    if (!side) n.h = Math.round(h);
    n.x = Math.round(x); n.y = Math.round(y);
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    applyNodeBox(el, n);
    updateSelectionBox();
    updateTextToolbar();
  }

  function endResize() {
    if (!resizing) return;
    const r = resizing;
    resizing = null;
    hideGuides();
    viewport.style.cursor = '';
    const n = nodes.get(r.id);
    if (!n) return;

    const patch = { x: Math.round(n.x), y: Math.round(n.y) };
    if (n.w != null) patch.w = Math.round(n.w);
    if (n.h != null) patch.h = Math.round(n.h);
    if (projectId) window.Store.updateNode(projectId, r.id, patch).catch(handleError);

    const ox = r.ox, oy = r.oy, ow = r.origW, oh = r.origH;
    const changed = Math.round(n.x) !== ox || Math.round(n.y) !== oy ||
      n.w !== ow || n.h !== oh;
    if (!changed) return;

    const beforeBox = { x: ox, y: oy, w: ow, h: oh };
    const afterBox = { x: Math.round(n.x), y: Math.round(n.y), w: n.w, h: n.h };
    const applyBox = value => {
      const nn = nodes.get(r.id);
      const ne = nodeEls.get(r.id);
      if (!nn) return;
      nn.x = value.x; nn.y = value.y; nn.w = value.w; nn.h = value.h;
      if (ne) {
        ne.style.left = value.x + 'px'; ne.style.top = value.y + 'px';
        applyNodeBox(ne, nn);
      }
      const data = { x: value.x, y: value.y };
      if (value.w != null) data.w = value.w;
      if (value.h != null) data.h = value.h;
      if (projectId) window.Store.updateNode(projectId, r.id, data).catch(() => {});
      updateSelectionBox();
      refreshArrows();
    };
    pushHistory({
      undo: () => applyBox(beforeBox),
      redo: () => applyBox(afterBox)
    });
  }

  function startDragGroup(e) {
    const items = [];
    selectedIds.forEach(id => {
      const node = nodes.get(id);
      const el = nodeEls.get(id);
      if (node && el) { items.push({ node, el, ox: Number(node.x) || 0, oy: Number(node.y) || 0 }); draggingIds.add(id); }
    });
    if (!items.length) return;
    dragGroup = { startX: e.clientX, startY: e.clientY, items };
  }

  // --- Рамка выделения (ЛКМ по пустому месту) ---

  function startMarquee(e) {
    e.preventDefault();
    const p = screenToWorld(e.clientX, e.clientY);
    const base = (e.ctrlKey || e.metaKey || e.shiftKey) ? [...selectedIds] : [];
    if (!base.length && selectedIds.size) clearSelection();
    marquee = {
      start: p,
      rect: { x: p.x, y: p.y, x2: p.x, y2: p.y },
      base,
      el: document.getElementById('marquee')
    };
    if (marquee.el) marquee.el.classList.remove('hidden');
    updateMarquee(e);
  }

  function updateMarquee(e) {
    if (!marquee) return;
    const p = screenToWorld(e.clientX, e.clientY);
    const x = Math.min(marquee.start.x, p.x);
    const y = Math.min(marquee.start.y, p.y);
    const x2 = Math.max(marquee.start.x, p.x);
    const y2 = Math.max(marquee.start.y, p.y);
    marquee.rect = { x, y, x2, y2 };
    const a = worldToScreen(x, y);
    const b = worldToScreen(x2, y2);
    const el = marquee.el;
    if (el) {
      el.style.left = a.x + 'px';
      el.style.top = a.y + 'px';
      el.style.width = (b.x - a.x) + 'px';
      el.style.height = (b.y - a.y) + 'px';
    }
  }

  function endMarquee() {
    if (!marquee) return;
    if (marquee.el) marquee.el.classList.add('hidden');
    const r = marquee.rect;
    const ids = [...marquee.base];
    nodes.forEach(n => {
      if (isLockedByOther(n.id)) return;
      const b = worldBoundsOf(n);
      if (!b) return;
      if (r.x < b.x2 && r.x2 > b.x && r.y < b.y2 && r.y2 > b.y) ids.push(n.id);
    });
    setSelection(ids);
    marquee = null;
  }

  function startPan(e) {
    if (e && e.preventDefault) e.preventDefault();  // не даём браузеру автоскролл на СКМ
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    viewport.style.cursor = 'grabbing';   // «hold»-рука при перемещении
  }

  function endPan() {
    panning = false;
    panStart = null;
    viewport.style.cursor = spaceDown ? 'grab' : '';
  }

  function onMouseMove(e) {
    lastCursorWorld = screenToWorld(e.clientX, e.clientY);
    if (activeTool === 'arrow') updateArrowCursor(e);
    else if (activeTool === 'frame' && figurePreview) {
      const r = viewport.getBoundingClientRect();
      figurePreview.style.left = (e.clientX - r.left) + 'px';
      figurePreview.style.top = (e.clientY - r.top) + 'px';
      figurePreview.classList.remove('hidden');
    }
    // Пока идёт активное действие (тащим, панорамируем, рисуем стрелку…),
    // обновляем курсор у других участников. Обычное движение мышью — нет.
    if (arrowDrag || arrowDraw || resizing || marquee || panning || dragGroup) {
      pushCursor(e, false);
    }
    if (arrowDrag) { updateArrowDrag(e); return; }
    if (arrowDraw) { updateArrowDraw(e); return; }
    if (resizing) { doResize(e); return; }
    if (marquee) { updateMarquee(e); return; }
    if (panning) {
      view.x = panStart.vx + (e.clientX - panStart.x);
      view.y = panStart.vy + (e.clientY - panStart.y);
      applyView();
      return;
    }
    if (dragGroup) {
      if (clickCandidate && !clickCandidate.moved &&
          Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > 4) {
        clickCandidate.moved = true;
      }
      const dx = (e.clientX - dragGroup.startX) / view.scale;
      const dy = (e.clientY - dragGroup.startY) / view.scale;
      const snap = computeSnap(dx, dy);
      if (snap) { dragGroup.snap = snap; }
      const adx = snap ? snap.dx : dx, ady = snap ? snap.dy : dy;
      dragGroup.items.forEach(it => {
        it.node.x = it.ox + adx;
        it.node.y = it.oy + ady;
        it.el.style.left = it.node.x + 'px';
        it.el.style.top = it.node.y + 'px';
      });
      showGuides(snap ? snap.guides : null);
      updateSelectionBox();
      updateTextToolbar();
    }
  }

  // --- Линии выравнивания (smart guides) при перетаскивании ---

  const SNAP_PX = 6;   // порог прилипания на экране, px

  // Линии выравнивания при ресайзе: притягиваем ту сторону, которую тянет
  // пользователь, к краям других объектов (к их левому/правому/верхнему/нижнему краю).
  function computeResizeSnap(r, box) {
    const hasX = r.corner.indexOf('e') >= 0 || r.corner.indexOf('w') >= 0;
    const hasY = r.corner.indexOf('n') >= 0 || r.corner.indexOf('s') >= 0;
    if (!hasX && !hasY) return null;

    let { x, y, w, h } = box;
    const movingX = hasX ? [r.corner.indexOf('w') >= 0 ? x : x + w] : [];
    const movingY = hasY ? [r.corner.indexOf('n') >= 0 ? y : y + h] : [];
    const thr = SNAP_PX / view.scale;
    let bestX = null, bestY = null;

    nodes.forEach(n => {
      if (n.id === r.id || n.type === 'arrow') return;
      if (!isFinite(n.x) || !isFinite(n.y)) return;
      const el = nodeEls.get(n.id);
      if (!el) return;
      const ew = el.offsetWidth || 0, eh = el.offsetHeight || 0;
      const tX = [n.x, n.x + ew], tY = [n.y, n.y + eh];
      movingX.forEach(gv => tX.forEach(tv => {
        const d = tv - gv;
        if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: tv };
      }));
      movingY.forEach(gv => tY.forEach(tv => {
        const d = tv - gv;
        if (Math.abs(d) <= thr && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: tv };
      }));
    });

    if (!bestX && !bestY) return null;
    const MIN = 60;
    const guides = [];
    if (bestX) {
      if (r.corner.indexOf('w') >= 0) {
        const nx = x + bestX.d, nw = w - bestX.d;
        if (nw >= MIN) { x = nx; w = nw; guides.push({ axis: 'v', at: bestX.at }); }
      } else if (w + bestX.d >= MIN) {
        w += bestX.d; guides.push({ axis: 'v', at: bestX.at });
      }
    }
    if (bestY) {
      if (r.corner.indexOf('n') >= 0) {
        const ny = y + bestY.d, nh = h - bestY.d;
        if (nh >= MIN) { y = ny; h = nh; guides.push({ axis: 'h', at: bestY.at }); }
      } else if (h + bestY.d >= MIN) {
        h += bestY.d; guides.push({ axis: 'h', at: bestY.at });
      }
    }
    return { x, y, w, h, guides: guides.length ? guides : null };
  }

  function computeSnap(dx, dy) {
    if (!dragGroup) return null;
    const moving = new Set(dragGroup.items.map(it => it.node.id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    dragGroup.items.forEach(it => {
      const w = it.el.offsetWidth || 0, h = it.el.offsetHeight || 0;
      minX = Math.min(minX, it.ox + dx);
      minY = Math.min(minY, it.oy + dy);
      maxX = Math.max(maxX, it.ox + dx + w);
      maxY = Math.max(maxY, it.oy + dy + h);
    });
    if (!isFinite(minX)) return null;
    const mX = [minX, (minX + maxX) / 2, maxX];
    const mY = [minY, (minY + maxY) / 2, maxY];

    const thr = SNAP_PX / view.scale;
    let bestX = null, bestY = null;
    nodes.forEach(n => {
      if (moving.has(n.id) || n.type === 'arrow') return;
      if (!isFinite(n.x) || !isFinite(n.y)) return;
      const el = nodeEls.get(n.id);
      if (!el) return;
      const tX = [n.x, n.x + (el.offsetWidth || 0) / 2, n.x + (el.offsetWidth || 0)];
      const tY = [n.y, n.y + (el.offsetHeight || 0) / 2, n.y + (el.offsetHeight || 0)];
      mX.forEach(gv => tX.forEach(tv => {
        const d = tv - gv;
        if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: tv };
      }));
      mY.forEach(gv => tY.forEach(tv => {
        const d = tv - gv;
        if (Math.abs(d) <= thr && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: tv };
      }));
    });

    if (!bestX && !bestY) return null;
    const guides = [];
    if (bestX) guides.push({ axis: 'v', at: bestX.at });
    if (bestY) guides.push({ axis: 'h', at: bestY.at });
    return { dx: dx + (bestX ? bestX.d : 0), dy: dy + (bestY ? bestY.d : 0), guides };
  }

  function showGuides(guides) {
    if (!guidesLayer) return;
    if (!guides || !guides.length) { guidesLayer.classList.add('hidden'); return; }
    let idx = 0;
    guides.forEach(g => {
      const line = guidesLayer.children[idx++];
      if (!line) return;
      if (g.axis === 'v') {
        const p = worldToScreen(g.at, 0);
        line.className = 'guide guide--v';
        line.style.left = p.x + 'px';
        line.style.top = '0px';
        line.style.height = '100%';
        line.style.width = '1px';
      } else {
        const p = worldToScreen(0, g.at);
        line.className = 'guide guide--h';
        line.style.left = '0px';
        line.style.top = p.y + 'px';
        line.style.width = '100%';
        line.style.height = '1px';
      }
      line.style.display = '';
    });
    for (; idx < guidesLayer.children.length; idx++) guidesLayer.children[idx].style.display = 'none';
    guidesLayer.classList.remove('hidden');
  }

  function hideGuides() {
    if (guidesLayer) guidesLayer.classList.add('hidden');
  }

  function onMouseUp(e) {
    pushCursor(e, true);
    if (arrowDrag) { endArrowDrag(); return; }
    if (arrowDraw) { finishArrowDraw(e); return; }
    if (resizing) { endResize(); return; }
    if (marquee) { endMarquee(); return; }
    if (panning) { endPan(); scheduleViewSave(); }
    if (dragGroup) { endDragGroup(); }
  }

  function endDragGroup() {
    const items = dragGroup.items;
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragSavePending = null;
    hideGuides();

    const moves = [];
    items.forEach(it => {
      const ox = Math.round(it.ox);
      const oy = Math.round(it.oy);
      it.node.x = Math.round(it.node.x);
      it.node.y = Math.round(it.node.y);
      it.el.style.left = it.node.x + 'px';
      it.el.style.top = it.node.y + 'px';
      draggingIds.delete(it.node.id);
      if (projectId) {
        window.Store.updateNode(projectId, it.node.id, { x: it.node.x, y: it.node.y }).catch(handleError);
      }
      if (ox !== it.node.x || oy !== it.node.y) {
        moves.push({ id: it.node.id, x: it.node.x, y: it.node.y, ox, oy });
      }
    });
    dragGroup = null;

    const cand = clickCandidate;
    clickCandidate = null;
    // Клик (без перетаскивания) по уже выделенному элементу — режим ввода.
    if (cand && !cand.moved && !moves.length && cand.wasSelected && selectedIds.size === 1) {
      startEditingNode(cand.id, cand.x, cand.y);
    }

    if (moves.length) {
      const applyMove = (m, useOld) => {
        const n = nodes.get(m.id);
        if (!n) return;
        const x = useOld ? m.ox : m.x;
        const y = useOld ? m.oy : m.y;
        n.x = x; n.y = y;
        const el = nodeEls.get(m.id);
        if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
        if (projectId) window.Store.updateNode(projectId, m.id, { x, y }).catch(() => {});
      };
      pushHistory({
        undo: () => { moves.forEach(m => applyMove(m, true)); refreshArrows(); updateSelectionBox(); },
        redo: () => { moves.forEach(m => applyMove(m, false)); refreshArrows(); updateSelectionBox(); }
      });
    }
  }

  function onKeyDown(e) {
    if (e.code === 'Space' && !isEditing()) {
      spaceDown = true;
      viewport.style.cursor = 'grab';
    }
    if (isEditing()) return;

    const ctrl = e.ctrlKey || e.metaKey;
    // Повтор отменённого: Ctrl+Y или Ctrl+Shift+Z.
    if (ctrl && (e.key === 'y' || e.key === 'Y' || e.key === 'н' || e.key === 'Н' ||
        (e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')))) {
      e.preventDefault(); redo(); return;
    }
    if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
      e.preventDefault(); undo(); return;
    }
    // Не даём браузеру перезаписать системный буфер своим текстовым копированием.
    if (ctrl && (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С')) {
      e.preventDefault(); copySelected(); return;
    }
    if (ctrl && (e.key === 'x' || e.key === 'X' || e.key === 'ч' || e.key === 'Ч')) {
      e.preventDefault(); cutSelected(); return;
    }
    if (ctrl && (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М')) {
      // Внутренняя вставка (скопированные элементы) — только если буфер не пуст.
      // Иначе не перехватываем: пусть сработает системный paste (внешний текст/картинки).
      if (clipboard.length) { e.preventDefault(); pasteClipboard(lastCursorWorld); }
      return;
    }
    if (ctrl && (e.key === 'a' || e.key === 'A' || e.key === 'ф' || e.key === 'Ф')) {
      e.preventDefault();
      setSelection([...nodes.keys()].filter(id => !isLockedByOther(id)));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Escape') { clearSelection(); return; }
    if ((e.key === 'F2' || e.key === 'Enter') && selectedIds.size === 1) {
      e.preventDefault();
      startEditingNode([...selectedIds][0]);
      return;
    }

    if (e.key === 'v' || e.key === '1') setTool('select');
    if (e.key === 'n' || e.key === 's' || e.key === '2') setTool('sticky');
    if (e.key === 't' || e.key === '3') setTool('text');
    if (e.key === 'i' || e.key === '5') setTool('image');
    if (e.key === 'f' || e.key === '4') setTool('frame');
    if (e.key === 'a' || e.key === '6') setTool('arrow');
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceDown = false;
      viewport.style.cursor = panning ? 'grabbing' : '';
    }
  }

  function isEditing() {
    const a = document.activeElement;
    return a && (a.isContentEditable || a.tagName === 'INPUT');
  }

  // Стандартный шрифт/кегль проекта (из настроек). Применяется к новым элементам.
  function setDefaults(project) {
    if (!project) return;
    if (project.defaultFontFamily !== undefined) {
      boardDefaults.fontFamily = project.defaultFontFamily || '';
    }
    if (project.defaultFontSize) {
      boardDefaults.fontSize = Number(project.defaultFontSize) || DEFAULT_FONT_SIZE;
    }
  }

  // Контекст для внешних модулей (панель элемента, контекстное меню ПКМ).
  const ctx = {
    viewport: () => viewport,
    projectId: () => projectId,
    worldToScreen,
    screenToWorld,
    getNode: (id) => nodes.get(id),
    getEl: (id) => nodeEls.get(id) || arrowEls.get(id),
    singleId: () => (selectedIds.size === 1 ? [...selectedIds][0] : null),
    selectedIds: () => [...selectedIds],
    selectionCount: () => selectedIds.size,
    updateArrow,
    setActiveArrowShape,
    isLocked: (id) => isLockedByOther(id),
    applyTextStyle: applyNodeTextStyle,
    applyAppearance: applyNodeAppearance,
    applyBox: applyNodeBox,
    scheduleTextSave,
    pushHistory,
    undo,
    redo,
    sanitize: sanitizeHtml,
    rgbToHex,
    updateSelectionBox,
    setArrowStyle,
    copySelected,
    cutSelected,
    addArrowPoint,
    pasteClipboard,
    hasClipboard: () => clipboard.length > 0,
    duplicateSelected,
    deleteSelected,
    resetImageSize,
    selectOnly,
    setSelection,
    selectionBounds,
    alignSelection,
    distributeSelection,
    consts: {
      FONT_FAMILIES, FONT_SIZES, TEXT_COLORS, TEXT_COLORS_LIGHT, ALIGN_ITEMS, DEFAULT_FONT_SIZE
    }
  };

  return { init, load, unload, applyView, resetView, setDefaults, ctx };
})();
