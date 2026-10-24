// Offscreen-документ: получает поток захвата вкладки, вырезает выделенную
// область, кодирует GIF или MP4 и отдаёт готовый файл service worker'у.
// Кадры кодируются на ходу, поэтому память ограничена размером файла, а не
// длительностью записи (до limits.maxDurationMs).
import { MP4_FPS, createGifEncoder, mp4Bitrate, outputSize, qualityPlan, sourceRect } from './shared.js';

const METADATA_TIMEOUT_MS = 3000;
const TICK_INTERVAL_MS = 1000;
const MP4_CODEC = 'video/mp4;codecs=avc1.42E028';
const MP4_MIME = 'video/mp4';
const MP4_CHUNK_MS = 1000;

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
  if (session || starting || finalizing) return;

  starting = true;
  stopRequested = false;
  try {
    const format = message.format === 'mp4' ? 'mp4' : 'gif';
    if (format === 'mp4' && (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(MP4_MIME))) {
      throw new Error('этот Chrome не поддерживает запись MP4 — выберите GIF или обновите браузер');
    }
    const { stream, video } = await openStream(message.streamId, message.viewport);
    const plan = qualityPlan(message.quality);
    const firstCrop = sourceRect({
      rect: message.rect,
      viewport: message.viewport,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
    const size = outputSize(firstCrop.width, firstCrop.height, plan.maxSide);
    if (format === 'mp4') {
      // H.264 требует чётные размеры кадра.
      size.width -= size.width % 2;
      size.height -= size.height % 2;
      plan.fps = MP4_FPS;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { willReadFrequently: format === 'gif' });
    context.imageSmoothingQuality = 'high';

    const startedAt = performance.now();
    session = {
      stream,
      video,
      canvas,
      context,
      encoder: format === 'gif' ? createGifEncoder({
        width: size.width,
        height: size.height,
        colors: plan.colors,
        fps: plan.fps,
      }) : null,
      format,
      plan,
      limits: message.limits,
      rect: message.rect,
      viewport: message.viewport,
      startedAt,
      lastFrameAt: startedAt,
      lastTickAt: startedAt,
      timer: null,
    };

    if (format === 'mp4') {
      // Первый кадр рисуем до старта записи: captureStream отдаёт кадры только
      // при изменениях canvas, иначе начало файла осталось бы пустым.
      drawFrame(session);
      startMp4(session, message.quality);
    }

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

function startMp4(current, quality) {
  current.outputStream = current.canvas.captureStream(MP4_FPS);
  const options = {
    mimeType: MediaRecorder.isTypeSupported(MP4_CODEC) ? MP4_CODEC : MP4_MIME,
    videoBitsPerSecond: mp4Bitrate(quality, current.canvas.width, current.canvas.height),
  };
  current.recorder = new MediaRecorder(current.outputStream, options);
  current.chunks = [];
  current.recorderStopped = new Promise((resolve) => { current.recorder.onstop = resolve; });
  current.recorder.ondataavailable = ({ data }) => {
    if (data.size > 0) current.chunks.push(data);
  };
  current.recorder.onerror = (event) => {
    current.recordingError = event.error ?? new Error('ошибка записи MP4');
    if (session === current) stop();
  };
  current.recorder.start(MP4_CHUNK_MS);
}

function drawFrame(current) {
  const crop = sourceRect({
    rect: current.rect,
    viewport: current.viewport,
    videoWidth: current.video.videoWidth,
    videoHeight: current.video.videoHeight,
  });
  current.context.drawImage(
    current.video, crop.x, crop.y, crop.width, crop.height,
    0, 0, current.canvas.width, current.canvas.height,
  );
}

function captureLoop() {
  const current = session;
  if (!current) return;

  current.timer = setTimeout(() => {
    if (session !== current) return;
    const now = performance.now();
    drawFrame(current);
    if (current.format === 'gif') {
      const frame = current.context.getImageData(0, 0, current.canvas.width, current.canvas.height);
      current.encoder.addFrame(frame.data, now - current.lastFrameAt);
    }
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
  const isTooManyFrames = current.format === 'gif' && current.encoder.frameCount >= current.limits.maxFrames;
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
    const frames = current.encoder?.frameCount ?? 0;
    if (current.format === 'gif' && frames === 0) throw new Error('кадры не получены');
    const bytes = current.format === 'mp4'
      ? await finishMp4(current) : current.encoder.finish();
    await chrome.runtime.sendMessage({
      type: 'capture-file',
      format: current.format,
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

async function finishMp4(current) {
  try {
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    await current.recorderStopped;
    if (current.recordingError) throw current.recordingError;
    const blob = new Blob(current.chunks, { type: 'video/mp4' });
    if (blob.size === 0) throw new Error('видео MP4 не получено');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    for (const track of current.outputStream.getTracks()) track.stop();
  }
}

async function fail(error) {
  const current = session;
  session = null;
  clearTimeout(current?.timer);
  for (const track of current?.stream.getTracks() ?? []) track.stop();
  for (const track of current?.outputStream?.getTracks() ?? []) track.stop();
  if (current) current.video.srcObject = null;

  const message = error?.message ?? String(error);
  try {
    await chrome.runtime.sendMessage({ type: 'capture-error', message });
  } catch {
    // Ошибка service worker'а уже не важна: запись всё равно невозможна.
  }
}

async function openStream(streamId, viewport) {
  const scale = viewport.devicePixelRatio ?? 1;
  const width = Math.round(viewport.width * scale);
  const height = Math.round(viewport.height * scale);
  const source = {
    chromeMediaSource: 'tab',
    chromeMediaSourceId: streamId,
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { ...source, minWidth: width, maxWidth: width, minHeight: height, maxHeight: height } },
    });
  } catch {
    // Точный размер нужен, чтобы поток совпал с CSS-вьюпортом на DPR/zoom;
    // если Chrome его не отдаёт (дробный DPR, своё округление), берём поток
    // как есть — масштаб кадра sourceRect считает по фактическим videoWidth/Height.
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: source } });
  }

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
