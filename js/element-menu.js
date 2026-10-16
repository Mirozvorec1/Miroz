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
  let nodeId = null;
  let openMenu = null;      // открытое подменю текстовой панели
  let savedRange = null;    // сохранённое выделение внутри текста
  let pickerEls = null;     // узлы hex-пикера
  let pickerHsv = { h: 0, s: 0, v: 0.9 };
  let pickerDragging = false;

  const ARROW_COLORS = [
    '#1a1a1a', '#6b7280', '#e5484d', '#f76808',
    '#f5c400', '#30a46c', '#0091ff', '#8e4ec6'
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
    root.appendChild(textPanel);
    root.appendChild(arrowPanel);

    root.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    root.addEventListener('click', onRootClick);

    ctx().viewport().appendChild(root);
  }

  function onRootClick(e) {
    const arrowBtn = e.target.closest('[data-arrow]');
    if (arrowBtn) {
      const kind = arrowBtn.dataset.arrow;
      const value = arrowBtn.dataset.value;
      if (kind === 'color') ctx().setArrowStyle(nodeId, { color: value });
      else if (kind === 'line') ctx().setArrowStyle(nodeId, { lineStyle: value });
      else if (kind === 'start') ctx().setArrowStyle(nodeId, { startCap: value });
      else if (kind === 'end') ctx().setArrowStyle(nodeId, { endCap: value });
      return;
    }

    if (e.target.closest('input')) return;
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
    const id = ctx().singleId();
    const n = id && ctx().getNode(id);
    const el = id && ctx().getEl(id);
    const isText = n && (n.type === 'text' || n.type === 'sticky');
    const isArrow = n && n.type === 'arrow';
    if (!n || !el || (!isText && !isArrow)) { hide(); return; }

    nodeId = id;
    root.classList.remove('hidden');
    textPanel.classList.toggle('hidden', !isText);
    arrowPanel.classList.toggle('hidden', !isArrow);
    if (!isText) closeMenu();

    if (isArrow) updateArrowPanel(n);
    else updateTextPanel(n, el);

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
    colorMenu.appendChild(buildColorPicker());
    const swatches = document.createElement('div');
    swatches.className = 'tt-swatches';
    C().TEXT_COLORS.concat(C().TEXT_COLORS_LIGHT).forEach(col => {
      const b = document.createElement('button');
      b.className = 'tt-swatch-btn';
      b.dataset.value = col;
      b.title = col;
      b.innerHTML = '<span class="tt-swatch" style="background:' + col + '"></span>';
      swatches.appendChild(b);
    });
    colorMenu.appendChild(swatches);

    // Меню выравнивания.
    const alignMenu = mkMenu('align');
    C().ALIGN_ITEMS.forEach(a => alignMenu.appendChild(mkAlignItem(a)));

    [fontMenu, sizeMenu, colorMenu, alignMenu].forEach(m => root_appendLater(panel, m));
    return panel;
  }

  // Подменю крепим к корню панели (позиционируются относительно .text-toolbar).
  const deferredMenus = [];
  function root_appendLater(panel, menu) {
    deferredMenus.push(menu);
    return panel;
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

    markMenuItem('font', n.fontFamily || '');
    markMenuItem('size', preset ? sz : '__none__');
    markMenuItem('align', n.align || 'left');
    syncPickerFromNode();
    const sizeInput = textPanel.querySelector('.tt-num');
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = sz;

    const focused = document.activeElement === el;
    ['bold', 'italic', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(c => {
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

    const colorBtn = document.createElement('button');
    colorBtn.className = 'tt-btn';
    colorBtn.title = 'Цвет линии';
    colorBtn.innerHTML = '<span class="em-color-dot"></span><span class="tt-caret">▾</span>';
    colorBtn.dataset.menu = 'arrow-color';
    panel.appendChild(colorBtn);

    const colorMenu = mkMenu('arrow-color');
    colorMenu.classList.add('am-colors');
    ARROW_COLORS.forEach(col => {
      const b = document.createElement('button');
      b.className = 'am-swatch';
      b.dataset.arrow = 'color';
      b.dataset.value = col;
      b.title = col;
      b.style.background = col;
      colorMenu.appendChild(b);
    });
    panel.appendChild(colorMenu);

    panel.appendChild(sep());

    LINE_STYLES.forEach(ls => panel.appendChild(mkArrowBtn('line', ls.value, ls.label, lineIcon(ls.dash))));
    panel.appendChild(sep());
    CAPS.forEach(c => panel.appendChild(mkArrowBtn('start', c.value, 'Начало: ' + c.label, capIcon(c.value, true))));
    panel.appendChild(sep());
    CAPS.forEach(c => panel.appendChild(mkArrowBtn('end', c.value, 'Конец: ' + c.label, capIcon(c.value, false))));

    return panel;
  }

  function mkArrowBtn(kind, value, title, svg) {
    const b = document.createElement('button');
    b.className = 'tt-btn';
    b.dataset.arrow = kind;
    b.dataset.value = value;
    b.title = title;
    b.innerHTML = svg;
    return b;
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'tt-sep';
    return s;
  }

  function updateArrowPanel(n) {
    if (deferredMenus.length) { deferredMenus.forEach(m => root.appendChild(m)); deferredMenus.length = 0; }
    const dot = arrowPanel.querySelector('.em-color-dot');
    if (dot) dot.style.background = n.color || '#1a1a1a';
    arrowPanel.querySelectorAll('[data-arrow="color"]').forEach(b =>
      b.classList.toggle('is-active', (n.color || '#1a1a1a') === b.dataset.value));
    arrowPanel.querySelectorAll('[data-arrow="line"]').forEach(b =>
      b.classList.toggle('is-active', (n.lineStyle || 'solid') === b.dataset.value));
    arrowPanel.querySelectorAll('[data-arrow="start"]').forEach(b =>
      b.classList.toggle('is-active', (n.startCap || 'none') === b.dataset.value));
    arrowPanel.querySelectorAll('[data-arrow="end"]').forEach(b =>
      b.classList.toggle('is-active', (n.endCap || 'arrow') === b.dataset.value));
  }

  // ---------- Иконки ----------

  function lineIcon(dash) {
    const d = dash ? ' stroke-dasharray="' + dash + '"' : '';
    return '<svg width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"><line x1="1" y1="7" x2="21" y2="7"' + d + '/></svg>';
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
      if (name === 'color') syncPickerFromNode();
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
    closeMenu();
    if (!nodeId || !name) return;
    if (name === 'color') setNodeStyle(nodeId, { color: value });
    else if (name === 'font') setNodeStyle(nodeId, { fontFamily: value });
    else if (name === 'align') setNodeStyle(nodeId, { align: value });
    else if (name === 'size') setNodeStyle(nodeId, { fontSize: Number(value) });
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
    if (el) c.applyTextStyle(el, n);
    if (c.projectId()) window.Store.updateNode(c.projectId(), id, patch).catch(() => {});
    if (!live) pushStyleHistory(id, before);
    update();
  }

  function captureStyle(id) {
    const n = ctx().getNode(id);
    return n ? { fontFamily: n.fontFamily, fontSize: n.fontSize, color: n.color, align: n.align } : null;
  }

  function pushStyleHistory(id, before) {
    if (!id || !before) return;
    const c = ctx();
    c.pushHistory({ undo: () => {
      const nn = c.getNode(id);
      const ne = c.getEl(id);
      if (!nn) return;
      Object.assign(nn, before);
      if (ne) c.applyTextStyle(ne, nn);
      if (c.projectId()) window.Store.updateNode(c.projectId(), id, before).catch(() => {});
      update();
    } });
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
    c.scheduleTextSave(id);
    c.pushHistory({ undo: () => {
      const nn = c.getNode(id);
      const ne = c.getEl(id);
      if (nn) nn.text = before;
      if (ne) ne.innerHTML = c.sanitize(before);
      if (c.projectId()) window.Store.updateNode(c.projectId(), id, { text: before }).catch(() => {});
    } });
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
    hex.addEventListener('focus', () => { hex._before = captureStyle(nodeId); });
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value);
      if (!v) return;
      pickerHsv = hexToHsv(v);
      updatePickerUI();
      applyPickerColor(v, true);
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

    pickerEls = { wrap, hex, hue, hueHandle, sv, svHandle };
    bindHueDrag(hue);
    bindSvDrag(sv);
    return wrap;
  }

  function bindHueDrag(hue) {
    hue.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pickerDragging = true;
      const before = captureStyle(nodeId);
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
        pushStyleHistory(nodeId, before);
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
      const before = captureStyle(nodeId);
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
        pushStyleHistory(nodeId, before);
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
    const n = nodeId && ctx().getNode(nodeId);
    const hex = normalizeHex((n && n.color) || '') || '#1a1a1a';
    pickerHsv = hexToHsv(hex);
    pickerEls.hex.value = hex;
    updatePickerUI();
  }

  function applyPickerColor(hex, live) {
    if (pickerEls && document.activeElement !== pickerEls.hex) pickerEls.hex.value = hex;
    if (!nodeId) return;
    setNodeStyle(nodeId, { color: hex }, !!live);
  }

  function pickWithEyedropper() {
    if (!window.EyeDropper) return;
    const before = captureStyle(nodeId);
    try {
      new window.EyeDropper().open().then(res => {
        const hex = normalizeHex(res && res.sRGBHex);
        if (!hex) return;
        pickerHsv = hexToHsv(hex);
        updatePickerUI();
        applyPickerColor(hex, true);
        pushStyleHistory(nodeId, before);
      }).catch(() => { /* отменено */ });
    } catch (e) { /* не поддержано */ }
  }

  return { init, update, hide, closeMenu };
})();
