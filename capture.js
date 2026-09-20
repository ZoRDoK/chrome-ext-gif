// Offscreen-документ: получает поток захвата вкладки, вырезает выделенную
// область, кодирует кадры в GIF и отдаёт готовый файл service worker'у.
// Кадры кодируются на ходу, поэтому память ограничена размером GIF, а не
// длительностью записи (до limits.maxDurationMs).
import { createGifEncoder, outputSize, qualityPlan, sourceRect } from './shared.js';

const METADATA_TIMEOUT_MS = 3000;
const TICK_INTERVAL_MS = 1000;

let session = null;
let starting = false;
let finalizing = false;
let stopRequested = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture-stop') {
    const stopped = stop();
    // Ответ обязателен всегда: без него service worker не отличает «остановил»
    // от «останавливать нечего» и может оставить бейдж 'gif' навсегда.
    sendResponse({ active: stopped || starting || finalizing });
    return false;
  }
  if (message?.type === 'capture-start') void start(message);
  return false;
});

async function start(message) {
  if (session || starting) return;

  starting = true;
  stopRequested = false;
  try {
    const { stream, video } = await openStream(message.streamId);
    const plan = qualityPlan(message.quality);
    const firstCrop = sourceRect({
      rect: message.rect,
      viewport: message.viewport,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
    const size = outputSize(firstCrop.width, firstCrop.height, plan.maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const startedAt = performance.now();
    session = {
      stream,
      video,
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: true }),
      encoder: createGifEncoder({
        width: size.width,
        height: size.height,
        colors: plan.colors,
        fps: plan.fps,
      }),
      plan,
      limits: message.limits,
      rect: message.rect,
      viewport: message.viewport,
      startedAt,
      lastFrameAt: startedAt,
      lastTickAt: startedAt,
      timer: null,
    };

    for (const track of stream.getTracks()) {
      track.addEventListener('ended', onTrackEnded);
    }

    await chrome.runtime.sendMessage({ type: 'capture-started' });
    captureLoop();
    if (stopRequested) stop();
  } catch (error) {
    await fail(error);
  } finally {
    starting = false;
  }
}

function onTrackEnded() {
  // Вкладку закрыли или поток прервали: сохраняем то, что успели записать.
  if (session) stop();
}

function captureLoop() {
  const current = session;
  if (!current) return;

  current.timer = setTimeout(() => {
    if (session !== current) return;
    const now = performance.now();
    const crop = sourceRect({
      rect: current.rect,
      viewport: current.viewport,
      videoWidth: current.video.videoWidth,
      videoHeight: current.video.videoHeight,
    });
    const { width, height } = current.canvas;
    current.context.drawImage(
      current.video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      width,
      height,
    );
    const frame = current.context.getImageData(0, 0, width, height);
    current.encoder.addFrame(frame.data, now - current.lastFrameAt);
    current.lastFrameAt = now;

    void sendTick(current, now);
    if (isAtLimit(current, now)) {
      stop();
      return;
    }
    captureLoop();
  }, 1000 / current.plan.fps);
}

function isAtLimit(current, now) {
  if (!current.limits) return false;
  const isTooLong = now - current.startedAt >= current.limits.maxDurationMs;
  const isTooManyFrames = current.encoder.frameCount >= current.limits.maxFrames;
  return isTooLong || isTooManyFrames;
}

async function sendTick(current, now) {
  if (now - current.lastTickAt < TICK_INTERVAL_MS) return;
  current.lastTickAt = now;
  try {
    await chrome.runtime.sendMessage({ type: 'capture-tick', elapsedMs: now - current.startedAt });
  } catch {
    // Service worker мог уснуть; следующий тик разбудит его снова.
  }
}

function stop() {
  const current = session;
  if (!current) {
    // Стоп пришёл раньше, чем старт успел создать сессию: остановим запись
    // сразу после старта, иначе быстрый start/stop оставил бы её висеть.
    if (starting) stopRequested = true;
    return false;
  }

  session = null;
  clearTimeout(current.timer);
  for (const track of current.stream.getTracks()) track.stop();
  current.video.srcObject = null;
  finalizing = true;
  void finalize(current);
  return true;
}

async function finalize(current) {
  try {
    if (current.encoder.frameCount === 0) {
      throw new Error('кадры не получены');
    }
    const frames = current.encoder.frameCount;
    const bytes = current.encoder.finish();
    await chrome.runtime.sendMessage({
      type: 'capture-gif',
      base64: toBase64(bytes),
      frames,
      sizeBytes: bytes.length,
    });
  } catch (error) {
    await fail(error);
  } finally {
    finalizing = false;
  }
}

async function fail(error) {
  const current = session;
  session = null;
  for (const track of current?.stream.getTracks() ?? []) track.stop();

  const message = error?.message ?? String(error);
  try {
    await chrome.runtime.sendMessage({ type: 'capture-error', message });
  } catch {
    // Ошибка service worker'а уже не важна: запись всё равно невозможна.
  }
}

async function openStream(streamId) {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    if (!video.videoWidth) {
      await waitForMetadata(video);
    }
    return { stream, video };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

function waitForMetadata(video) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('поток захвата не отдал кадр')), METADATA_TIMEOUT_MS);
    video.addEventListener(
      'loadedmetadata',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function toBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
