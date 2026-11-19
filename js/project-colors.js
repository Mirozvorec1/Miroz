// Цвет заглушки для проекта без обложки.
//
// Цвет выбирается по ID проекта: выглядит случайным, но не меняется при
// перезагрузке и совпадает на всех устройствах — одна и та же обложка-заглушка
// у одного и того же проекта. Насыщенность и светлость фиксированные, поэтому
// загрушник никогда не получается серым.

window.ProjectCover = (function () {
  function colorFor(project) {
    const seed = String((project && (project.id || project.slug)) || '') +
      '|' + String((project && project.name) || '');
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = (h * 16777619) | 0;
    }
    const hue = Math.abs(h) % 360;
    return 'hsl(' + hue + ', 72%, 58%)';
  }

  return { colorFor };
})();
