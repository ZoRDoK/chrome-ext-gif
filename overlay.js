// Оверлей выделения. Живёт только до начала записи и удаляет себя из DOM до
// того, как service worker запросит поток, поэтому в кадры GIF не попадает.
// Скрипт внедряется как classic-script (без импортов), поэтому подписи размера
// приходят из service worker готовым массивом.
(() => {
  const HOST_ID = 'gifcap-overlay';
  const MIN_SIDE = 8;
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  setStyles(host, { position: 'fixed', inset: '0', zIndex: '2147483647' });

  const root = host.attachShadow({ mode: 'open' });

  const veil = document.createElement('div');
  setStyles(veil, {
    position: 'absolute',
    inset: '0',
    background: 'rgba(15, 23, 42, 0.45)',
    cursor: 'crosshair',
  });

  const selection = document.createElement('div');
  setStyles(selection, {
    position: 'absolute',
    display: 'none',
    border: '2px solid #38bdf8',
    boxShadow: '0 0 0 100vmax rgba(15, 23, 42, 0.45)',
    pointerEvents: 'none',
  });

  const sizeTag = document.createElement('div');
  setStyles(sizeTag, {
    position: 'absolute',
    display: 'none',
    margin: '4px 0 0 4px',
    padding: '2px 6px',
    borderRadius: '4px',
    background: '#0f172a',
    color: '#e2e8f0',
    font: '12px/1.4 system-ui, sans-serif',
  });

  const panel = document.createElement('div');
  setStyles(panel, {
    position: 'absolute',
    left: '50%',
    bottom: '24px',
    transform: 'translateX(-50%)',
    width: 'min(440px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#e2e8f0',
    font: '14px/1.45 system-ui, sans-serif',
    boxShadow: '0 12px 32px rgba(15, 23, 42, 0.45)',
  });

  const title = document.createElement('div');
  title.textContent = 'Выделите область на странице — запись начнётся сразу';
  setStyles(title, { fontWeight: '600', marginBottom: '10px' });

  const formatLabel = document.createElement('label');
  formatLabel.textContent = 'Формат';
  setStyles(formatLabel, { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' });
  const formatInput = document.createElement('select');
  formatInput.id = 'gifcap-format';
  formatInput.disabled = true;
  formatLabel.htmlFor = formatInput.id;
  const isMp4Supported = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4');
  for (const format of ['gif', 'mp4']) {
    const option = document.createElement('option');
    option.value = format;
    option.textContent = format === 'mp4' && !isMp4Supported
      ? 'MP4 — недоступен в этом Chrome' : format.toUpperCase();
    option.disabled = format === 'mp4' && !isMp4Supported;
    formatInput.appendChild(option);
  }
  setStyles(formatInput, {
    padding: '4px 8px', borderRadius: '4px', border: '1px solid #475569',
    background: '#1e293b', color: '#e2e8f0', font: 'inherit',
  });
  formatLabel.appendChild(formatInput);

  const estimateLine = document.createElement('div');
  setStyles(estimateLine, { display: 'flex', alignItems: 'baseline', gap: '8px' });

  const estimateValue = document.createElement('span');
  estimateValue.id = 'gifcap-estimate';
  setStyles(estimateValue, { fontSize: '20px', fontWeight: '600', color: '#7dd3fc' });
  estimateValue.setAttribute('aria-live', 'polite');
  estimateValue.textContent = '…';

  const estimateCaption = document.createElement('span');
  setStyles(estimateCaption, { fontSize: '12px', color: '#94a3b8' });
  estimateCaption.textContent = 'примерный размер GIF для эталона 5 с, 512×512';

  estimateLine.append(estimateValue, estimateCaption);

  const slider = document.createElement('input');
  slider.id = 'gifcap-quality';
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Качество записи');
  setStyles(slider, { width: '100%', margin: '10px 0 6px', accentColor: '#38bdf8' });

  const caption = document.createElement('label');
  caption.htmlFor = slider.id;
  caption.textContent = 'Качество: меньше файл ← → чётче изображение';
  setStyles(caption, { display: 'block', fontSize: '12px', color: '#94a3b8' });

  const hint = document.createElement('div');
  hint.textContent = 'ЛКМ — выделить · Esc — отмена';
  setStyles(hint, { fontSize: '12px', color: '#64748b', marginTop: '6px' });

  panel.append(title, formatLabel, estimateLine, slider, caption, hint);
  root.append(veil, selection, sizeTag, panel);
  document.documentElement.appendChild(host);

  let labels = null;
  let dragStart = null;

  panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  formatInput.addEventListener('change', () => {
    renderEstimate();
    chrome.runtime.sendMessage({ type: 'overlay-format', format: formatInput.value }).catch(() => {});
  });
  slider.addEventListener('input', () => {
    renderEstimate();
    chrome.runtime.sendMessage({ type: 'overlay-quality', quality: Number(slider.value) }).catch(() => {});
  });

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown, true);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'overlay-cancel' && host.isConnected) {
      finish({ type: 'overlay-cancelled' });
    }
  });

  chrome.runtime
    .sendMessage({ type: 'overlay-init' })
    .then((init) => {
      if (!init) return;
      labels = { gif: init.labels, mp4: init.mp4Labels };
      slider.value = String(init.quality);
      formatInput.value = init.format === 'mp4' && isMp4Supported ? 'mp4' : 'gif';
      formatInput.disabled = false;
      renderEstimate();
    })
    .catch(() => {});

  function setStyles(element, styles) {
    Object.assign(element.style, styles);
  }

  function renderEstimate() {
    if (!labels) return;
    estimateValue.textContent = `≈ ${labels[formatInput.value][Number(slider.value)]}`;
    estimateCaption.textContent = `примерный размер ${formatInput.value.toUpperCase()} для 5 с, 512×512`;
  }

  function rectFromPoints(start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return {
      x,
      y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }

  function updateSelection(rect) {
    setStyles(selection, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    setStyles(sizeTag, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
    });
    sizeTag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStart = { x: event.clientX, y: event.clientY };
    veil.style.display = 'none';
    selection.style.display = 'block';
    sizeTag.style.display = 'block';
    updateSelection({ x: dragStart.x, y: dragStart.y, width: 0, height: 0 });
    event.target.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!dragStart) return;
    updateSelection(rectFromPoints(dragStart, event));
  }

  function onPointerUp(event) {
    if (!dragStart) return;
    const rect = rectFromPoints(dragStart, event);
    dragStart = null;

    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
      veil.style.display = 'block';
      selection.style.display = 'none';
      sizeTag.style.display = 'none';
      return;
    }

    finish({
      type: 'overlay-selected',
      format: formatInput.value,
      rect,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    });
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finish({ type: 'overlay-cancelled' });
  }

  function finish(message) {
    window.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    host.remove();
    chrome.runtime.sendMessage(message).catch(() => {});
  }
})();
