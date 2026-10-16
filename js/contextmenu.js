// Контекстное меню по правой кнопке мыши (ПКМ) на доске.
//
// Показывается рядом с курсором и работает с выделенными элементами:
//   • Копировать / Вырезать / Дублировать / Удалить;
//   • Вставить — если в буфере есть скопированные элементы;
//   • Оригинальный размер — для одиночного изображения.
//
// Состояние доски берётся через window.Board.ctx (см. js/board.js).

window.ContextMenu = (function () {
  let root = null;

  function ctx() { return window.Board && window.Board.ctx; }

  function init() {
    if (!ctx()) return;
    build();
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onDocMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    window.addEventListener('wheel', hide, true);
  }

  function build() {
    root = document.createElement('div');
    root.className = 'context-menu hidden';
    root.addEventListener('mousedown', (e) => e.preventDefault());
    root.addEventListener('click', onClick);
    document.body.appendChild(root);
  }

  function onContextMenu(e) {
    if (e.target.closest('input, textarea')) return;          // полям ввода — нативное меню
    const active = document.activeElement;
    if (active && active.isContentEditable && active.contains(e.target)) return; // правка текста

    e.preventDefault();
    const c = ctx();

    const nodeEl = e.target.closest('.canvas-node, .arrow');
    if (nodeEl && nodeEl.dataset.id && c.getEl(nodeEl.dataset.id)) {
      const id = nodeEl.dataset.id;
      if (!c.getEl(id).classList.contains('is-selected')) c.selectOnly(id);
      openMenu(e.clientX, e.clientY, id);
    } else {
      openMenu(e.clientX, e.clientY, null);
    }
  }

  function openMenu(x, y, nodeId) {
    const c = ctx();
    root.innerHTML = '';

    const hasSel = c.selectionCount() > 0;
    const node = nodeId && c.getNode(nodeId);
    const singleImage = hasSel && c.selectionCount() === 1 && node && node.type === 'image';

    if (hasSel) {
      addItem('Копировать', 'copy');
      addItem('Вырезать', 'cut');
      addItem('Дублировать', 'duplicate');
    }
    if (c.hasClipboard()) addItem('Вставить', 'paste');
    if (singleImage) addItem('Оригинальный размер', 'reset-image');
    if (hasSel) {
      addItem('Удалить', 'delete');
    }

    if (!root.children.length) {
      addItem('Вставить', 'paste');
      if (!c.hasClipboard()) root.lastChild.disabled = true;
    }

    root.classList.remove('hidden');
    root.style.left = '0px';
    root.style.top = '0px';
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root._nodeId = nodeId;
  }

  function addItem(label, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu__item';
    btn.textContent = label;
    btn.dataset.action = action;
    root.appendChild(btn);
  }

  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) { hide(); return; }
    const c = ctx();
    const action = btn.dataset.action;
    const nodeId = root._nodeId;
    hide();
    switch (action) {
      case 'copy': c.copySelected(); break;
      case 'cut': c.cutSelected(); break;
      case 'duplicate': c.duplicateSelected(); break;
      case 'paste': c.pasteClipboard(); break;
      case 'delete': c.deleteSelected(); break;
      case 'reset-image': if (nodeId) c.resetImageSize(nodeId); break;
    }
  }

  function onDocMouseDown(e) {
    if (root && !root.classList.contains('hidden') && !root.contains(e.target)) hide();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') hide();
  }

  function hide() {
    if (root) root.classList.add('hidden');
  }

  return { init, hide };
})();
