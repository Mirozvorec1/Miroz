// Настройки Miroz.
//
// Локальные (только у этого пользователя): тема интерфейса + шаг увеличения.
// Глобальные (для всех участников проекта): стандартный шрифт и кегль.
//
// Подключается и на index.html, и на board.html. Попап открывается из меню
// доски: Settings.openPopup({ anchor, projectId, project }).

window.Settings = (function () {
  const KEY = 'miroz.settings';

  const FONTS = [
    { label: 'Simple', value: '' },
    { label: 'Bookish', value: 'Georgia, "Times New Roman", serif' },
    { label: 'Technical', value: '"Courier New", monospace' },
    { label: 'Scribbled', value: '"Comic Sans MS", "Segoe UI", cursive' }
  ];
  const SIZES = [
    { label: 'Small (12)', value: 12 },
    { label: 'Medium (16)', value: 16 },
    { label: 'Large (24)', value: 24 },
    { label: 'Extra large (32)', value: 32 },
    { label: 'Huge (48)', value: 48 }
  ];
  const THEMES = [
    { id: 'light', label: 'Светлая' },
    { id: 'black', label: 'Чёрная' },
    { id: 'dark-gray', label: 'Тёмно-серая' },
    { id: 'gray', label: 'Серая' },
    { id: 'dark-blue', label: 'Тёмно-синяя' },
    { id: 'dark-orange', label: 'Тёмно-оранжевая' },
    { id: 'dark-brown', label: 'Тёмно-коричневая' },
    { id: 'brown', label: 'Коричневая' },
    { id: 'dark-green', label: 'Тёмно-зелёная' },
    { id: 'dark-red', label: 'Тёмно-красная' }
  ];

  const DEFAULTS = { zoomStep: 0.2, theme: 'light' };

  let local = load();
  let ctx = null;          // { projectId, project }
  let pop = null;          // открытый попап
  let onChangeCb = null;

  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY)) || {}); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(local)); } catch (e) { /* ignore */ } }

  function applyTheme() {
    const t = local.theme;
    if (!t || t === 'light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = t;
  }

  function setLocal(patch) {
    local = Object.assign({}, local, patch);
    persist();
    if (patch.theme !== undefined) applyTheme();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // --- Контекст проекта (для глобальных настроек) ---

  function bindProject(projectId, project, onChange) {
    ctx = { projectId, project: project || {} };
    if (onChange) onChangeCb = onChange;
  }

  function updateProject(p) {
    if (ctx) ctx.project = p || {};
    if (pop && !pop.classList.contains('hidden')) refreshGlobal();
  }

  // --- Попап ---

  function openPopup(opts) {
    opts = opts || {};
    if (opts.projectId) ctx = { projectId: opts.projectId, project: opts.project || (ctx && ctx.project) || {} };

    closePopup();

    pop = document.createElement('div');
    pop.className = 'settings-pop';
    pop.innerHTML =
      '<div class="settings-pop__title">Настройки</div>' +
      '<div class="settings-tabs">' +
        '<button type="button" class="settings-tab is-active" data-tab="local">Локальное</button>' +
        '<button type="button" class="settings-tab" data-tab="global">Глобальное</button>' +
      '</div>' +
      '<div class="settings-sec" data-sec="local"></div>' +
      '<div class="settings-sec hidden" data-sec="global"></div>';
    document.body.appendChild(pop);

    renderLocal();
    renderGlobal();
    positionPop(opts.anchor);

    pop.addEventListener('click', (e) => {
      const tab = e.target.closest('.settings-tab');
      if (tab) {
        pop.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('is-active', t === tab));
        pop.querySelectorAll('.settings-sec').forEach(s => s.classList.toggle('hidden', s.dataset.sec !== tab.dataset.tab));
        return;
      }
      const sw = e.target.closest('.theme-swatch');
      if (sw) { setLocal({ theme: sw.dataset.themeId }); refreshLocal(); }
    });

    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
    return pop;
  }

  function closePopup() {
    document.removeEventListener('mousedown', onDocDown, true);
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
  }

  function onDocDown(e) {
    if (!pop) return;
    if (pop.contains(e.target)) return;
    closePopup();
  }

  function positionPop(anchor) {
    if (!pop) return;
    const pad = 8;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left, top;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = r.left;
      top = r.bottom + pad;
    } else {
      left = (window.innerWidth - w) / 2;
      top = 70;
    }
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function refreshLocal() {
    if (!pop) return;
    const sec = pop.querySelector('[data-sec="local"]');
    if (sec) renderLocalInto(sec);
  }

  function renderLocal() {
    if (!pop) return;
    renderLocalInto(pop.querySelector('[data-sec="local"]'));
  }

  function renderLocalInto(sec) {
    sec.innerHTML = '';

    sec.appendChild(el('div', 'settings-label', 'Тема интерфейса'));

    const grid = el('div', 'theme-grid');
    THEMES.forEach(t => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-swatch' + (local.theme === t.id ? ' is-active' : '');
      b.dataset.themeId = t.id;
      b.title = t.label;
      b.innerHTML = '<span class="theme-swatch__dot"></span>';
      grid.appendChild(b);
    });
    sec.appendChild(grid);

    const row = el('div', 'settings-row');
    row.style.marginTop = '18px';
    const lab = el('div', 'settings-label');
    const val = el('b', null, Math.round(local.zoomStep * 100) + '%');
    lab.appendChild(el('span', null, 'Шаг увеличения'));
    lab.appendChild(val);
    row.appendChild(lab);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '5';
    range.max = '50';
    range.step = '5';
    range.className = 'settings-range';
    range.value = String(Math.round(local.zoomStep * 100));
    range.addEventListener('input', () => {
      setLocal({ zoomStep: Number(range.value) / 100 });
      val.textContent = range.value + '%';
    });
    row.appendChild(range);
    sec.appendChild(row);
  }

  function refreshGlobal() {
    if (!pop) return;
    const sec = pop.querySelector('[data-sec="global"]');
    if (sec) renderGlobalInto(sec);
  }

  function renderGlobal() {
    if (!pop) return;
    renderGlobalInto(pop.querySelector('[data-sec="global"]'));
  }

  function renderGlobalInto(sec) {
    sec.innerHTML = '';

    if (!ctx || !ctx.projectId) {
      sec.appendChild(el('p', 'settings-note', 'Откройте доску, чтобы менять общие настройки проекта.'));
      return;
    }

    const p = ctx.project || {};

    sec.appendChild(el('div', 'settings-label', 'Стандартный шрифт'));
    const fontSel = document.createElement('select');
    fontSel.className = 'settings-select';
    FONTS.forEach(f => {
      const o = document.createElement('option');
      o.value = f.value;
      o.textContent = f.label;
      if ((p.defaultFontFamily || '') === f.value) o.selected = true;
      fontSel.appendChild(o);
    });
    sec.appendChild(fontSel);

    const sizeRow = el('div', 'settings-row');
    sizeRow.style.marginTop = '16px';
    sizeRow.appendChild(el('div', 'settings-label', 'Стандартный размер текста'));
    const sizeSel = document.createElement('select');
    sizeSel.className = 'settings-select';
    const cur = Number(p.defaultFontSize) || 16;
    SIZES.forEach(s => {
      const o = document.createElement('option');
      o.value = String(s.value);
      o.textContent = s.label;
      if (cur === s.value) o.selected = true;
      sizeSel.appendChild(o);
    });
    sizeRow.appendChild(sizeSel);
    sec.appendChild(sizeRow);

    sec.appendChild(el('p', 'settings-note',
      'Действует для всех участников проекта: новые текстовые элементы и стикеры ' +
      'создаются с этим шрифтом и размером.'));

    const save = () => {
      const patch = { defaultFontFamily: fontSel.value, defaultFontSize: Number(sizeSel.value) };
      if (!window.Store || !window.Store.updateProject) return;
      window.Store.updateProject(ctx.projectId, patch)
        .then(() => {
          ctx.project = Object.assign({}, ctx.project, patch);
          if (onChangeCb) onChangeCb(ctx.project);
        })
        .catch(err => console.warn('[settings]', err));
    };
    fontSel.addEventListener('change', save);
    sizeSel.addEventListener('change', save);
  }

  function zoomStep() { return Number(local.zoomStep) || DEFAULTS.zoomStep; }

  applyTheme();
  document.addEventListener('DOMContentLoaded', applyTheme);

  return {
    openPopup,
    closePopup,
    bindProject,
    updateProject,
    setLocal,
    zoomStep,
    themes: THEMES,
    fonts: FONTS,
    sizes: SIZES
  };
})();
