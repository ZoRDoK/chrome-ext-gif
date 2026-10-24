// Общая логика GIF-рекордера: качество, оценка размера, геометрия кадра,
// сборка GIF и переходы состояний. Модуль импортируют и service worker, и
// offscreen-документ, а Node-тесты проверяют его напрямую — поэтому формула
// качества и кодирование живут в одном месте.
import { GIFEncoder, applyPalette, quantize } from './vendor/gifenc.js';

export const QUALITY_DEFAULT = 80;
export const MP4_FPS = 30;

// Эталон для интерфейсной оценки: столько пользователь видит в подписи.
export const REFERENCE_SECONDS = 5;
const QUALITY_MIN = 0;
const QUALITY_MAX = 100;

// Верхняя граница записи страхует память вкладки от бесконечной сессии.
export const LIMITS = {
  maxDurationMs: 60_000,
  maxFrames: 900,
};

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
    maxSide: Math.round(640 + 8 * q),
    colors: Math.min(256, Math.round(128 + 1.6 * q)),
  };
}

// Калибровка (test/encoder.test.js, сценарий dashboard из test/frames.js —
// панель с текстом, графиком, фото-областью и движущимися элементами):
// измеренный размер кадра 512×512, байт на кадр при q = 0, 20, …, 100.
// Значения монотонны, интерполяция между ними тоже. Реальный размер зависит
// от контента: плоская панель без фото-области весит заметно меньше,
// поэтому в интерфейсе оценка подписана как приблизительная.
const REFERENCE_FRAME_BYTES = [25600, 26000, 26100, 26200, 26300, 26400];
const REFERENCE_STEP = 20;

export function mp4Bitrate(quality, width, height) {
  const bitsPerPixel = 0.08 + clampQuality(quality) / 500;
  // 6 Мбит/с оставляют запас для минуты видео в одном runtime-сообщении.
  return Math.min(6_000_000, Math.max(250_000, Math.round(width * height * MP4_FPS * bitsPerPixel)));
}

export function estimateReferenceBytes(quality, format = 'gif') {
  const q = clampQuality(quality);
  if (format === 'mp4') return Math.round(mp4Bitrate(q, 512, 512) * REFERENCE_SECONDS / 8);
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
export function estimateLabels(format = 'gif') {
  return Array.from({ length: QUALITY_MAX + 1 }, (_, q) => formatBytes(estimateReferenceBytes(q, format)));
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

// Каждый кадр получает свою палитру: новые цвета не искажаются палитрой
// начала записи. RGBA кодируется сразу, без накопления исходных кадров.
export function createGifEncoder({ width, height, colors, fps }) {
  const intervalMs = 1000 / fps;
  const gif = GIFEncoder();
  let frameCount = 0;

  return {
    addFrame(rgba, delayMs) {
      const palette = quantize(rgba, colors, { format: COLOR_FORMAT });
      const index = applyPalette(rgba, palette, COLOR_FORMAT);
      const options = {
        palette,
        delay: clampFrameDelay(delayMs, intervalMs),
        repeat: 0,
      };
      gif.writeFrame(index, width, height, options);
      frameCount += 1;
    },

    finish() {
      if (frameCount === 0) throw new Error('нет кадров для кодирования');
      gif.finish();
      return gif.bytes();
    },

    get frameCount() {
      return frameCount;
    },
  };
}
