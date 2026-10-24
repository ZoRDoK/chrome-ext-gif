// Service worker: жест пользователя -> выделение области -> offscreen-запись
// -> скачивание файла. Поток и кадры обрабатывает offscreen-документ;
// здесь живут управление, иконка-счётчик и chrome.downloads.
import {
  LIMITS,
  QUALITY_DEFAULT,
  STATE,
  clampQuality,
  estimateLabels,
  transition,
} from './shared.js';

const OFFSCREEN_PATH = 'capture.html';
const SESSION_KEY = 'captureSession';
const DEFAULT_TITLE = 'GIF-рекордер: выделить область / остановить запись';
const BADGE_COLOR_RECORDING = '#dc2626';
const BADGE_COLOR_ERROR = '#b91c1c';
const BADGE_COLOR_ENCODING = '#1d4ed8';
const MIN_SELECTION_SIDE = 8;

let state = STATE.IDLE;
let overlayTabId = null;
let captureTabId = null;
let captureFormat = 'gif';
let offscreenCreation = null;
let captureStart = null;
let hydration = null;

// Chrome останавливает service worker после ~30 с без событий — например, пока
// пользователь спокойно выбирает область. Переменные модуля при этом теряются,
// поэтому состояние сессии дублируется в chrome.storage.session и читается
// обратно при первом событии после перезапуска.
function hydrateSession() {
  if (!hydration) {
    hydration = chrome.storage.session.get(SESSION_KEY).then((stored) => {
      const saved = stored[SESSION_KEY];
      if (!saved) return;
      state = saved.state ?? STATE.IDLE;
      overlayTabId = saved.overlayTabId ?? null;
      captureTabId = saved.captureTabId ?? null;
      captureFormat = saved.format === 'mp4' ? 'mp4' : 'gif';
    });
  }
  return hydration;
}

function saveSession() {
  return chrome.storage.session.set({
    [SESSION_KEY]: { state, overlayTabId, captureTabId, format: captureFormat },
  });
}

chrome.action.onClicked.addListener(() => {
  void toggle();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-capture') void toggle();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'overlay-init') {
    void buildOverlayInit().then(sendResponse);
    return true;
  }
  void handleMessage(message, sender);
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void handleTabUpdated(tabId, changeInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

async function handleTabUpdated(tabId, changeInfo) {
  await hydrateSession();
  if (tabId === overlayTabId && changeInfo.status === 'loading') {
    overlayTabId = null;
    state = transition(state, 'abort');
    await saveSession();
  }
}

async function handleTabRemoved(tabId) {
  await hydrateSession();
  if (tabId === overlayTabId) {
    overlayTabId = null;
    state = transition(state, 'abort');
    await saveSession();
  }
  if (tabId === captureTabId && state === STATE.RECORDING) {
    await stopRecording();
  }
}

async function buildOverlayInit() {
  const settings = await readSettings();
  return { ...settings, labels: estimateLabels(), mp4Labels: estimateLabels('mp4') };
}

async function handleMessage(message, sender) {
  await hydrateSession();
  switch (message?.type) {
    case 'overlay-selected':
      await beginCapture(sender.tab?.id, message);
      break;
    case 'overlay-cancelled':
      if (sender.tab?.id === overlayTabId) {
        overlayTabId = null;
        state = transition(state, 'cancel');
        await saveSession();
      }
      break;
    case 'overlay-quality':
      await chrome.storage.local.set({ quality: clampQuality(message.quality) });
      break;
    case 'overlay-format':
      await chrome.storage.local.set({ format: message.format === 'mp4' ? 'mp4' : 'gif' });
      break;
    case 'capture-started':
      await showElapsed(0);
      break;
    case 'capture-tick':
      await showElapsed(message.elapsedMs);
      break;
    case 'capture-file':
      await onFileReady(message);
      break;
    case 'capture-error':
      await onCaptureError(message.message);
      break;
  }
}

async function toggle() {
  await hydrateSession();
  if (state === STATE.SELECTING) {
    await cancelSelection();
    return;
  }
  if (state === STATE.RECORDING) {
    await stopRecording();
    return;
  }
  if (state === STATE.IDLE) {
    // Новое действие сбрасывает бейдж и подсказку прошлой ошибки: сервис-воркер
    // не может надёжно полагаться на setTimeout.
    await showStatus('', BADGE_COLOR_RECORDING);
    await startSelection();
  }
  // ENCODING: файл уже собирается, повторный запуск потерял бы запись.
}

async function startSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await onCaptureError('нет активной вкладки');
    return;
  }

  state = transition(state, 'start');
  await saveSession();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
    overlayTabId = tab.id;
    await saveSession();
  } catch (error) {
    await onCaptureError(`на этой странице выделение недоступно (${error.message})`);
  }
}

async function cancelSelection() {
  const tabId = overlayTabId;
  overlayTabId = null;
  state = transition(state, 'cancel');
  await saveSession();
  if (tabId === null) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'overlay-cancel' });
  } catch {
    // Оверлей мог исчезнуть вместе со страницей — отменять нечего.
  }
}

