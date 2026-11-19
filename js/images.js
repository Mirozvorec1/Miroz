// Изображения из файла: выбор с устройства, масштабирование и сжатие.
//
// Используется для аватара профиля и обложек проектов. Работает так же, как
// вставка картинок на доске: Firebase Storage не нужен, готовый data URL
// сохраняется в документ (у узлов доски, профиля или проекта).
//
// window.Images.prepare(file, { maxSide, budget, square })
//   → { dataUrl, width, height }
// window.Images.pickFile() → Promise<File|null>

window.Images = (function () {
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
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('не удалось прочитать изображение'));
      };
      img.src = url;
    });
  }

  function sizeOf(source) {
    return {
      w: source.naturalWidth || source.width || 0,
      h: source.naturalHeight || source.height || 0
    };
  }

  function drawScaled(source, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // Центральный квадрат — для аватара.
  function cropSquare(img) {
    const { w, h } = sizeOf(img);
    const side = Math.max(1, Math.min(w, h));
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(side);
    c.getContext('2d').drawImage(
      img,
      (w - side) / 2, (h - side) / 2, side, side,
      0, 0, c.width, c.height
    );
    return c;
  }

  async function prepare(file, options) {
    const opts = Object.assign(
      { maxSide: 1200, budget: 450000, square: false },
      options || {}
    );
    if (!file || !/^image\//.test(file.type)) throw new Error('это не изображение');

    const img = await loadImageEl(file);
    const source = opts.square ? cropSquare(img) : img;
    const { w: ow, h: oh } = sizeOf(source);
    if (!ow || !oh) throw new Error('пустое изображение');

    const scale = Math.min(1, opts.maxSide / Math.max(ow, oh));
    let w = Math.round(ow * scale);
    let h = Math.round(oh * scale);
    let canvas = drawScaled(source, w, h);

    const keepAlpha = /^image\/(png|webp|gif|svg)/i.test(file.type) && webpSupported();
    const mime = keepAlpha ? 'image/webp' : 'image/jpeg';

    let quality = 0.85;
    let dataUrl = canvas.toDataURL(mime, quality);
    while (dataUrl.length > opts.budget && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL(mime, quality);
    }

    let dim = 1;
    while (dataUrl.length > opts.budget && dim > 0.35) {
      dim -= 0.15;
      const tw = Math.round(w * dim);
      const th = Math.round(h * dim);
      canvas = drawScaled(canvas, tw, th);
      w = tw;
      h = th;
      dataUrl = canvas.toDataURL(mime, quality);
    }

    if (dataUrl.length > opts.budget) throw new Error('изображение слишком большое');
    return { dataUrl, width: w, height: h };
  }

  function pickFile(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || 'image/*';
      input.id = 'images-file-input';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.top = '0';
      input.style.opacity = '0';
      document.body.appendChild(input);
      let settled = false;
      const done = file => {
        if (settled) return;
        settled = true;
        // Не удаляем поле сразу: браузер ещё дочитывает выбранный файл.
        setTimeout(() => input.remove(), 0);
        resolve(file || null);
      };
      input.addEventListener('change', () => done(input.files && input.files[0]));
      input.addEventListener('cancel', () => done(null));
      input.click();
    });
  }

  return { prepare, pickFile };
})();
