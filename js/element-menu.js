// Плавающее меню элемента (контекстное меню выделения).
//
// Показывается рядом с одиночным выделенным элементом:
//   • текст/стикер — панель форматирования текста (шрифт, кегль, цвет, списки, выравнивание);
//   • стрелка — параметры линии (цвет, формат линии, начало и конец линии).
//
// Данные/состояние доски берутся через window.Board.ctx (см. js/board.js).

window.ElementMenu = (function () {
  let root = null;
  let textPanel = null;
  let arrowPanel = null;
  let alignPanel = null;
  let shapePanel = null;
  let nodeId = null;
  let openMenu = null;      // открытое подменю панели
  let savedRange = null;    // сохранённое выделение внутри текста
  // Состояние пикеров: по одному на каждое поле (цвет текста, стрелки, заливка…).
  const pickers = {};
  let pickerField = 'color';

  const ARROW_COLORS = [
    '#1a1a1a', '#6b7280', '#e5484d', '#f76808',
    '#f5c400', '#30a46c', '#0091ff', '#8e4ec6'
  ];
  const FILL_COLORS = [
    '#ffffff', '#f3f4f6', '#ffe8a3', '#f5c400', '#ffd9c2', '#f76808',
    '#f8c8dc', '#e5484d', '#d9cdf7', '#8e4ec6', '#c9e6ff', '#0091ff',
    '#c8f0d8', '#30a46c', '#e6e8eb', '#1a1a1a'
  ];
  const STROKE_STYLES = [
    { value: 'solid', label: 'Сплошная' },
    { value: 'dashed', label: 'Пунктирная' },
    { value: 'none', label: 'Отсутствует' }
  ];
  const LINE_STYLES = [
    { value: 'solid', label: 'Сплошная', dash: '' },
    { value: 'dashed', label: 'Пунктирная', dash: '6 4' },
    { value: 'dotted', label: 'Точками', dash: '1 4' },
    { value: 'dashdot', label: 'Точка-тире', dash: '8 3 1 3' }
  ];
  const CAPS = [
    { value: 'none', label: 'Без конца' },
    { value: 'arrow', label: 'Стрелка' },
    { value: 'triangle', label: 'Треугольник' },
    { value: 'circle', label: 'Круг' },
    { value: 'diamond', label: 'Ромб' }
  ];
  const SHAPES = [
    { value: 'straight', label: 'Прямая' },
    { value: 'curved', label: 'Гибкая (360°)' },
    { value: 'elbow', label: 'Гибкая (вручную)' }
  ];

  function ctx() { return window.Board && window.Board.ctx; }
  function C() { return ctx().consts; }

  // ---------- Инициализация ----------

  function init() {
    const c = ctx();
    if (!c) return;
    build();
    document.addEventListener('selectionchange', onSelectionChange);
  }

  function build() {
    root = document.createElement('div');
    root.className = 'text-toolbar element-menu hidden';
    textPanel = buildTextPanel();
    arrowPanel = buildArrowPanel();
    arrowPanel.classList.add('hidden');
    alignPanel = buildAlignPanel();
    alignPanel.classList.add('hidden');
    shapePanel = buildShapePanel();
    shapePanel.classList.add('hidden');
    root.appendChild(textPanel);
    root.appendChild(arrowPanel);
    root.appendChild(alignPanel);
    root.appendChild(shapePanel);

    root.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    root.addEventListener('click', onRootClick);

    ctx().viewport().appendChild(root);
  }

  function onRootClick(e) {
    if (e.target.closest('input')) return;

    const al = e.target.closest('[data-align]');
    if (al) { ctx().alignSelection(al.dataset.align); return; }
    const di = e.target.closest('[data-distribute]');
    if (di) { ctx().distributeSelection(di.dataset.distribute); return; }

    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) { toggleMenu(menuBtn); return; }

    const item = e.target.closest('[data-value]');
    if (item) { pickMenu(item); return; }

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
  }

  // ---------- Обновление/скрытие ----------

  function update() {
    if (!root) return;

    // Множественное выделение — панель выравнивания.
    const count = ctx().selectionCount();
    if (count >= 2) {
      nodeId = null;
      closeMenu();
      const b = ctx().selectionBounds();
      if (!b) { hide(); return; }
      textPanel.classList.add('hidden');
      arrowPanel.classList.add('hidden');
      shapePanel.classList.add('hidden');
      alignPanel.classList.remove('hidden');
      alignPanel.querySelectorAll('[data-distribute]').forEach(btn => { btn.disabled = count < 3; });
      root.classList.remove('hidden');
      const a = ctx().worldToScreen(b.x, b.y);
      const bb = ctx().worldToScreen(b.x + b.w, b.y + b.h);
      position({ left: a.x, top: a.y, right: bb.x, bottom: bb.y, width: bb.x - a.x, height: bb.y - a.y });
      return;
    }

    const id = ctx().singleId();
    const n = id && ctx().getNode(id);
    const el = id && ctx().getEl(id);
    const isText = n && (n.type === 'text' || n.type === 'sticky');
    const isArrow = n && n.type === 'arrow';
    const isShape = n && n.type === 'frame';
    if (!n || !el || (!isText && !isArrow && !isShape)) { hide(); return; }

    // Меню закрываем только при переходе к другому объекту, а не при каждом
    // обновлении панели — иначе палитра исчезает после первого же цвета.
    if (id !== nodeId) closeMenu();
    nodeId = id;
    root.classList.remove('hidden');
    alignPanel.classList.add('hidden');
    textPanel.classList.toggle('hidden', !isText);
    arrowPanel.classList.toggle('hidden', !isArrow);
    shapePanel.classList.toggle('hidden', !isShape);

    if (isArrow) { pickerField = 'arrow-color'; updateArrowPanel(n); }
    else if (isShape) { pickerField = 'frame-fill'; updateShapePanel(n); }
    else { pickerField = 'color'; updateTextPanel(n, el); }

    position(el.getBoundingClientRect());
  }

  function hide() {
    if (!root) return;
    closeMenu();
    root.classList.add('hidden');
    nodeId = null;
  }

  function position(r) {
    const vr = ctx().viewport().getBoundingClientRect();
    const tw = root.offsetWidth;
    const th = root.offsetHeight;
    let left = r.left - vr.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, vr.width - tw - 8));
    let top = r.top - vr.top - th - 10;
    if (top < 8) top = r.bottom - vr.top + 10;
    root.style.left = left + 'px';
    root.style.top = top + 'px';
  }

  // ---------- Текстовая панель ----------

  function buildTextPanel() {
    const panel = document.createElement('div');
    panel.className = 'em-panel';
    panel.innerHTML =
      '<button class="tt-btn" data-menu="color" title="Цвет текста"><span class="tt-dot"></span><span class="tt-caret">▾</span></button>' +
      '<button class="tt-btn hidden" data-role="fill-btn" data-menu="sticky-bg" title="Цвет фона стикера"><span class="tt-dot" data-role="fill-dot"></span><span class="tt-caret">▾</span></button>' +
      '<button class="tt-btn" data-menu="font" title="Шрифт"><span class="tt-label" data-role="font">Simple</span><span class="tt-caret">▾</span></button>' +
      '<button class="tt-btn" data-menu="size" title="Размер текста"><span class="tt-label" data-role="size">Small</span><span class="tt-caret">▾</span></button>' +
      '<span class="tt-sep"></span>' +
      '<button class="tt-btn" data-cmd="bold" title="Жирный"><b>B</b></button>' +
      '<button class="tt-btn" data-cmd="italic" title="Курсив"><i>I</i></button>' +
      '<button class="tt-btn" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>' +
      '<button class="tt-btn" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>' +
      '<button class="tt-btn" data-cmd="link" title="Ссылка">🔗</button>' +
      '<button class="tt-btn" data-cmd="insertUnorderedList" title="Маркированный список">☰</button>' +
      '<button class="tt-btn" data-cmd="insertOrderedList" title="Нумерованный список">1.</button>' +
      '<span class="tt-sep"></span>' +
      '<button class="tt-btn" data-menu="align" title="Выравнивание"><span class="tt-label" data-role="align">⯇</span><span class="tt-caret">▾</span></button>';

    // Меню шрифта (с предпросмотром).
    const fontMenu = mkMenu('font');
    C().FONT_FAMILIES.forEach(f => {
      const b = mkMenuItem(f.label, f.value);
      b.style.fontFamily = f.value || '';
      fontMenu.appendChild(b);
    });

    // Меню размера: заготовки + ручной ввод.
    const sizeMenu = mkMenu('size');
    C().FONT_SIZES.forEach(s => sizeMenu.appendChild(mkMenuItem(s.label, String(s.value))));
    const divider = document.createElement('div');
    divider.className = 'tt-divider';
    sizeMenu.appendChild(divider);
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = '6';
    sizeInput.max = '400';
    sizeInput.className = 'tt-num';
    sizeInput.placeholder = 'px';
    sizeInput.addEventListener('focus', () => { sizeInput._before = captureStyle(nodeId); });
    sizeInput.addEventListener('input', () => {
      if (!nodeId) return;
      const px = Math.round(Number(sizeInput.value));
      if (isFinite(px) && px >= 6 && px <= 400) setNodeStyle(nodeId, { fontSize: px }, true);
    });
    sizeInput.addEventListener('change', () => { pushStyleHistory(nodeId, sizeInput._before); });
    sizeMenu.appendChild(sizeInput);

    // Меню цвета: hex-пикер + палитра.
    const colorMenu = mkMenu('color');
    colorMenu.classList.add('tt-picker');
    colorMenu.appendChild(buildColorPicker('color'));
    colorMenu.appendChild(swatchRow(C().TEXT_COLORS.concat(C().TEXT_COLORS_LIGHT)));

    // Фон стикера — та же палитра и пикер, что и у текста.
    const fillMenu = mkMenu('sticky-bg');
    fillMenu.classList.add('tt-picker');
    fillMenu.appendChild(buildColorPicker('sticky-bg'));
    fillMenu.appendChild(swatchRow(FILL_COLORS));

    // Меню выравнивания.
    const alignMenu = mkMenu('align');
    C().ALIGN_ITEMS.forEach(a => alignMenu.appendChild(mkAlignItem(a)));

    [fontMenu, sizeMenu, colorMenu, fillMenu, alignMenu].forEach(m => root_appendLater(panel, m));
    return panel;
  }

  // Подменю крепим к корню панели (позиционируются относительно .text-toolbar).
  const deferredMenus = [];
  function root_appendLater(panel, menu) {
    deferredMenus.push(menu);
    return panel;
  }

  // Ряд цветовых образцов для любой палитры (текст, стрелки, заливка, обводка).
  function swatchRow(colors) {
    const row = document.createElement('div');
    row.className = 'tt-swatches';
    colors.forEach(col => {
      const b = document.createElement('button');
      b.className = 'tt-swatch-btn';
      b.dataset.value = col;
      b.title = col;
      b.innerHTML = '<span class="tt-swatch" style="background:' + col + '"></span>';
      row.appendChild(b);
    });
    return row;
  }

  function updateTextPanel(n, el) {
    // Домешиваем отложенные подменю (один раз).
    if (deferredMenus.length) {
      deferredMenus.forEach(m => root.appendChild(m));
      deferredMenus.length = 0;
    }

    setLabel('font', (C().FONT_FAMILIES.find(f => f.value === (n.fontFamily || '')) || C().FONT_FAMILIES[0]).label);
    const sz = n.fontSize || C().DEFAULT_FONT_SIZE;
    const preset = C().FONT_SIZES.find(s => s.value === sz);
    setLabel('size', preset ? preset.label : sz + 'px');
    const alignLabel = root.querySelector('[data-role="align"]');
    if (alignLabel) alignLabel.innerHTML = alignSvg(n.align || 'left');
    const dot = textPanel.querySelector('.tt-dot');
    if (dot) dot.style.background = n.color || '#1a1a1a';
    const fillBtn = textPanel.querySelector('[data-role="fill-btn"]');
    if (fillBtn) fillBtn.classList.toggle('hidden', n.type !== 'sticky');
    const fillDot = textPanel.querySelector('[data-role="fill-dot"]');
    if (fillDot) fillDot.style.background = n.fill || '#f5c400';
    markMenuItem('sticky-bg', n.fill || '');

    markMenuItem('font', n.fontFamily || '');
    markMenuItem('size', preset ? sz : '__none__');
    markMenuItem('align', n.align || 'left');
    syncPickerFromNode('color');
    syncPickerFromNode('sticky-bg');
    const sizeInput = textPanel.querySelector('.tt-num');
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = sz;

    const focused = document.activeElement === el;
    ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(c => {
      const btn = textPanel.querySelector('[data-cmd="' + c + '"]');
      if (!btn) return;
      let on = false;
      if (focused) { try { on = document.queryCommandState(c); } catch (e) { /* ignore */ } }
      btn.classList.toggle('is-active', on);
    });
  }

  // ---------- Панель стрелки ----------

  function buildArrowPanel() {
    const panel = document.createElement('div');
    panel.className = 'em-panel';

    // Цвет линии: такой же пикер и палитра, как у текста.
    panel.appendChild(mkMenuBtn('arrow-color', 'Цвет линии', '<span class="em-color-dot" data-role="arrow-dot"></span>'));
    const colorMenu = mkMenu('arrow-color');
    colorMenu.classList.add('tt-picker');
    colorMenu.appendChild(buildColorPicker('arrow-color'));
    colorMenu.appendChild(swatchRow(ARROW_COLORS.concat(FILL_COLORS.slice(0, 8))));
    root_appendLater(panel, colorMenu);

    panel.appendChild(sep());

    // Форма стрелки: прямая / гибкая с углами / гибкая дугой.
    panel.appendChild(mkMenuBtn('arrow-shape', 'Форма', '<span data-role="shape">' + shapeIcon('straight') + '</span>'));
    const shapeMenu = mkMenu('arrow-shape');
    SHAPES.forEach(s => shapeMenu.appendChild(mkArrowMenuItem(s.value, s.label, shapeIcon(s.value))));
    root_appendLater(panel, shapeMenu);

    // Формат линии.
    panel.appendChild(mkMenuBtn('arrow-line', 'Формат линии', '<span data-role="line">' + lineIcon('') + '</span>'));
    const lineMenu = mkMenu('arrow-line');
    LINE_STYLES.forEach(ls => lineMenu.appendChild(mkArrowMenuItem(ls.value, ls.label, lineIcon(ls.dash))));
    root_appendLater(panel, lineMenu);

    // Начало линии.
    panel.appendChild(mkMenuBtn('arrow-start', 'Начало линии', '<span data-role="start">' + capIcon('none', true) + '</span>'));
    const startMenu = mkMenu('arrow-start');
    CAPS.forEach(c => startMenu.appendChild(mkArrowMenuItem(c.value, 'Начало: ' + c.label, capIcon(c.value, true))));
    root_appendLater(panel, startMenu);

    // Конец линии.
    panel.appendChild(mkMenuBtn('arrow-end', 'Конец линии', '<span data-role="end">' + capIcon('arrow', false) + '</span>'));
    const endMenu = mkMenu('arrow-end');
    CAPS.forEach(c => endMenu.appendChild(mkArrowMenuItem(c.value, 'Конец: ' + c.label, capIcon(c.value, false))));
    root_appendLater(panel, endMenu);

    return panel;
  }

  function mkMenuBtn(name, title, inner) {
    const b = document.createElement('button');
    b.className = 'tt-btn';
    b.title = title;
    b.dataset.menu = name;
    b.innerHTML = inner + '<span class="tt-caret">▾</span>';
    return b;
  }

  function mkArrowMenuItem(value, label, icon) {
    const b = document.createElement('button');
    b.className = 'tt-menu__item';
    b.dataset.value = value;
    b.innerHTML = '<span class="tt-check">✓</span>' + icon + '<span class="tt-menu__label"></span>';
    b.querySelector('.tt-menu__label').textContent = label;
    return b;
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'tt-sep';
    return s;
  }

  // ---------- Панель фигуры (рамки) ----------

  function buildShapePanel() {
    const panel = document.createElement('div');
    panel.className = 'em-panel em-shape';

    // Заливка.
    panel.appendChild(mkMenuBtn('frame-fill', 'Цвет заливки', '<span class="em-color-dot" data-role="fill-dot"></span>'));
    const fillMenu = mkMenu('frame-fill');
    fillMenu.classList.add('tt-picker');
    fillMenu.appendChild(buildColorPicker('frame-fill'));
    fillMenu.appendChild(swatchRow(FILL_COLORS));
    root_appendLater(panel, fillMenu);

    panel.appendChild(sep());

    // Цвет обводки.
    panel.appendChild(mkMenuBtn('frame-stroke', 'Цвет обводки', '<span class="em-color-dot" data-role="stroke-dot"></span>'));
    const strokeMenu = mkMenu('frame-stroke');
    strokeMenu.classList.add('tt-picker');
    strokeMenu.appendChild(buildColorPicker('frame-stroke'));
    strokeMenu.appendChild(swatchRow(ARROW_COLORS));
    root_appendLater(panel, strokeMenu);

    // Формат обводки.
    panel.appendChild(mkMenuBtn('frame-stroke-style', 'Формат обводки', '<span class="tt-label" data-role="stroke-style">Сплошная</span>'));
    const styleMenu = mkMenu('frame-stroke-style');
    STROKE_STYLES.forEach(s => styleMenu.appendChild(mkMenuItem(s.label, s.value)));
    root_appendLater(panel, styleMenu);

    // Толщина обводки.
    panel.appendChild(mkMenuBtn('frame-stroke-width', 'Толщина обводки', '<span class="tt-label" data-role="stroke-width">2 px</span>'));
    const widthMenu = mkMenu('frame-stroke-width');
    [1, 2, 3, 4, 6, 8].forEach(px => {
      widthMenu.appendChild(mkMenuItem(px + ' px', String(px)));
    });
    root_appendLater(panel, widthMenu);

    // Прозрачность.
    panel.appendChild(mkMenuBtn('frame-opacity', 'Прозрачность', '<span class="tt-label" data-role="opacity">100%</span>'));
    const opacityMenu = mkMenu('frame-opacity');
    [100, 75, 50, 25, 0].forEach(pct => {
      const b = mkMenuItem(pct + '%', String(pct / 100));
      opacityMenu.appendChild(b);
    });
    const divider = document.createElement('div');
    divider.className = 'tt-divider';
    opacityMenu.appendChild(divider);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '1';
    range.value = '100';
    range.className = 'tt-opacity';
    range.addEventListener('focus', () => { range._before = captureStyle(nodeId); });
    range.addEventListener('input', () => {
      if (!nodeId) return;
      setNodeStyle(nodeId, { opacity: Number(range.value) / 100 }, true);
    });
    range.addEventListener('change', () => { pushStyleHistory(nodeId, range._before); });
    opacityMenu.appendChild(range);
    root_appendLater(panel, opacityMenu);

    return panel;
  }

  function updateShapePanel(n) {
    if (deferredMenus.length) {
      deferredMenus.forEach(m => root.appendChild(m));
      deferredMenus.length = 0;
    }
    const fillDot = shapePanel.querySelector('[data-role="fill-dot"]');
    if (fillDot) fillDot.style.background = n.fill || '#ffffff';
    const strokeDot = shapePanel.querySelector('[data-role="stroke-dot"]');
    if (strokeDot) strokeDot.style.background = n.stroke || '#b9bfcb';
    const styleLabel = shapePanel.querySelector('[data-role="stroke-style"]');
    const style = n.strokeStyle || 'dashed';
    if (styleLabel) {
      const found = STROKE_STYLES.find(s => s.value === style);
      styleLabel.textContent = found ? found.label : 'Пунктирная';
    }
    const width = Number(n.strokeWidth) || 2;
    const widthLabel = shapePanel.querySelector('[data-role="stroke-width"]');
    if (widthLabel) widthLabel.textContent = width + ' px';
    const pct = Math.round((n.opacity == null ? 1 : n.opacity) * 100);
    const opLabel = shapePanel.querySelector('[data-role="opacity"]');
    if (opLabel) opLabel.textContent = pct + '%';
    const range = shapePanel.querySelector('.tt-opacity');
    if (range && document.activeElement !== range) range.value = String(pct);

    markMenuItem('frame-fill', n.fill || '');
    markMenuItem('frame-stroke', n.stroke || '');
    syncPickerFromNode('frame-fill');
    syncPickerFromNode('frame-stroke');
    markMenuItem('frame-stroke-style', style);
    markMenuItem('frame-stroke-width', String(width));
    markMenuItem('frame-opacity', String(n.opacity == null ? 1 : n.opacity));
  }

  // ---------- Панель выравнивания (мультивыделение) ----------

  function buildAlignPanel() {
    const panel = document.createElement('div');
    panel.className = 'em-panel em-align';
    const defs = [
      ['left', 'По левому краю'],
      ['center', 'По центру (по горизонтали)'],
      ['right', 'По правому краю'],
      ['top', 'По верхнему краю'],
      ['middle', 'По центру (по вертикали)'],
      ['bottom', 'По нижнему краю']
    ];
    defs.forEach((d, i) => {
      if (i === 3) panel.appendChild(sep());
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tt-btn em-align-btn';
      b.title = d[1];
      b.dataset.align = d[0];
      b.innerHTML = alignIco(d[0]);
      panel.appendChild(b);
    });
    panel.appendChild(sep());
    [['h', 'Распределить по горизонтали'], ['v', 'Распределить по вертикали']].forEach(d => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tt-btn em-align-btn';
      b.title = d[1];
      b.dataset.distribute = d[0];
      b.innerHTML = distributeIco(d[0]);
      panel.appendChild(b);
    });
    return panel;
  }

  function alignIco(kind) {
    const W = 18, H = 18;
    const guide = {
      left: 'M2 1 V17', center: 'M9 1 V17', right: 'M16 1 V17',
      top: 'M1 2 H17', middle: 'M1 9 H17', bottom: 'M1 16 H17'
    }[kind];
    let bars = '';
    if (kind === 'left' || kind === 'center' || kind === 'right') {
      const ws = [12, 7, 12, 7];
      [3, 7, 11, 15].forEach((y, i) => {
        const w = ws[i];
        let x = 2;
        if (kind === 'center') x = (W - w) / 2;
        else if (kind === 'right') x = W - 2 - w;
        bars += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="2.2" rx="1.1"/>';
      });
    } else {
      const hs = [12, 7, 12, 7];
      [3, 7, 11, 15].forEach((x, i) => {
        const h = hs[i];
        let y = 2;
        if (kind === 'middle') y = (H - h) / 2;
        else if (kind === 'bottom') y = H - 2 - h;
        bars += '<rect x="' + x + '" y="' + y + '" width="2.2" height="' + h + '" rx="1.1"/>';
      });
    }
    return '<svg class="em-align-ico" viewBox="0 0 18 18">' +
      '<path d="' + guide + '" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '<g fill="currentColor">' + bars + '</g></svg>';
  }

  function distributeIco(axis) {
    if (axis === 'h') {
      return '<svg class="em-align-ico" viewBox="0 0 18 18" fill="currentColor">' +
        '<rect x="1" y="4" width="3" height="10" rx="1"/><rect x="7.5" y="4" width="3" height="10" rx="1"/>' +
        '<rect x="14" y="4" width="3" height="10" rx="1"/></svg>';
    }
    return '<svg class="em-align-ico" viewBox="0 0 18 18" fill="currentColor">' +
      '<rect x="4" y="1" width="10" height="3" rx="1"/><rect x="4" y="7.5" width="10" height="3" rx="1"/>' +
      '<rect x="4" y="14" width="10" height="3" rx="1"/></svg>';
  }

  function updateArrowPanel(n) {
    if (deferredMenus.length) { deferredMenus.forEach(m => root.appendChild(m)); deferredMenus.length = 0; }
    const color = n.color || '#1a1a1a';
    const shape = n.shape || 'straight';
    const line = n.lineStyle || 'solid';
    const start = n.startCap || 'none';
    const end = n.endCap || 'arrow';

    const dot = arrowPanel.querySelector('.em-color-dot');
    if (dot) dot.style.background = color;

    const setPreview = (role, svg) => {
      const el = arrowPanel.querySelector('[data-role="' + role + '"]');
      if (el) el.innerHTML = svg;
    };
    setPreview('shape', shapeIcon(shape));
    const ls = LINE_STYLES.find(x => x.value === line) || LINE_STYLES[0];
    setPreview('line', lineIcon(ls.dash));
    setPreview('start', capIcon(start, true));
    setPreview('end', capIcon(end, false));

    markMenuItem('arrow-color', color);
    syncPickerFromNode('arrow-color');
    markMenuItem('arrow-shape', shape);
    markMenuItem('arrow-line', line);
    markMenuItem('arrow-start', start);
    markMenuItem('arrow-end', end);
  }

  // ---------- Иконки ----------

  function lineIcon(dash) {
    const d = dash ? ' stroke-dasharray="' + dash + '"' : '';
    return '<svg width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"><line x1="1" y1="7" x2="21" y2="7"' + d + '/></svg>';
  }

  function shapeIcon(kind) {
    const s = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    if (kind === 'elbow') {
      return '<svg width="22" height="14" viewBox="0 0 22 14"><path d="M2 2 H11 V12 H20" ' + s + '/></svg>';
    }
    if (kind === 'curved') {
      return '<svg width="22" height="14" viewBox="0 0 22 14"><path d="M2 2 C 11 2 11 12 20 12" ' + s + '/></svg>';
    }
    return '<svg width="22" height="14" viewBox="0 0 22 14"><path d="M2 12 L20 2" ' + s + '/></svg>';
  }

  function capIcon(kind, start) {
    // Рисуем линию и наконечник на её правом (для end) / левом (для start) конце.
    const line = '<line x1="1" y1="7" x2="21" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
    let cap = '';
    if (start) {
      if (kind === 'arrow') cap = '<path d="M1 7 L9 3 L9 11 Z" fill="currentColor"/>';
      else if (kind === 'triangle') cap = '<path d="M1 7 L10 2.5 L10 11.5 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>';
      else if (kind === 'circle') cap = '<circle cx="5" cy="7" r="3.4" fill="none" stroke="currentColor" stroke-width="1.3"/>';
      else if (kind === 'diamond') cap = '<path d="M1 7 L5 3.5 L9 7 L5 10.5 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>';
    } else {
      if (kind === 'arrow') cap = '<path d="M21 7 L13 3 L13 11 Z" fill="currentColor"/>';
      else if (kind === 'triangle') cap = '<path d="M21 7 L12 2.5 L12 11.5 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>';
      else if (kind === 'circle') cap = '<circle cx="17" cy="7" r="3.4" fill="none" stroke="currentColor" stroke-width="1.3"/>';
      else if (kind === 'diamond') cap = '<path d="M21 7 L17 3.5 L13 7 L17 10.5 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>';
    }
    return '<svg width="22" height="14" viewBox="0 0 22 14">' + line + cap + '</svg>';
  }

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

  // ---------- Подменю ----------

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

  function mkAlignItem(item) {
    const b = document.createElement('button');
    b.className = 'tt-menu__item';
    b.dataset.value = item.value;
    b.innerHTML = '<span class="tt-check">✓</span>' + alignSvg(item.value) +
      '<span class="tt-menu__label"></span>';
    b.querySelector('.tt-menu__label').textContent = item.label;
    return b;
  }

  function markMenuItem(name, value) {
    const menu = root && root.querySelector('.tt-menu[data-menu-for="' + name + '"]');
    if (!menu) return;
    menu.querySelectorAll('[data-value]').forEach(b =>
      b.classList.toggle('is-active', b.dataset.value === String(value)));
  }

  function toggleMenu(btn) {
    const name = btn.dataset.menu;
    const menu = root.querySelector('.tt-menu[data-menu-for="' + name + '"]');
    if (!menu) return;
    if (openMenu && openMenu !== menu) openMenu.classList.add('hidden');
    if (menu.classList.contains('hidden')) {
      if (pickers[name]) { pickerField = name; syncPickerFromNode(name); }
      menu.style.left = btn.offsetLeft + 'px';
      menu.classList.remove('hidden');
      openMenu = menu;
    } else {
      menu.classList.add('hidden');
      openMenu = null;
    }
  }

  function closeMenu() {
    if (openMenu) { openMenu.classList.add('hidden'); openMenu = null; }
  }

  function pickMenu(item) {
    const menu = item.closest('.tt-menu');
    const name = menu ? menu.dataset.menuFor : null;
    const value = item.dataset.value;
    // Палитру не закрываем: пользователь может подобрать несколько цветов.
    if (!nodeId || !name) return;
    const c = ctx();
    if (name === 'color') setNodeStyle(nodeId, { color: value });
    else if (name === 'font') setNodeStyle(nodeId, { fontFamily: value });
    else if (name === 'align') setNodeStyle(nodeId, { align: value });
    else if (name === 'size') setNodeStyle(nodeId, { fontSize: Number(value) });
    else if (name === 'sticky-bg' || name === 'frame-fill') setNodeStyle(nodeId, { fill: value });
    else if (name === 'frame-stroke') setNodeStyle(nodeId, { stroke: value });
    else if (name === 'frame-stroke-style') setNodeStyle(nodeId, { strokeStyle: value });
    else if (name === 'frame-stroke-width') setNodeStyle(nodeId, { strokeWidth: Number(value) });
    else if (name === 'frame-opacity') setNodeStyle(nodeId, { opacity: Number(value) });
    else if (name === 'arrow-color') c.setArrowStyle(nodeId, { color: value });
    else if (name === 'arrow-shape') c.setArrowStyle(nodeId, { shape: value });
    else if (name === 'arrow-line') c.setArrowStyle(nodeId, { lineStyle: value });
    else if (name === 'arrow-start') c.setArrowStyle(nodeId, { startCap: value });
    else if (name === 'arrow-end') c.setArrowStyle(nodeId, { endCap: value });
    if (name && name.indexOf('arrow-') === 0) update();
  }

  function setLabel(role, text) {
    const el = textPanel && textPanel.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = text;
  }

  // ---------- Применение стилей ----------

  function setNodeStyle(id, patch, live) {
    const c = ctx();
    const n = c.getNode(id);
    const el = c.getEl(id);
    if (!n) return;
    const before = captureStyle(id);
    Object.assign(n, patch);
    if (el) { c.applyTextStyle(el, n); c.applyAppearance(el, n); }
    if (c.projectId()) window.Store.updateNode(c.projectId(), id, patch).catch(() => {});
    if (!live) pushStyleHistory(id, before);
    update();
  }

  function captureStyle(id) {
    const n = ctx().getNode(id);
    return n ? {
      fontFamily: n.fontFamily, fontSize: n.fontSize, color: n.color, align: n.align,
      fill: n.fill, stroke: n.stroke, strokeStyle: n.strokeStyle,
      strokeWidth: n.strokeWidth, opacity: n.opacity
    } : null;
  }

  function pushStyleHistory(id, before) {
    if (!id || !before) return;
    const c = ctx();
    const after = captureStyle(id);
    const applyStyle = value => {
      const nn = c.getNode(id);
      const ne = c.getEl(id);
      if (!nn) return;
      Object.assign(nn, value);
      if (ne) { c.applyTextStyle(ne, nn); c.applyAppearance(ne, nn); }
      if (c.projectId()) window.Store.updateNode(c.projectId(), id, value).catch(() => {});
      update();
    };
    c.pushHistory({
      undo: () => applyStyle(before),
      redo: () => applyStyle(after)
    });
  }

  function runTextCommand(cmd, arg) {
    const c = ctx();
    const id = nodeId;
    const el = id && c.getEl(id);
    const n = id && c.getNode(id);
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
    n.text = c.rgbToHex(el.innerHTML);
    const after = n.text || '';
    c.scheduleTextSave(id);
    const applyText = value => {
      const nn = c.getNode(id);
      const ne = c.getEl(id);
      if (nn) nn.text = value;
      if (ne) ne.innerHTML = c.sanitize(value);
      if (c.projectId()) window.Store.updateNode(c.projectId(), id, { text: value }).catch(() => {});
    };
    c.pushHistory({
      undo: () => applyText(before),
      redo: () => applyText(after)
    });
    saveSelection();
    update();
  }

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

  function saveSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const el = nodeId && ctx().getEl(nodeId);
    if (el && !el.contains(range.startContainer)) return;
    savedRange = range.cloneRange();
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    try { sel.addRange(savedRange); } catch (e) { /* устаревший диапазон */ }
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const el = nodeId && ctx().getEl(nodeId);
    if (el && el.contains(range.startContainer) && el.contains(range.endContainer)) {
      savedRange = range.cloneRange();
    }
  }

  // ---------- Hex-пикер цвета ----------

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

  function buildColorPicker(field) {
    const state = { field, els: null, hsv: { h: 0, s: 0, v: 0.9 }, dragging: false };
    pickers[field] = state;
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
    eye.addEventListener('click', () => pickWithEyedropper(field));

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.spellcheck = false;
    hex.maxLength = 7;
    hex.className = 'tt-hex';
    hex.addEventListener('focus', () => { hex._before = captureStyle(nodeId); });
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value);
      if (!v) return;
      state.hsv = hexToHsv(v);
      updatePickerUI(state);
      applyPickerColor(field, v, true);
    });
    hex.addEventListener('change', () => { pushStyleHistory(nodeId, hex._before); });

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

    state.els = { wrap, hex, hue, hueHandle, sv, svHandle };
    bindHueDrag(hue, state);
    bindSvDrag(sv, state);
    return wrap;
  }

  function bindHueDrag(hue, state) {
    hue.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      state.dragging = true;
      const before = captureStyle(nodeId);
      hue.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = hue.getBoundingClientRect();
        state.hsv.h = clamp01((ev.clientX - r.left) / r.width) * 360;
        updatePickerUI(state);
        applyPickerColor(state.field, hsvToHex(state.hsv.h, state.hsv.s, state.hsv.v), true);
      };
      const up = () => {
        state.dragging = false;
        hue.removeEventListener('pointermove', move);
        hue.removeEventListener('pointerup', up);
        pushStyleHistory(nodeId, before);
      };
      hue.addEventListener('pointermove', move);
      hue.addEventListener('pointerup', up);
      move(e);
    });
  }

  function bindSvDrag(sv, state) {
    sv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      state.dragging = true;
      const before = captureStyle(nodeId);
      sv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = sv.getBoundingClientRect();
        state.hsv.s = clamp01((ev.clientX - r.left) / r.width);
        state.hsv.v = 1 - clamp01((ev.clientY - r.top) / r.height);
        updatePickerUI(state);
        applyPickerColor(state.field, hsvToHex(state.hsv.h, state.hsv.s, state.hsv.v), true);
      };
      const up = () => {
        state.dragging = false;
        sv.removeEventListener('pointermove', move);
        sv.removeEventListener('pointerup', up);
        pushStyleHistory(nodeId, before);
      };
      sv.addEventListener('pointermove', move);
      sv.addEventListener('pointerup', up);
      move(e);
    });
  }

  function updatePickerUI(state) {
    if (!state || !state.els) return;
    const hueHex = hsvToHex(state.hsv.h, 1, 1);
    state.els.sv.style.setProperty('--hue', hueHex);
    state.els.hueHandle.style.left = (state.hsv.h / 360 * 100) + '%';
    state.els.svHandle.style.left = (state.hsv.s * 100) + '%';
    state.els.svHandle.style.top = ((1 - state.hsv.v) * 100) + '%';
    state.els.svHandle.style.background = hsvToHex(state.hsv.h, state.hsv.s, state.hsv.v);
    if (document.activeElement !== state.els.hex) {
      state.els.hex.value = hsvToHex(state.hsv.h, state.hsv.s, state.hsv.v);
    }
  }

  function pickerProp(field) {
    if (field === 'arrow-color') return 'color';
    if (field === 'frame-fill' || field === 'sticky-bg') return 'fill';
    if (field === 'frame-stroke') return 'stroke';
    return 'color';
  }

  function syncPickerFromNode(field) {
    const state = pickers[field];
    if (!state || !state.els || state.dragging) return;
    if (document.activeElement === state.els.hex) return;
    const n = nodeId && ctx().getNode(nodeId);
    const defaults = {
      color: '#1a1a1a', 'arrow-color': '#1a1a1a',
      'sticky-bg': '#f5c400', 'frame-fill': '#ffffff', 'frame-stroke': '#b9bfcb'
    };
    const hex = normalizeHex((n && n[pickerProp(field)]) || '') || defaults[field] || '#1a1a1a';
    state.hsv = hexToHsv(hex);
    state.els.hex.value = hex;
    updatePickerUI(state);
  }

  function applyPickerColor(field, hex, live) {
    const state = pickers[field];
    if (state && state.els && document.activeElement !== state.els.hex) state.els.hex.value = hex;
    if (!nodeId) return;
    if (field === 'arrow-color') ctx().setArrowStyle(nodeId, { color: hex }, !!live);
    else if (field === 'frame-fill' || field === 'sticky-bg') setNodeStyle(nodeId, { fill: hex }, !!live);
    else if (field === 'frame-stroke') setNodeStyle(nodeId, { stroke: hex }, !!live);
    else setNodeStyle(nodeId, { color: hex }, !!live);
  }

  function pickWithEyedropper(field) {
    if (!window.EyeDropper) return;
    const before = captureStyle(nodeId);
    try {
      new window.EyeDropper().open().then(res => {
        const hex = normalizeHex(res && res.sRGBHex);
        if (!hex) return;
        const state = pickers[field];
        if (state) state.hsv = hexToHsv(hex);
        updatePickerUI(state);
        applyPickerColor(field, hex, true);
        pushStyleHistory(nodeId, before);
      }).catch(() => { /* отменено */ });
    } catch (e) { /* не поддержано */ }
  }

  return { init, update, hide, closeMenu };
})();