async function beginCapture(tabId, message) {
  const isOwnSelection = state === STATE.SELECTING && tabId !== undefined && tabId === overlayTabId;
  const isLargeEnough =
    message.rect?.width >= MIN_SELECTION_SIDE && message.rect?.height >= MIN_SELECTION_SIDE;

  if (!isOwnSelection || !isLargeEnough) {
    // Отказ должен быть видимым: иначе потерянное состояние выглядит как
    // «ничего не произошло». Идущую запись/кодирование такой отказ не трогает.
    if (state === STATE.RECORDING || state === STATE.ENCODING) return;

    overlayTabId = null;
    state = transition(state, 'abort');
    await saveSession();
    await onCaptureError('выделение устарело — вызовите расширение заново');
    return;
  }

  state = transition(state, 'selected');
  overlayTabId = null;
  captureTabId = tabId;
  captureFormat = message.format === 'mp4' ? 'mp4' : 'gif';
  await saveSession();

  captureStart = startCapture(tabId, message);
  try {
    await captureStart;
  } catch (error) {
    // Если сессию уже отменили (стоп во время создания offscreen), ошибка старта вторична.
    if (state === STATE.RECORDING) await onCaptureError(`не удалось начать запись (${error.message})`);
  } finally {
    captureStart = null;
  }
}

async function startCapture(tabId, message) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const { quality } = await readSettings();
  await ensureOffscreen();

  // Пока создавался offscreen, пользователь мог нажать стоп: стартовать уже нечего.
  if (state !== STATE.RECORDING) return;

  await chrome.runtime.sendMessage({
    type: 'capture-start',
    format: captureFormat,
    streamId,
    rect: message.rect,
    viewport: message.viewport,
    quality,
    limits: LIMITS,
  });
}

async function stopRecording() {
  state = transition(state, 'stop');
  await showStatus(captureFormat, BADGE_COLOR_ENCODING);
  await saveSession();

  try {
    // Незавершённый старт мог ещё не создать offscreen: дожидаемся его, иначе
    // стоп оборвал бы создание документа и показал ложную ошибку.
    await captureStart?.catch(() => {});
    const reply = await chrome.runtime.sendMessage({ type: 'capture-stop' });
    if (!reply?.active) {
      // Offscreen-документ не ведёт запись: сессию нужно сбросить, иначе бейдж
      // 'gif' завис бы до следующего действия пользователя.
      await resetSession();
      await showStatus('', BADGE_COLOR_ENCODING);
    }
  } catch (error) {
    await onCaptureError(`не удалось остановить запись (${error.message})`);
  }
}

async function showElapsed(elapsedMs) {
  if (state !== STATE.RECORDING) return;
  const seconds = Math.floor(elapsedMs / 1000);
  await showStatus(String(seconds), BADGE_COLOR_RECORDING);
}

async function onFileReady(message) {
  const format = message.format === 'mp4' ? 'mp4' : 'gif';
  const mimeType = format === 'mp4' ? 'video/mp4' : 'image/gif';
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const download = {
    url: `data:${mimeType};base64,${message.base64}`,
    filename: `${format}-${stamp}.${format}`,
    conflictAction: 'uniquify',
    saveAs: false,
  };

  try {
    await chrome.downloads.download(download);
  } catch (error) {
    await onCaptureError(`не удалось скачать ${format.toUpperCase()} (${error.message})`);
    return;
  }

  await resetSession();
  const size = `${Math.max(1, Math.round(message.sizeBytes / 1024))} КБ`;
  await showStatus('', BADGE_COLOR_ENCODING);
  const summary = format === 'mp4' ? 'MP4 сохранено' : `сохранено ${message.frames} кадров`;
  await chrome.action.setTitle({ title: `GIF-рекордер: ${summary}, ${size} — файл в Загрузках` });
}

async function onCaptureError(message) {
  await resetSession();
  await showStatus('!', BADGE_COLOR_ERROR);
  await chrome.action.setTitle({ title: `GIF-рекордер: ${message}` });
}

async function resetSession() {
  overlayTabId = null;
  captureTabId = null;
  captureFormat = 'gif';
  state = STATE.IDLE;
  await saveSession();
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Документа могло уже не быть — закрывать нечего.
  }
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;

  if (!offscreenCreation) {
    const justification = 'Запись области вкладки в GIF или MP4: getUserMedia, canvas и кодирование';
    offscreenCreation = chrome.offscreen
      .createDocument({ url: OFFSCREEN_PATH, reasons: ['USER_MEDIA'], justification })
      .finally(() => {
        offscreenCreation = null;
      });
  }
  await offscreenCreation;
}

async function showStatus(text, color) {
  const isTimer = /^\d+$/.test(text);
  const label = text || 'GIF';
  const canvas = new OffscreenCanvas(32, 32);
  const context = canvas.getContext('2d');
  context.fillStyle = text ? color : '#334155';
  context.fillRect(0, 0, 32, 32);
  context.fillStyle = '#ffffff';
  context.font = `bold ${label.length > 2 ? 14 : 24}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, 16, 17, 30);

  let title = DEFAULT_TITLE;
  if (isTimer) title = `GIF-рекордер: запись ${text} с — нажмите, чтобы остановить`;
  else if (text === 'gif' || text === 'mp4') title = `GIF-рекордер: сохраняю ${text.toUpperCase()}…`;
  await Promise.all([
    chrome.action.setIcon({ imageData: context.getImageData(0, 0, 32, 32) }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeText({ text: isTimer ? '' : text }),
    chrome.action.setTitle({ title }),
  ]);
}

async function readSettings() {
  const stored = await chrome.storage.local.get(['quality', 'format']);
  return {
    quality: clampQuality(stored.quality ?? QUALITY_DEFAULT),
    format: stored.format === 'mp4' ? 'mp4' : 'gif',
  };
}
