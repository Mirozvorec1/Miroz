// Доска: холст, зум, панорамирование, элементы + realtime-синхронизация.
//
// Изменения других пользователей прилетают через Store.subscribeNodes и
// применяются к DOM на лету. Локальное перетаскивание/правка элемента не
// перебивается входящими апдейтами (пока элемент тащат или редактируют).

window.Board = (function () {
  let viewport, world;
  let gridEl = null;   // фон-сетка (живёт в viewport, тайлится бесконечно)
  let selBox = null;   // рамка вокруг группы выделенных элементов
  let textToolbar = null; // плавающая панель форматирования текста
  let toolbarNodeId = null;
  let toolbarMenu = null; // открытое подменю панели
  let savedRange = null;  // сохранённое выделение внутри текста
  let pickerEls = null;   // узлы hex-пикера цвета
  let pickerHsv = { h: 0, s: 0, v: 0.9 };
  let pickerDragging = false;
  let projectId = null;
  let unsubscribe = null;

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
  const draggingIds = new Set(); // узлы, которые сейчас тащим локально
  const textTimers = new Map();  // id -> таймер отложенной записи текста
  const selectedIds = new Set(); // выделенные элементы

  // Блокировка: кто выделил узел — тот им и владеет (вычисляется из presence).
  let lockState = { owners: new Map(), colorOf: new Map(), nameOf: new Map(), self: null };

  // Буфер обмена и история (только собственные действия)
  let clipboard = [];
  const history = [];
  let historyLock = false;

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

    // Сетку-фон переносим из world в viewport: она не должна уезжать при
    // панорамировании, а её смещение задаётся через background-position.
    gridEl = world.querySelector('.canvas-grid');
    if (gridEl && gridEl.parentNode === world) viewport.insertBefore(gridEl, world);

    // Рамка вокруг выделения + угловые ручки изменения размера.
    selBox = document.createElement('div');
    selBox.className = 'sel-box hidden';
    selBox.innerHTML =
      '<div class="sel-handle" data-corner="nw"></div>' +
      '<div class="sel-handle" data-corner="ne"></div>' +
      '<div class="sel-handle" data-corner="sw"></div>' +
      '<div class="sel-handle" data-corner="se"></div>' +
      '<div class="sel-handle sel-handle--side" data-corner="e"></div>' +
      '<div class="sel-handle sel-handle--side" data-corner="w"></div>';
    viewport.appendChild(selBox);

    buildTextToolbar();

    const hint = document.getElementById('canvas-hint');
    if (hint) hint.textContent = 'ЛКМ — выделение и рамка, повторный клик — правка, СКМ — перемещение доски';

    // Сохраняем выделение внутри редактируемого текста, чтобы панель
    // форматирования не «теряла» его при кликах по кнопкам.
    document.addEventListener('selectionchange', () => {
      const el = toolbarNodeId && nodeEls.get(toolbarNodeId);
      if (el && document.activeElement === el) saveSelection();
    });

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
    if (zv) zv.textContent = Math.round(view.scale * 100) + '%';
    updateSelectionBox();
    updateTextToolbar();
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
    lockState = { owners: new Map(), colorOf: new Map(), nameOf: new Map(), self: null };
    latestPresence = null;
    hideTextToolbar();
    savedRange = null;
    selectedIds.clear();
    history.length = 0;
    dragGroup = null;
    marquee = null;
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

    ['fontFamily', 'fontSize', 'color', 'align'].forEach(k => {
      if (node[k] !== undefined) local[k] = node[k];
    });
    applyNodeTextStyle(el, local);
    if (!editing) {
      local.text = node.text;
      el.innerHTML = sanitizeHtml(node.text || '');
    }
  }

  function removeNodeById(id) {
    const el = nodeEls.get(id);
    if (el) el.remove();
    nodeEls.delete(id);
    nodes.delete(id);
    selectedIds.delete(id);
  }

  function renderNode(node) {
    const el = document.createElement('div');
    el.className = 'canvas-node canvas-node--' + node.type;
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    applyNodeBox(el, node);

    if (node.type === 'image') {
      const img = document.createElement('img');
      img.src = node.src || '';
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    } else {
      el.innerHTML = sanitizeHtml(node.text || '');
      applyNodeTextStyle(el, node);
    }
    if (selectedIds.has(node.id)) el.classList.add('is-selected');

    if (node.type === 'sticky' || node.type === 'text') {
      el.contentEditable = 'true';
      el.addEventListener('input', () => {
        node.text = el.innerHTML;
        scheduleTextSave(node.id);
        updateSelectionBox();     // элемент растёт вниз — тянем рамку и панель
        updateTextToolbar();
      });
      // История правки текста: фиксируем значение до и после редактирования.
      el.addEventListener('focus', () => { el._textBefore = node.text || ''; });
      el.addEventListener('blur', () => {
        if (el._textBefore !== undefined && el._textBefore !== node.text) {
          const before = el._textBefore;
          el._textBefore = undefined;
          pushHistory({ undo: () => {
            const n = nodes.get(node.id);
            const nodeEl = nodeEls.get(node.id);
            if (n) n.text = before;
            if (nodeEl) nodeEl.innerHTML = sanitizeHtml(before);
            if (projectId) window.Store.updateNode(projectId, node.id, { text: before }).catch(handleError);
          } });
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
    renderNode(node);
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
    if (type === 'text' || type === 'sticky') {
      if (boardDefaults.fontFamily) node.fontFamily = boardDefaults.fontFamily;
      if (boardDefaults.fontSize) node.fontSize = boardDefaults.fontSize;
    }
    placeNode(node, type !== 'frame');
    pushHistory({ undo: () => removeLocalAndRemote(node.id) });
  }

  // --- Изображения ---

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

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  // Вставляет картинку как элемент доски. Файл уходит в хранилище проекта
  // (Firebase Storage), при неудаче — inline data URL.
  function insertImage(file, x, y) {
    if (!file || !/^image\//.test(file.type)) return;
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      const maxSide = 420;
      let w = img.naturalWidth || 240;
      let h = img.naturalHeight || 180;
      const k = Math.min(1, maxSide / Math.max(w, h));
      w = Math.round(w * k);
      h = Math.round(h * k);
      URL.revokeObjectURL(objUrl);

      const id = window.Store.uid();
      const user = window.currentUser;
      let src;
      try {
        src = await window.Store.uploadImage(projectId, id, file);
      } catch (err) {
        console.warn('[image] upload failed, using data URL:', err);
        src = await blobToDataURL(file);
      }
      const node = {
        id,
        type: 'image',
        x: Math.round(x),
        y: Math.round(y),
        text: '',
        src,
        w,
        h,
        createdBy: user ? user.uid : 'anon'
      };
      placeNode(node, false);
      selectOnly(id);
      refreshSelection();
      pushHistory({ undo: () => removeLocalAndRemote(id) });
    };
    img.onerror = () => URL.revokeObjectURL(objUrl);
    img.src = objUrl;
  }

  // --- Выделение ---

  function refreshSelection() {
    const multi = selectedIds.size > 1;
    nodeEls.forEach((el, id) => {
      const on = selectedIds.has(id);
      el.classList.toggle('is-selected', on);
      el.classList.toggle('is-in-group', on && multi);
    });
    updateSelectionBox();
    updateTextToolbar();
  }

  // Рамка вокруг выделения (одиночного или группы) с угловыми ручками.
  function updateSelectionBox() {
    if (!selBox) return;
    if (selectedIds.size === 0) { selBox.classList.add('hidden'); return; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedIds.forEach(id => {
      const n = nodes.get(id);
      const el = nodeEls.get(id);
      if (!n || !el) return;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (el.offsetWidth || 0));
      maxY = Math.max(maxY, n.y + (el.offsetHeight || 0));
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
    selBox.classList.remove('hidden');
  }

  // --- Плавающая панель форматирования текста ---

  function buildTextToolbar() {
    textToolbar = document.createElement('div');
    textToolbar.className = 'text-toolbar hidden';
    textToolbar.innerHTML =
      '<button class="tt-btn" data-menu="color" title="Цвет текста"><span class="tt-dot"></span><span class="tt-caret">▾</span></button>' +
      '<button class="tt-btn" data-menu="font" title="Шрифт"><span class="tt-label" data-role="font">Simple</span><span class="tt-caret">▾</span></button>' +
      '<button class="tt-btn" data-menu="size" title="Размер текста"><span class="tt-label" data-role="size">Small</span><span class="tt-caret">▾</span></button>' +
      '<span class="tt-sep"></span>' +
      '<button class="tt-btn" data-cmd="bold" title="Жирный"><b>B</b></button>' +
      '<button class="tt-btn" data-cmd="italic" title="Курсив"><i>I</i></button>' +
      '<button class="tt-btn" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>' +
      '<button class="tt-btn" data-cmd="link" title="Ссылка">🔗</button>' +
      '<button class="tt-btn" data-cmd="insertUnorderedList" title="Маркированный список">☰</button>' +
      '<button class="tt-btn" data-cmd="insertOrderedList" title="Нумерованный список">1.</button>' +
      '<span class="tt-sep"></span>' +
      '<button class="tt-btn" data-menu="align" title="Выравнивание"><span class="tt-label" data-role="align">⯇</span><span class="tt-caret">▾</span></button>';

    // Меню шрифта (с предпросмотром каждого шрифта).
    const fontMenu = mkMenu('font');
    FONT_FAMILIES.forEach(f => {
      const b = mkMenuItem(f.label, f.value);
      b.style.fontFamily = f.value || '';
      fontMenu.appendChild(b);
    });

    // Меню размера: заготовки + ручной ввод.
    const sizeMenu = mkMenu('size');
    FONT_SIZES.forEach(s => sizeMenu.appendChild(mkMenuItem(s.label, String(s.value))));
    const divider = document.createElement('div');
    divider.className = 'tt-divider';
    sizeMenu.appendChild(divider);
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = '6';
    sizeInput.max = '400';
    sizeInput.className = 'tt-num';
    sizeInput.placeholder = 'px';
    sizeInput.addEventListener('focus', () => { sizeInput._before = captureStyle(toolbarNodeId); });
    sizeInput.addEventListener('input', () => {
      if (!toolbarNodeId) return;
      const px = Math.round(Number(sizeInput.value));
      if (isFinite(px) && px >= 6 && px <= 400) setNodeStyle(toolbarNodeId, { fontSize: px }, true);
    });
    sizeInput.addEventListener('change', () => { pushStyleHistory(toolbarNodeId, sizeInput._before); });
    sizeMenu.appendChild(sizeInput);

    // Меню цвета: hex-пикер (пипетка, HEX-поле, полоса тона, квадрат SV) + палитра.
    const colorMenu = mkMenu('color');
    colorMenu.classList.add('tt-picker');
    colorMenu.appendChild(buildColorPicker());
    const swatches = document.createElement('div');
    swatches.className = 'tt-swatches';
    TEXT_COLORS.concat(TEXT_COLORS_LIGHT).forEach(c => {
      const b = document.createElement('button');
      b.className = 'tt-swatch-btn';
      b.dataset.value = c;
      b.title = c;
      b.innerHTML = '<span class="tt-swatch" style="background:' + c + '"></span>';
      swatches.appendChild(b);
    });
    colorMenu.appendChild(swatches);

    // Меню выравнивания (пункты с иконками).
    const alignMenu = mkMenu('align');
    ALIGN_ITEMS.forEach(a => alignMenu.appendChild(mkAlignItem(a)));

    [fontMenu, sizeMenu, colorMenu, alignMenu].forEach(m => textToolbar.appendChild(m));

    // Клик по кнопкам не должен красть фокус/выделение у текста.
    textToolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });

    textToolbar.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      const menuBtn = e.target.closest('[data-menu]');
      if (menuBtn) { toggleToolbarMenu(menuBtn); return; }

      const item = e.target.closest('[data-value]');
      if (item) { pickToolbarMenu(item); return; }

      const cmdBtn = e.target.closest('[data-cmd]');
      if (cmdBtn) {
        const cmd = cmdBtn.dataset.cmd;
        if (cmd === 'link') {
          saveSelection();
          const url = prompt('Ссылка (URL):', 'https://');
          if (url) runTextCommand('createLink', url);
          return;
        }
        runTextCommand(cmd);
      }
    });

    viewport.appendChild(textToolbar);
  }

  function mkMenu(name) {
    const menu = document.createElement('div');
    menu.className = 'tt-menu hidden';
    menu.dataset.menuFor = name;
    return menu;
  }

  function mkMenuItem(label, value) {
    const b = document.createElement('button');
    b.className = 'tt-menu__item';
    b.dataset.value = value;
    b.innerHTML = '<span class="tt-check">✓</span><span class="tt-menu__label"></span>';
    b.querySelector('.tt-menu__label').textContent = label;
    return b;
  }

  function markMenuItem(name, value) {
    const menu = textToolbar && textToolbar.querySelector('.tt-menu[data-menu-for="' + name + '"]');
    if (!menu) return;
    menu.querySelectorAll('[data-value]').forEach(b =>
      b.classList.toggle('is-active', b.dataset.value === String(value)));
  }

  // --- Иконки выравнивания ---

  function alignSvg(kind) {
    const W = 18, full = 14, short = 9, x0 = 2;
    const widths = [full, short, full, short];
    let bars = '';
    [3, 7, 11, 15].forEach((y, i) => {
      const w = kind === 'justify' ? full : widths[i];
      let x = x0;
      if (kind === 'center') x = (W - w) / 2;
      else if (kind === 'right') x = W - x0 - w;
      bars += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="2" rx="1"/>';
    });
    return '<svg class="tt-align-ico" viewBox="0 0 18 18" fill="currentColor">' + bars + '</svg>';
  }

  function mkAlignItem(item) {
    const b = document.createElement('button');
    b.className = 'tt-menu__item';
    b.dataset.value = item.value;
    b.innerHTML = '<span class="tt-check">✓</span>' + alignSvg(item.value) +
      '<span class="tt-menu__label"></span>';
    b.querySelector('.tt-menu__label').textContent = item.label;
    return b;
  }

  // --- Hex-пикер цвета ---

  function clamp01(x) { return Math.min(1, Math.max(0, x)); }

  function normalizeHex(str) {
    if (!str) return null;
    let s = String(str).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toLowerCase();
  }

  function hsvToHex(h, s, v) {
    s = clamp01(s); v = clamp01(v);
    const c = v * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = v - c;
    const to = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
  }

  function hexToHsv(hex) {
    const n = normalizeHex(hex) || '#000000';
    const r = parseInt(n.slice(1, 3), 16) / 255;
    const g = parseInt(n.slice(3, 5), 16) / 255;
    const b = parseInt(n.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  // Приводим rgb(...) в строках к hex (браузер любит возвращать rgb).
  function rgbToHex(str) {
    return String(str).replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)/gi, (m, r, g, b) =>
      '#' + [r, g, b].map(n => Number(n).toString(16).padStart(2, '0')).join(''));
  }

  function buildColorPicker() {
    const wrap = document.createElement('div');
    wrap.className = 'tt-picker__inner';

    const top = document.createElement('div');
    top.className = 'tt-picker__top';
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'tt-eye';
    eye.title = 'Пипетка';
    eye.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M15 4l5 5-9 9-5 1 1-5z"/>' +
      '<path d="M13 6l5 5"/><path d="M4 20l3.5-3.5"/></svg>';
    eye.addEventListener('click', pickWithEyedropper);

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.spellcheck = false;
    hex.maxLength = 7;
    hex.className = 'tt-hex';
    hex.addEventListener('focus', () => { hex._before = captureStyle(toolbarNodeId); });
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value);
      if (!v) return;
      pickerHsv = hexToHsv(v);
      updatePickerUI();
      applyPickerColor(v, true);
    });
    hex.addEventListener('change', () => { pushStyleHistory(toolbarNodeId, hex._before); });

    top.appendChild(eye);
    top.appendChild(hex);
    wrap.appendChild(top);

    const hue = document.createElement('div');
    hue.className = 'tt-hue';
    const hueHandle = document.createElement('div');
    hueHandle.className = 'tt-hue__handle';
    hue.appendChild(hueHandle);
    wrap.appendChild(hue);

    const sv = document.createElement('div');
    sv.className = 'tt-sv';
    const svHandle = document.createElement('div');
    svHandle.className = 'tt-sv__handle';
    sv.appendChild(svHandle);
    wrap.appendChild(sv);

    pickerEls = { wrap, hex, hue, hueHandle, sv, svHandle };
    bindHueDrag(hue);
    bindSvDrag(sv);
    return wrap;
  }

  function bindHueDrag(hue) {
    hue.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pickerDragging = true;
      const before = captureStyle(toolbarNodeId);
      hue.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = hue.getBoundingClientRect();
        pickerHsv.h = clamp01((ev.clientX - r.left) / r.width) * 360;
        updatePickerUI();
        applyPickerColor(hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v), true);
      };
      const up = () => {
        pickerDragging = false;
        hue.removeEventListener('pointermove', move);
        hue.removeEventListener('pointerup', up);
        pushStyleHistory(toolbarNodeId, before);
      };
      hue.addEventListener('pointermove', move);
      hue.addEventListener('pointerup', up);
      move(e);
    });
  }

  function bindSvDrag(sv) {
    sv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pickerDragging = true;
      const before = captureStyle(toolbarNodeId);
      sv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = sv.getBoundingClientRect();
        pickerHsv.s = clamp01((ev.clientX - r.left) / r.width);
        pickerHsv.v = 1 - clamp01((ev.clientY - r.top) / r.height);
        updatePickerUI();
        applyPickerColor(hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v), true);
      };
      const up = () => {
        pickerDragging = false;
        sv.removeEventListener('pointermove', move);
        sv.removeEventListener('pointerup', up);
        pushStyleHistory(toolbarNodeId, before);
      };
      sv.addEventListener('pointermove', move);
      sv.addEventListener('pointerup', up);
      move(e);
    });
  }

  function updatePickerUI() {
    if (!pickerEls) return;
    const hueHex = hsvToHex(pickerHsv.h, 1, 1);
    pickerEls.sv.style.setProperty('--hue', hueHex);
    pickerEls.hueHandle.style.left = (pickerHsv.h / 360 * 100) + '%';
    pickerEls.svHandle.style.left = (pickerHsv.s * 100) + '%';
    pickerEls.svHandle.style.top = ((1 - pickerHsv.v) * 100) + '%';
    pickerEls.svHandle.style.background = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
    if (document.activeElement !== pickerEls.hex) {
      pickerEls.hex.value = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
    }
  }

  function syncPickerFromNode() {
    if (!pickerEls || pickerDragging) return;
    if (document.activeElement === pickerEls.hex) return;
    const n = nodes.get(toolbarNodeId);
    const hex = normalizeHex((n && n.color) || '') || '#1a1a1a';
    pickerHsv = hexToHsv(hex);
    pickerEls.hex.value = hex;
    updatePickerUI();
  }

  function applyPickerColor(hex, live) {
    if (pickerEls && document.activeElement !== pickerEls.hex) pickerEls.hex.value = hex;
    if (!toolbarNodeId) return;
    setNodeStyle(toolbarNodeId, { color: hex }, !!live);
  }

  function pickWithEyedropper() {
    if (!window.EyeDropper) return;
    const before = captureStyle(toolbarNodeId);
    try {
      new window.EyeDropper().open().then(res => {
        const hex = normalizeHex(res && res.sRGBHex);
        if (!hex) return;
        pickerHsv = hexToHsv(hex);
        updatePickerUI();
        applyPickerColor(hex, true);
        pushStyleHistory(toolbarNodeId, before);
      }).catch(() => { /* отменено */ });
    } catch (e) { /* не поддержано */ }
  }

  function toggleToolbarMenu(btn) {
    const name = btn.dataset.menu;
    const menu = textToolbar.querySelector('.tt-menu[data-menu-for="' + name + '"]');
    if (!menu) return;
    if (toolbarMenu && toolbarMenu !== menu) toolbarMenu.classList.add('hidden');
    if (menu.classList.contains('hidden')) {
      if (name === 'color') syncPickerFromNode();
      menu.style.left = btn.offsetLeft + 'px';
      menu.classList.remove('hidden');
      toolbarMenu = menu;
    } else {
      menu.classList.add('hidden');
      toolbarMenu = null;
    }
  }

  function closeToolbarMenu() {
    if (toolbarMenu) { toolbarMenu.classList.add('hidden'); toolbarMenu = null; }
  }

  function pickToolbarMenu(item) {
    const menu = item.closest('.tt-menu');
    const name = menu ? menu.dataset.menuFor : null;
    const value = item.dataset.value;
    closeToolbarMenu();
    if (!toolbarNodeId || !name) return;

    if (name === 'color') setNodeStyle(toolbarNodeId, { color: value });
    else if (name === 'font') setNodeStyle(toolbarNodeId, { fontFamily: value });
    else if (name === 'align') setNodeStyle(toolbarNodeId, { align: value });
    else if (name === 'size') setNodeStyle(toolbarNodeId, { fontSize: Number(value) });
  }

  function captureStyle(id) {
    const n = id && nodes.get(id);
    return n ? { fontFamily: n.fontFamily, fontSize: n.fontSize, color: n.color, align: n.align } : null;
  }

  function pushStyleHistory(id, before) {
    if (!id || !before) return;
    pushHistory({ undo: () => {
      const nn = nodes.get(id);
      const ne = nodeEls.get(id);
      if (!nn) return;
      Object.assign(nn, before);
      if (ne) applyNodeTextStyle(ne, nn);
      if (projectId) window.Store.updateNode(projectId, id, before).catch(() => {});
      updateTextToolbar();
    } });
  }

  function setLabel(role, text) {
    const el = textToolbar && textToolbar.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = text;
  }

  function updateTextToolbar() {
    if (!textToolbar) return;
    const id = selectedIds.size === 1 ? [...selectedIds][0] : null;
    const n = id && nodes.get(id);
    const el = id && nodeEls.get(id);
    if (!n || !el || (n.type !== 'text' && n.type !== 'sticky')) { hideTextToolbar(); return; }

    toolbarNodeId = id;
    textToolbar.classList.remove('hidden');

    setLabel('font', (FONT_FAMILIES.find(f => f.value === (n.fontFamily || '')) || FONT_FAMILIES[0]).label);
    const sz = n.fontSize || DEFAULT_FONT_SIZE;
    const preset = FONT_SIZES.find(s => s.value === sz);
    setLabel('size', preset ? preset.label : sz + 'px');
    const alignLabel = textToolbar.querySelector('[data-role="align"]');
    if (alignLabel) alignLabel.innerHTML = alignSvg(n.align || 'left');
    const dot = textToolbar.querySelector('.tt-dot');
    if (dot) dot.style.background = n.color || '#1a1a1a';

    // Подсветка активных пунктов меню.
    markMenuItem('font', n.fontFamily || '');
    markMenuItem('size', preset ? sz : '__none__');
    markMenuItem('align', n.align || 'left');
    syncPickerFromNode();
    const sizeInput = textToolbar.querySelector('.tt-num');
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = sz;

    const focused = document.activeElement === el;
    ['bold', 'italic', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(c => {
      const btn = textToolbar.querySelector('[data-cmd="' + c + '"]');
      if (!btn) return;
      let on = false;
      if (focused) { try { on = document.queryCommandState(c); } catch (e) { /* ignore */ } }
      btn.classList.toggle('is-active', on);
    });

    const r = el.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    const tw = textToolbar.offsetWidth;
    const th = textToolbar.offsetHeight;
    let left = r.left - vr.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, vr.width - tw - 8));
    let top = r.top - vr.top - th - 10;
    if (top < 8) top = r.bottom - vr.top + 10;
    textToolbar.style.left = left + 'px';
    textToolbar.style.top = top + 'px';
  }

  function hideTextToolbar() {
    if (!textToolbar) return;
    closeToolbarMenu();
    textToolbar.classList.add('hidden');
    toolbarNodeId = null;
  }

  // Выделение сохраняем, только если оно внутри активного элемента.
  function saveSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const el = toolbarNodeId && nodeEls.get(toolbarNodeId);
    if (el && !el.contains(range.startContainer)) return;
    savedRange = range.cloneRange();
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    try { sel.addRange(savedRange); } catch (e) { /* устаревший диапазон */ }
  }

  // Отслеживаем системное выделение текста, чтобы панель не теряла его.
  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const el = toolbarNodeId && nodeEls.get(toolbarNodeId);
    if (el && el.contains(range.startContainer) && el.contains(range.endContainer)) {
      savedRange = range.cloneRange();
    }
  }

  function setNodeStyle(id, patch, live) {
    const n = nodes.get(id);
    const el = nodeEls.get(id);
    if (!n) return;
    const before = captureStyle(id);
    Object.assign(n, patch);
    if (el) applyNodeTextStyle(el, n);
    if (projectId) window.Store.updateNode(projectId, id, patch).catch(handleError);
    if (!live) pushStyleHistory(id, before);
    updateTextToolbar();
  }

  function runTextCommand(cmd, arg) {
    const id = toolbarNodeId;
    const el = id && nodeEls.get(id);
    const n = id && nodes.get(id);
    if (!el || !n) return;
    const before = n.text || '';
    saveSelection();
    el.focus();
    restoreSelection();
    ensureSelectionIn(el);
    try {
      document.execCommand('styleWithCSS', false, cmd !== 'createLink');
      document.execCommand(cmd, false, arg == null ? null : arg);
    } catch (e) { console.error('[format]', e); }
    // Сохраняем разметку с hex-цветами (браузер любит возвращать rgb).
    n.text = rgbToHex(el.innerHTML);
    scheduleTextSave(id);
    pushHistory({ undo: () => {
      const nn = nodes.get(id);
      const ne = nodeEls.get(id);
      if (nn) nn.text = before;
      if (ne) ne.innerHTML = sanitizeHtml(before);
      if (projectId) window.Store.updateNode(projectId, id, { text: before }).catch(handleError);
    } });
    saveSelection();
    updateTextToolbar();
  }

  // Если внутри блока нет активного выделения — берём весь блок целиком,
  // чтобы форматирование применялось ко всему тексту.
  function ensureSelectionIn(el) {
    const sel = window.getSelection();
    if (!sel) return;
    const ok = sel.rangeCount && !sel.isCollapsed &&
      el.contains(sel.anchorNode) && el.contains(sel.focusNode);
    if (ok) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
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
  }

  function undo() {
    if (!history.length) return;
    const entry = history.pop();
    historyLock = true;
    try { entry.undo(); } catch (e) { console.error('[undo]', e); }
    historyLock = false;
  }

  // --- Буфер обмена ---

  function snapshot(node) {
    return {
      id: node.id, type: node.type, x: node.x, y: node.y,
      w: node.w, h: node.h,
      text: node.text || '', src: node.src, createdBy: node.createdBy,
      fontFamily: node.fontFamily, fontSize: node.fontSize,
      color: node.color, align: node.align
    };
  }

  function copySelected() {
    clipboard = [...selectedIds].map(id => nodes.get(id)).filter(Boolean).map(snapshot);
  }

  function cutSelected() {
    if (!selectedIds.size) return;
    copySelected();
    deleteSelected();
  }

  function pasteClipboard() {
    if (!clipboard.length) return;
    const created = clipboard.map(s => ({ ...s, id: window.Store.uid(), x: s.x + 24, y: s.y + 24 }));
    created.forEach(n => placeNode(n, false));
    setSelection(created.map(n => n.id));
    pushHistory({ undo: () => created.forEach(n => removeLocalAndRemote(n.id)) });
  }

  function deleteSelected() {
    if (!selectedIds.size) return;
    const snaps = [];
    selectedIds.forEach(id => { const n = nodes.get(id); if (n) snaps.push(snapshot(n)); });
    if (!snaps.length) return;
    historyLock = true;
    snaps.forEach(s => removeLocalAndRemote(s.id));
    historyLock = false;
    clearSelection();
    pushHistory({
      undo: () => { snaps.forEach(s => placeNode({ ...s }, false)); setSelection(snaps.map(s => s.id)); }
    });
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
    latestPresence = presencePayload();
    window.Presence.update(projectId, latestPresence);
  }

  function onCursorMove(e) {
    if (!projectId || !window.Presence.enabled()) return;
    const p = screenToWorld(e.clientX, e.clientY);
    latestPresence = presencePayload({ x: Math.round(p.x), y: Math.round(p.y) });
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
    viewport.addEventListener('mousemove', onCursorMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('paste', onPaste);
    viewport.addEventListener('dragover', onDragOver);
    viewport.addEventListener('drop', onDrop);

    // Отключаем контекстное меню браузера (в т.ч. Яндекс) на холсте и элементах,
    // но оставляем его в полях ввода (заголовок, текстовые элементы).
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea')) return;
      e.preventDefault();
    });

    document.querySelectorAll('.tool').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    document.getElementById('zoom-in').addEventListener('click', () => zoomAt(zoomStep()));
    document.getElementById('zoom-out').addEventListener('click', () => zoomAt(-zoomStep()));
    document.getElementById('zoom-reset').addEventListener('click', resetView);
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
      if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
      else document.execCommand('insertText', false, text);
      return;
    }

    if (!html && !text) return;
    e.preventDefault();
    const p = viewCenterWorld();
    const content = sanitizeHtml(html) || escapeHtml(text);
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
    pushHistory({ undo: () => removeLocalAndRemote(node.id) });
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
    if (e.target.closest('.text-toolbar')) return;   // клики по панели форматирования

    const handle = e.target.closest('.sel-handle');
    if (handle && e.button === 0 && selectedIds.size === 1) {
      startResize(e, handle.dataset.corner);
      return;
    }

    if (e.button === 1) { startPan(e); return; }   // СКМ — перемещение доски
    if (e.button === 2) { maybeEditFromRmb(e); return; } // ПКМ: выделить / двойной ПКМ — правка
    if (e.button !== 0) return;
    if (spaceDown) { startPan(e); return; }

    if (activeTool !== 'select') {
      const p = screenToWorld(e.clientX, e.clientY);
      if (activeTool === 'image') pickImageAt(p.x, p.y);
      else addNode(activeTool, p.x, p.y);
      setTool('select');
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

  function snapSize(v) { return Math.round(v / RESIZE_STEP) * RESIZE_STEP; }

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
      n.w = Math.round(w);
    } else {
      if (r.corner.indexOf('e') >= 0) w = r.ow + dx;
      if (r.corner.indexOf('w') >= 0) w = r.ow - dx;
      if (r.corner.indexOf('s') >= 0) h = r.oh + dy;
      if (r.corner.indexOf('n') >= 0) h = r.oh - dy;
      w = Math.max(MIN, snapSize(w));
      h = Math.max(MIN, snapSize(h));
      if (r.corner.indexOf('w') >= 0) x = r.ox + (r.ow - w);
      if (r.corner.indexOf('n') >= 0) y = r.oy + (r.oh - h);
      n.w = Math.round(w);
      n.h = Math.round(h);
    }

    n.x = Math.round(x); n.y = Math.round(y);
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    applyNodeBox(el, n);
    updateSelectionBox();
    updateTextToolbar();
    queueLiveMove([n]);
  }

  function endResize() {
    if (!resizing) return;
    const r = resizing;
    resizing = null;
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

    pushHistory({ undo: () => {
      const nn = nodes.get(r.id);
      const ne = nodeEls.get(r.id);
      if (!nn) return;
      nn.x = ox; nn.y = oy; nn.w = ow; nn.h = oh;
      if (ne) { ne.style.left = ox + 'px'; ne.style.top = oy + 'px'; applyNodeBox(ne, nn); }
      const back = { x: ox, y: oy };
      if (ow != null) back.w = ow;
      if (oh != null) back.h = oh;
      if (projectId) window.Store.updateNode(projectId, r.id, back).catch(() => {});
      updateSelectionBox();
    } });
  }

  function startDragGroup(e) {
    const items = [];
    selectedIds.forEach(id => {
      const node = nodes.get(id);
      const el = nodeEls.get(id);
      if (node && el) { items.push({ node, el, ox: node.x, oy: node.y }); draggingIds.add(id); }
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
      const el = nodeEls.get(n.id);
      if (!el) return;
      if (isLockedByOther(n.id)) return;
      const bx2 = n.x + (el.offsetWidth || 0);
      const by2 = n.y + (el.offsetHeight || 0);
      if (r.x < bx2 && r.x2 > n.x && r.y < by2 && r.y2 > n.y) ids.push(n.id);
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
      dragGroup.items.forEach(it => {
        it.node.x = it.ox + dx;
        it.node.y = it.oy + dy;
        it.el.style.left = it.node.x + 'px';
        it.el.style.top = it.node.y + 'px';
      });
      updateSelectionBox();
      updateTextToolbar();
      queueLiveMove(dragGroup.items.map(it => it.node));
    }
  }

  // Другие пользователи видят перемещение элементов в реальном времени.
  function queueLiveMove(nodeList) {
    dragSavePending = nodeList;
    if (dragSaveTimer) return;
    flushLiveMove();
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      if (dragSavePending) flushLiveMove();
    }, 40);
  }

  function flushLiveMove() {
    const list = dragSavePending;
    dragSavePending = null;
    if (!list || !projectId) return;
    list.forEach(node => {
      const patch = { x: Math.round(node.x), y: Math.round(node.y) };
      if (node.w != null) patch.w = Math.round(node.w);
      if (node.h != null) patch.h = Math.round(node.h);
      window.Store.updateNode(projectId, node.id, patch).catch(handleError);
    });
  }

  function onMouseUp() {
    if (resizing) { endResize(); return; }
    if (marquee) { endMarquee(); return; }
    if (panning) { endPan(); scheduleViewSave(); }
    if (dragGroup) { endDragGroup(); }
  }

  function endDragGroup() {
    const items = dragGroup.items;
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragSavePending = null;

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
      pushHistory({
        undo: () => moves.forEach(m => {
          const n = nodes.get(m.id);
          if (!n) return;
          n.x = m.ox; n.y = m.oy;
          const el = nodeEls.get(m.id);
          if (el) { el.style.left = m.ox + 'px'; el.style.top = m.oy + 'px'; }
          if (projectId) window.Store.updateNode(projectId, m.id, { x: m.ox, y: m.oy }).catch(() => {});
        })
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
    if (ctrl && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
      e.preventDefault(); undo(); return;
    }
    if (ctrl && (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С')) { copySelected(); return; }
    if (ctrl && (e.key === 'x' || e.key === 'X' || e.key === 'ч' || e.key === 'Ч')) { cutSelected(); return; }
    if (ctrl && (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М')) { e.preventDefault(); pasteClipboard(); return; }
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

  return { init, load, unload, applyView, resetView, setDefaults };
})();
