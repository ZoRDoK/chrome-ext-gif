// Проверка кодирования реальным GIF-декодером (omggif) и калибровка оценки
// размера на синтетических UI-сценариях.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GifReader } from 'omggif';
import {
  QUALITY_DEFAULT,
  clampQuality,
  createGifEncoder,
  estimateReferenceBytes,
  formatBytes,
  qualityPlan,
} from '../shared.js';
import { makeDashboardFrame, makePanelFrame } from './frames.js';

const SIZE = 512;
const SECONDS = 5;
// Калибровочная таблица из shared.js: байт на кадр 512×512 при q = 0, 20, …, 100.
const CALIBRATION_QUALITIES = [0, 20, 40, 60, 80, 100];
const CALIBRATION_FRAME_BYTES = [17500, 24400, 25100, 25300, 25350, 25400];
const CALIBRATION_TOLERANCE = 0.35;

function encodeScene(makeFrame, quality, seconds = SECONDS) {
  const plan = qualityPlan(quality);
  const frameCount = Math.max(1, Math.round(plan.fps * seconds));
  const encoder = createGifEncoder({
    width: SIZE,
    height: SIZE,
    colors: plan.colors,
    fps: plan.fps,
  });

  for (let i = 0; i < frameCount; i++) {
    encoder.addFrame(makeFrame(SIZE, i / plan.fps), 1000 / plan.fps);
  }

  return { bytes: encoder.finish(), frameCount, plan };
}

function decode(bytes) {
  return new GifReader(Buffer.from(bytes));
}

function pixelAt(reader, frame, x, y) {
  const rgba = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(frame, rgba);
  const offset = (y * reader.width + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

test('GIF читается независимым декодером: кадры, длительность, палитра, цвета', () => {
  const { bytes, frameCount, plan } = encodeScene(makeDashboardFrame, QUALITY_DEFAULT, 1);
  const reader = decode(bytes);

  assert.equal(reader.width, SIZE);
  assert.equal(reader.height, SIZE);
  assert.equal(reader.numFrames(), frameCount);
  assert.equal(reader.loopCount(), 0, 'GIF должен зацикливаться');

  const expectedDelay = Math.round(1000 / plan.fps / 10);
  let totalDelay = 0;
  for (let i = 0; i < frameCount; i++) {
    const info = reader.frameInfo(i);
    assert.equal(info.delay, expectedDelay, `кадр ${i}: задержка в 1/100 с`);
    assert.equal(info.has_local_palette, false, 'кадры используют общую палитру');
    assert.ok(info.palette_size <= 256);
    totalDelay += info.delay;
  }

  const expectedMs = (frameCount * 1000) / plan.fps;
  const actualMs = totalDelay * 10;
  assert.ok(
    Math.abs(actualMs - expectedMs) <= expectedMs * 0.1,
    `длительность ${actualMs} мс отличается от ${expectedMs} мс`,
  );

  const cardPixel = pixelAt(reader, 0, 300, 90);
  assert.ok(
    cardPixel.slice(0, 3).every((channel) => channel >= 240),
    `белая карточка должна остаться белой, получено ${cardPixel}`,
  );

  let changedPixels = 0;
  const first = new Uint8Array(reader.width * reader.height * 4);
  const last = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, first);
  reader.decodeAndBlitFrameRGBA(frameCount - 1, last);
  for (let i = 0; i < first.length; i += 4) {
    if (first[i] !== last[i] || first[i + 1] !== last[i + 1] || first[i + 2] !== last[i + 2]) {
      changedPixels += 1;
    }
  }
  assert.ok(changedPixels > 1000, `анимация должна менять кадры, изменилось ${changedPixels} пикселей`);
});

test('задержки кадров: минимум 20 мс, длинные паузы сохраняются до предела GIF', () => {
  const encoder = createGifEncoder({ width: 64, height: 64, colors: 16, fps: 12 });
  const frame = new Uint8ClampedArray(64 * 64 * 4).fill(128);
  encoder.addFrame(frame, 200);
  encoder.addFrame(frame, 33);
  encoder.addFrame(frame, 5);
  // Пауза больше секунды не должна молча сокращаться: длительность GIF — это
  // реальное время записи. Верхний предел — uint16 в сотых долях секунды.
  encoder.addFrame(frame, 5000);
  encoder.addFrame(frame, 700_000);

  const reader = decode(encoder.finish());
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => reader.frameInfo(i).delay),
    [20, 3, 2, 500, 65_535],
  );
});

