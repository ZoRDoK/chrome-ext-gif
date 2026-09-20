// Общая логика GIF-рекордера: качество, оценка размера, геометрия кадра,
// сборка GIF и переходы состояний. Модуль импортируют и service worker, и
// offscreen-документ, а Node-тесты проверяют его напрямую — поэтому формула
// качества и кодирование живут в одном месте.
import { GIFEncoder, applyPalette, quantize } from './vendor/gifenc.js';

export const QUALITY_DEFAULT = 80;

// Эталон для интерфейсной оценки: столько пользователь видит в подписи.
export const REFERENCE_SECONDS = 5;
const QUALITY_MIN = 0;
const QUALITY_MAX = 100;

// Верхняя граница записи страхует память вкладки от бесконечной сессии.
export const LIMITS = {
  maxDurationMs: 60_000,
  maxFrames: 900,
};

const PALETTE_SAMPLE_FRAMES = 24;
const PALETTE_SAMPLE_PIXELS = 400_000;
const PALETTE_SAMPLE_MS = 2000;
const COLOR_FORMAT = 'rgb565';
const MIN_FRAME_DELAY_MS = 20;
// Задержка кадра в GIF — uint16 в сотых долях секунды: всё, что больше, формат
// не вмещает. Паузы захвата внутри этого предела не сокращаются, иначе
// длительность файла перестала бы совпадать с реальным временем записи.
const GIF_MAX_FRAME_DELAY_MS = 65_535 * 10;

export const STATE = {
  IDLE: 'idle',
  SELECTING: 'selecting',
  RECORDING: 'recording',
  ENCODING: 'encoding',
};

const TRANSITIONS = {
  [STATE.IDLE]: { start: STATE.SELECTING },
  [STATE.SELECTING]: { selected: STATE.RECORDING, cancel: STATE.IDLE, abort: STATE.IDLE },
  [STATE.RECORDING]: { stop: STATE.ENCODING, abort: STATE.IDLE },
  [STATE.ENCODING]: { done: STATE.IDLE, abort: STATE.IDLE },
};

// Возвращает новое состояние; неизвестный переход состояние не меняет —
// так повторный клик по иконке во время кодирования не ломает сессию.
export function transition(state, event) {
  return TRANSITIONS[state]?.[event] ?? state;
}

export function clampQuality(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return QUALITY_DEFAULT;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Math.round(number)));
}

// Качество 0..100 раскрывается в конкретные параметры кодирования:
// fps, ограничение длинной стороны кадра и число цветов палитры.
export function qualityPlan(quality) {
  const q = clampQuality(quality);
  return {
    fps: Math.round(6 + 0.08 * q),
    maxSide: Math.round(320 + 4 * q),
    colors: Math.round(48 + 2.08 * q),
  };
}

// Калибровка (test/encoder.test.js, сценарий dashboard из test/frames.js —
// панель с текстом, графиком, фото-областью и движущимися элементами):
// измеренный размер кадра 512×512, байт на кадр при q = 0, 20, …, 100.
// Значения монотонны, интерполяция между ними тоже. Реальный размер зависит
// от контента: на плоской панели без фото-области те же 5 с весят в 2–3 раза
// меньше, поэтому в интерфейсе оценка подписана как приблизительная.
const REFERENCE_FRAME_BYTES = [17500, 24400, 25100, 25300, 25350, 25400];
const REFERENCE_STEP = 20;

export function estimateReferenceBytes(quality) {
  const q = clampQuality(quality);
  const bucket = Math.min(Math.floor(q / REFERENCE_STEP), REFERENCE_FRAME_BYTES.length - 2);
  const ratio = (q - bucket * REFERENCE_STEP) / REFERENCE_STEP;
  const first = REFERENCE_FRAME_BYTES[bucket];
  const second = REFERENCE_FRAME_BYTES[bucket + 1];
  const perFrame = first + (second - first) * ratio;
  return Math.round(perFrame * qualityPlan(q).fps * REFERENCE_SECONDS);
}

export function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1).replace('.', ',')} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

// Подписи для всех положений слайдера считает service worker, чтобы оверлей
// оставался простым скриптом без импортов.
export function estimateLabels() {
  return Array.from({ length: QUALITY_MAX + 1 }, (_, q) => formatBytes(estimateReferenceBytes(q)));
}

