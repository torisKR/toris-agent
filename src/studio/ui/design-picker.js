/**
 * Element picker for Toris Studio Design Mode.
 *
 * Loaded as a classic script (not a module) so a bookmarklet can inject it
 * into whatever tab the operator is looking at. Inside a Studio iframe it
 * postMessages the parent; as a bookmarklet it opens /design#ingest=...
 */
(function () {
  const MODE_BOOKMARKLET = 'bookmarklet';
  const MESSAGE_TYPE = 'toris:design-capture';
  const STYLE_KEYS = [
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'textAlign',
    'padding',
    'margin',
    'border',
    'borderRadius',
    'width',
    'height',
    'display',
    'position',
    'gap',
    'flexDirection',
    'justifyContent',
    'alignItems',
    'opacity',
    'boxShadow',
  ];
  const HTML_LIMIT = 24000;
  const TEXT_LIMIT = 400;

  function currentScript() {
    return document.currentScript || document.querySelector('script[data-toris-design],script[data-mode]');
  }

  function studioOrigin() {
    const script = currentScript();
    const fromDataset = script && script.dataset ? script.dataset.studio : '';
    if (fromDataset) return fromDataset.replace(/\/$/, '');
    try {
      if (window.top !== window && window.location.origin) return window.location.origin;
    } catch {
      /* sandboxed */
    }
    return 'http://127.0.0.1:5824';
  }

  function isPickerChrome(node) {
    return Boolean(node && node.closest && node.closest('[data-toris-picker]'));
  }

  function cssPath(node) {
    if (!node || node.nodeType !== 1) return '';
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1) {
      const tag = String(current.tagName || '').toLowerCase();
      if (!tag || tag === 'html') {
        if (tag === 'html') parts.unshift('html');
        break;
      }
      if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
        parts.unshift('#' + current.id);
        break;
      }
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      if (siblings.length <= 1) parts.unshift(tag);
      else parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      current = parent;
    }
    return parts.join(' > ').slice(0, 500);
  }

  function computedStyleMap(el) {
    const style = window.getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) out[key] = style[key];
    return out;
  }

  function clip(text, limit) {
    const value = String(text || '');
    return value.length > limit ? value.slice(0, limit) + '\n…[truncated]' : value;
  }

  async function screenshotElement(el) {
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, Math.min(Math.round(rect.width) || 1, 800));
    const height = Math.max(1, Math.min(Math.round(rect.height) || 1, 800));
    try {
      const clone = el.cloneNode(true);
      const wrap = document.createElement('div');
      wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      wrap.style.cssText = 'width:' + width + 'px;height:' + height + 'px;background:#fff;';
      wrap.appendChild(clone);
      const serialized = new XMLSerializer().serializeToString(wrap);
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        width +
        '" height="' +
        height +
        '"><foreignObject width="100%" height="100%">' +
        serialized +
        '</foreignObject></svg>';
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const bitmap = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = function () {
            resolve(img);
          };
          img.onerror = reject;
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/png');
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      return null;
    }
  }

  async function captureElement(el) {
    const rect = el.getBoundingClientRect();
    const screenshot = await screenshotElement(el);
    return {
      url: (document.querySelector('base') && document.querySelector('base').href) || location.href,
      selector: cssPath(el),
      outerHTML: clip(el.outerHTML || '', HTML_LIMIT),
      computedStyle: computedStyleMap(el),
      text: clip((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), TEXT_LIMIT),
      tagName: String(el.tagName || '').toLowerCase(),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      screenshotDataUrl: screenshot,
    };
  }

  function deliver(capture, mode) {
    try {
      window.parent.postMessage({ type: MESSAGE_TYPE, capture: capture }, '*');
    } catch {
      /* no parent */
    }
    if (mode === MODE_BOOKMARKLET) {
      const href = studioOrigin() + '/design#ingest=' + encodeURIComponent(JSON.stringify(capture));
      window.open(href, 'toris-design');
    }
  }

  function startPicker(options) {
    const mode = (options && options.mode) || (currentScript() && currentScript().dataset.mode) || 'iframe';
    if (document.querySelector('[data-toris-picker="root"]')) return;

    const root = document.createElement('div');
    root.dataset.torisPicker = 'root';
    root.setAttribute('data-toris-picker', 'root');
    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483646',
      left: '12px',
      bottom: '12px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: '#11151b',
      color: '#f4efe6',
      font: '12px/1.4 ui-sans-serif, system-ui, sans-serif',
      boxShadow: '0 16px 50px rgb(0 0 0 / .28)',
      pointerEvents: 'none',
    });
    root.textContent = 'Design Mode · click an element · Esc cancels';
    document.documentElement.appendChild(root);

    const hover = document.createElement('div');
    hover.dataset.torisPicker = 'hover';
    hover.setAttribute('data-toris-picker', 'hover');
    Object.assign(hover.style, {
      position: 'fixed',
      zIndex: '2147483645',
      pointerEvents: 'none',
      border: '2px solid #ff7657',
      background: 'rgb(255 118 87 / .12)',
      display: 'none',
    });
    document.documentElement.appendChild(hover);

    let last = null;
    const move = (event) => {
      const el = event.target;
      if (!(el instanceof Element) || isPickerChrome(el)) return;
      last = el;
      const rect = el.getBoundingClientRect();
      hover.style.display = 'block';
      hover.style.left = rect.left + 'px';
      hover.style.top = rect.top + 'px';
      hover.style.width = rect.width + 'px';
      hover.style.height = rect.height + 'px';
    };

    const click = async (event) => {
      const el = event.target;
      if (!(el instanceof Element) || isPickerChrome(el)) return;
      event.preventDefault();
      event.stopPropagation();
      stop();
      const capture = await captureElement(el);
      deliver(capture, mode);
    };

    const key = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      stop();
    };

    const stop = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      hover.remove();
      root.remove();
    };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    if (last) move({ target: last });
  }

  window.torisDesignPicker = { startPicker: startPicker, captureElement: captureElement, cssPath: cssPath };
  startPicker();
})();
