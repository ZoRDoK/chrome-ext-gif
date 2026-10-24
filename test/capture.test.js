import assert from 'node:assert/strict';
import test from 'node:test';

test('неподдерживаемый MP4 возвращает явную ошибку до открытия потока', async (t) => {
  const previousChrome = globalThis.chrome;
  const previousRecorder = globalThis.MediaRecorder;
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.MediaRecorder = previousRecorder;
  });
  let listener;
  const messages = [];
  globalThis.MediaRecorder = { isTypeSupported: () => false };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(handler) { listener = handler; } },
      async sendMessage(message) { messages.push(message); },
    },
  };
  await import('../capture.js');
  listener({ type: 'capture-start', format: 'mp4' }, {}, () => {});
  await new Promise(setImmediate);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'capture-error');
  assert.match(messages[0].message, /Chrome не поддерживает запись MP4/);
  let reply;
  listener({ type: 'capture-stop' }, {}, (value) => { reply = value; });
  assert.deepEqual(reply, { active: false });
});