// Размер кадра записи: длинная сторона не больше maxSide (без апскейла).
export function outputSize(sourceWidth, sourceHeight, maxSide) {
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale)),
  };
}

// Область кадра в пикселях видео: rect задан в CSS-пикселях вьюпорта, а
// tabCapture отдаёт кадр в device-пикселях, поэтому масштаб каждой оси берём из
// отношения вьюпорта к кадру (так учитываются DPR, zoom и неодинаковый масштаб
// кадра). Пересчёт на каждом кадре даёт предсказуемое поведение при изменении
// размера окна: выделение остаётся на тех же CSS-координатах.
export function sourceRect({ rect, viewport, videoWidth, videoHeight }) {
  const scaleX = videoWidth / viewport.width;
  const scaleY = videoHeight / viewport.height;
  let width = Math.round(rect.width * scaleX);
  let height = Math.round(rect.height * scaleY);
  let x = Math.round(rect.x * scaleX);
  let y = Math.round(rect.y * scaleY);

  width = Math.min(Math.max(width, 2), videoWidth);
  height = Math.min(Math.max(height, 2), videoHeight);
  x = Math.min(Math.max(x, 0), videoWidth - width);
  y = Math.min(Math.max(y, 0), videoHeight - height);

  return { x, y, width, height };
}

function clampFrameDelay(delayMs, fallbackMs) {
  const value = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : fallbackMs;
  const clamped = Math.min(Math.max(value, MIN_FRAME_DELAY_MS), GIF_MAX_FRAME_DELAY_MS);
  return Math.round(clamped / 10) * 10;
}

function samplePixels(frames, maxPixels) {
  const perFrame = Math.max(1, Math.floor(maxPixels / frames.length));
  const pixelCount = frames[0].rgba.length / 4;
  const stride = Math.max(1, Math.ceil(pixelCount / perFrame));
  // Буфер заполняется целиком: gifenc читает его как Uint32Array от начала,
  // а все кадры имеют одинаковый размер.
  const sample = new Uint8ClampedArray(frames.length * Math.ceil(pixelCount / stride) * 4);
  let offset = 0;

  for (const frame of frames) {
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
      const source = pixel * 4;
      sample[offset] = frame.rgba[source];
      sample[offset + 1] = frame.rgba[source + 1];
      sample[offset + 2] = frame.rgba[source + 2];
      sample[offset + 3] = frame.rgba[source + 3];
      offset += 4;
    }
  }

  return sample;
}

function buildPalette(frames, colors) {
  const sample = samplePixels(frames, PALETTE_SAMPLE_PIXELS);
  return quantize(sample, colors, { format: COLOR_FORMAT });
}

// Потоковый кодировщик: палитра строится один раз по первым кадрам, дальше
// кадры кодируются сразу и RGBA не копится — память ограничена размером GIF.
export function createGifEncoder({ width, height, colors, fps }) {
  const intervalMs = 1000 / fps;
  const gif = GIFEncoder();
  const pending = [];
  let palette = null;
  let frameCount = 0;

  function writeFrame({ rgba, delayMs }) {
    const index = applyPalette(rgba, palette, COLOR_FORMAT);
    const options = {
      delay: clampFrameDelay(delayMs, intervalMs),
      repeat: 0,
    };
    if (frameCount === 0) options.palette = palette;
    gif.writeFrame(index, width, height, options);
    frameCount += 1;
  }

  function flushPending() {
    palette = buildPalette(pending, colors);
    const buffered = pending.splice(0, pending.length);
    for (const frame of buffered) writeFrame(frame);
  }

  return {
    addFrame(rgba, delayMs) {
      if (palette) {
        writeFrame({ rgba, delayMs });
        return;
      }

      pending.push({ rgba, delayMs });
      const bufferedMs = pending.reduce(
        (sum, frame) => sum + clampFrameDelay(frame.delayMs, intervalMs),
        0,
      );
      if (pending.length >= PALETTE_SAMPLE_FRAMES || bufferedMs >= PALETTE_SAMPLE_MS) {
        flushPending();
      }
    },

    finish() {
      if (!palette) {
        if (pending.length === 0) {
          throw new Error('нет кадров для кодирования');
        }
        flushPending();
      }
      gif.finish();
      return gif.bytes();
    },

    get frameCount() {
      return frameCount + pending.length;
    },
  };
}
