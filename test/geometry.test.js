// Геометрия кадра (CSS-выделение -> device-пиксели видео) и переходы
// состояний записи, включая отмену, ошибку и повторный запуск.
import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE, estimateLabels, outputSize, sourceRect, transition } from '../shared.js';

const VIEWPORT = { width: 800, height: 600 };

test('sourceRect: DPR=1 совпадает с CSS-выделением', () => {
  const rect = sourceRect({
    rect: { x: 100, y: 50, width: 200, height: 100 },
    viewport: VIEWPORT,
    videoWidth: 800,
    videoHeight: 600,
  });
  assert.deepEqual(rect, { x: 100, y: 50, width: 200, height: 100 });
});

test('sourceRect: DPR=2 переводит CSS в device-пиксели', () => {
  const rect = sourceRect({
    rect: { x: 100, y: 50, width: 200, height: 100 },
    viewport: VIEWPORT,
    videoWidth: 1600,
    videoHeight: 1200,
  });
  assert.deepEqual(rect, { x: 200, y: 100, width: 400, height: 200 });
});

test('sourceRect: масштаб браузерного zoom учитывается отношением сторон', () => {
  const rect = sourceRect({
    rect: { x: 10, y: 20, width: 100, height: 80 },
    viewport: VIEWPORT,
    videoWidth: 1200,
    videoHeight: 900,
  });
  assert.deepEqual(rect, { x: 15, y: 30, width: 150, height: 120 });
});

test('sourceRect: неодинаковый масштаб кадра считается по каждой оси', () => {
  const rect = sourceRect({
    rect: { x: 80, y: 120, width: 300, height: 200 },
    viewport: { width: 900, height: 613 },
    videoWidth: 800,
    videoHeight: 600,
  });
  assert.deepEqual(rect, { x: 71, y: 117, width: 267, height: 196 });
});

test('sourceRect: выделение за границами кадра обрезается', () => {
  const rect = sourceRect({
    rect: { x: -50, y: -20, width: 900, height: 700 },
    viewport: VIEWPORT,
    videoWidth: 800,
    videoHeight: 600,
  });
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= 800);
  assert.ok(rect.y + rect.height <= 600);
  assert.ok(rect.width >= 2 && rect.height >= 2);
});

test('sourceRect: при изменении размера окна выделение остаётся на месте', () => {
  const request = {
    rect: { x: 200, y: 100, width: 400, height: 300 },
    viewport: VIEWPORT,
  };
  const before = sourceRect({ ...request, videoWidth: 1600, videoHeight: 1200 });
  const after = sourceRect({ ...request, videoWidth: 800, videoHeight: 600 });
  assert.equal(before.width, after.width * 2);
  assert.equal(before.height, after.height * 2);
  assert.equal(before.x, after.x * 2);
});

test('outputSize: длинная сторона ограничена, апскейла нет', () => {
  assert.deepEqual(outputSize(1600, 900, 640), { width: 640, height: 360 });
  assert.deepEqual(outputSize(300, 200, 640), { width: 300, height: 200 });
  assert.deepEqual(outputSize(400, 1200, 640), { width: 213, height: 640 });
  assert.deepEqual(outputSize(1, 1, 640), { width: 2, height: 2 });
});

test('состояния: отмена, ошибка и повторный запуск не ломают сессию', () => {
  let state = STATE.IDLE;
  state = transition(state, 'start');
  assert.equal(state, STATE.SELECTING);
  state = transition(state, 'cancel');
  assert.equal(state, STATE.IDLE);

  state = transition(state, 'start');
  state = transition(state, 'selected');
  assert.equal(state, STATE.RECORDING);
  assert.equal(transition(state, 'start'), STATE.RECORDING, 'повторный старт игнорируется');
  state = transition(state, 'stop');
  assert.equal(state, STATE.ENCODING);
  assert.equal(transition(state, 'stop'), STATE.ENCODING, 'повторная остановка игнорируется');
  state = transition(state, 'done');
  assert.equal(state, STATE.IDLE);

  assert.equal(transition(STATE.RECORDING, 'abort'), STATE.IDLE);
  assert.equal(transition(STATE.SELECTING, 'abort'), STATE.IDLE);
  assert.equal(transition(STATE.IDLE, 'stop'), STATE.IDLE);
});

test('подписи размера для слайдера: 101 значение без процентов', () => {
  const labels = estimateLabels();
  assert.equal(labels.length, 101);
  for (const label of labels) {
    assert.match(label, /^(?:\d+|\d+,\d) (?:КБ|МБ)$/);
  }
  assert.equal(labels[0], '513 КБ');
  assert.equal(labels[80], '1,5 МБ');
});