test('качество 0..100: параметры не убывают, оценка строго растёт, размер растёт', () => {
  const plans = Array.from({ length: 101 }, (_, q) => qualityPlan(q));
  for (let q = 1; q <= 100; q++) {
    assert.ok(plans[q].fps >= plans[q - 1].fps, `fps не должен падать на q=${q}`);
    assert.ok(plans[q].maxSide >= plans[q - 1].maxSide, `maxSide не должен падать на q=${q}`);
    assert.ok(plans[q].colors >= plans[q - 1].colors, `colors не должен падать на q=${q}`);
    assert.ok(
      estimateReferenceBytes(q) > estimateReferenceBytes(q - 1),
      `оценка должна строго расти на q=${q}`,
    );
  }

  const low = encodeScene(makePanelFrame, 20, 1);
  const high = encodeScene(makePanelFrame, 100, 1);
  assert.ok(
    high.bytes.length > low.bytes.length,
    `q=100 (${high.bytes.length} Б) должен быть больше q=20 (${low.bytes.length} Б)`,
  );
});

test('оценка для default 80 попадает в целевые 1-2 МиБ на 5 с 512×512', () => {
  const bytes = estimateReferenceBytes(QUALITY_DEFAULT);
  assert.ok(bytes >= 1024 * 1024, `оценка ${formatBytes(bytes)} ниже 1 МиБ`);
  assert.ok(bytes <= 2 * 1024 * 1024, `оценка ${formatBytes(bytes)} выше 2 МиБ`);
});

test('калибровка оценки соответствует измеренным размерам', () => {
  const dashboard = [];
  const panel = [];

  for (const quality of CALIBRATION_QUALITIES) {
    const dashboardScene = encodeScene(makeDashboardFrame, quality);
    const panelScene = encodeScene(makePanelFrame, quality);
    const dashboardPerFrame = dashboardScene.bytes.length / dashboardScene.frameCount;
    const panelPerFrame = panelScene.bytes.length / panelScene.frameCount;
    dashboard.push(dashboardPerFrame);
    panel.push(panelPerFrame);
    console.log(
      `q=${String(quality).padStart(3)}: dashboard ${Math.round(dashboardPerFrame)} Б/кадр ` +
        `(${formatBytes(dashboardScene.bytes.length)} за 5 с), ` +
        `panel ${Math.round(panelPerFrame)} Б/кадр (${formatBytes(panelScene.bytes.length)} за 5 с)`,
    );
  }

  dashboard.forEach((bytes, index) => {
    const calibration = CALIBRATION_FRAME_BYTES[index];
    const quality = CALIBRATION_QUALITIES[index];
    assert.ok(
      Math.abs(bytes - calibration) <= calibration * CALIBRATION_TOLERANCE,
      `q=${quality}: измерено ${Math.round(bytes)} Б/кадр против калибровки ${calibration}`,
    );
  });

  // Пустой фон (панель без фото-области) должен выходить заметно легче —
  // поэтому оценка в интерфейсе подписана как приблизительная.
  assert.ok(
    panel[CALIBRATION_QUALITIES.indexOf(QUALITY_DEFAULT)] <
      dashboard[CALIBRATION_QUALITIES.indexOf(QUALITY_DEFAULT)] / 2,
    'плоская панель должна кодироваться существенно компактнее дашборда',
  );
});

test('clampQuality принимает 0..100 и значение по умолчанию', () => {
  assert.equal(clampQuality(undefined), QUALITY_DEFAULT);
  assert.equal(clampQuality('abc'), QUALITY_DEFAULT);
  assert.equal(clampQuality(-5), 0);
  assert.equal(clampQuality(150), 100);
  assert.equal(clampQuality('42'), 42);
});

test('кодировщик без кадров явно сообщает об ошибке', () => {
  const encoder = createGifEncoder({ width: 32, height: 32, colors: 16, fps: 12 });
  assert.throws(() => encoder.finish(), /нет кадров/);
});
