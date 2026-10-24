import assert from 'node:assert/strict';
import test from 'node:test';

// Only the Chrome boundary and toolbar canvas are mocked; the real worker handles messages.
test('иконка показывает секунды, сбрасывается после записи и игнорирует поздние тики', async (t) => {
  const previousChrome = globalThis.chrome;
  const previousCanvas = globalThis.OffscreenCanvas;
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.OffscreenCanvas = previousCanvas;
  });

  const listeners = {};
  const event = (name) => ({ addListener: (handler) => { listeners[name] = handler; } });
  const icons = [];
  const downloads = [];
  const settings = { quality: 80, format: 'gif' };
  let badge = '';
  let title = '';
  let saved = { state: 'recording', overlayTabId: null, captureTabId: 1, format: 'mp4' };

  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        fillRect() {},
        fillText(text) { this.text = text; },
        getImageData(_x, _y, width, height) { return { width, height, text: this.text }; },
      };
    }
  };
  globalThis.chrome = {
    action: {
      onClicked: event('click'),
      async setIcon({ imageData }) { icons.push(imageData); },
      async setBadgeBackgroundColor() {},
      async setBadgeText(value) { badge = value.text; },
      async setTitle(value) { title = value.title; },
    },
    commands: { onCommand: event('command') },
    runtime: {
      onMessage: event('message'),
      async sendMessage() { return { active: true }; },
    },
    tabs: { onUpdated: event('updated'), onRemoved: event('removed') },
    storage: {
      local: {
        async get() { return settings; },
        async set(value) { Object.assign(settings, value); },
      },
      session: {
        async get() { return { captureSession: saved }; },
        async set(value) { saved = value.captureSession; },
      },
    },
    offscreen: { async closeDocument() {} },
    downloads: { async download(options) { downloads.push(options); return 1; } },
  };
  await import('../background.js');
  const send = async (message) => {
    listeners.message(message, {}, () => {});
    await new Promise(setImmediate);
  };

  const init = await new Promise((resolve) => listeners.message({ type: 'overlay-init' }, {}, resolve));
  assert.equal(init.format, 'gif');
  assert.equal(init.labels.length, 101);
  assert.equal(init.mp4Labels.length, 101);
  assert.notEqual(init.labels[80], init.mp4Labels[80]);
  await send({ type: 'overlay-format', format: 'mp4' });
  assert.equal(settings.format, 'mp4');
  await send({ type: 'overlay-format', format: 'webm' });
  assert.equal(settings.format, 'gif', 'неизвестный формат сохраняется как gif');

  await send({ type: 'capture-started' });
  assert.equal(icons.at(-1).text, '0');
  assert.equal(icons.at(-1).width, 32);
  assert.equal(icons.at(-1).height, 32);
  assert.equal(badge, '');
  assert.match(title, /запись 0 с/);

  await send({ type: 'capture-tick', elapsedMs: 1250 });
  assert.equal(icons.at(-1).text, '1');
  await send({ type: 'capture-tick', elapsedMs: 12_900 });
  assert.equal(icons.at(-1).text, '12');
  assert.match(title, /запись 12 с/);

  listeners.command('toggle-capture');
  await new Promise(setImmediate);
  assert.equal(icons.at(-1).text, 'mp4');
  assert.equal(saved.state, 'encoding');
  assert.equal(saved.format, 'mp4');
  await send({ type: 'capture-tick', elapsedMs: 13_000 });
  assert.equal(icons.at(-1).text, 'mp4', 'поздний тик не должен возвращать счётчик');

  await send({ type: 'capture-file', format: 'mp4', base64: 'AAAAHGZ0eXA=', frames: 2, sizeBytes: 100 });
  assert.match(downloads.at(-1).url, /^data:video\/mp4;base64,/);
  assert.match(downloads.at(-1).filename, /^mp4-.*\.mp4$/);
  assert.match(title, /MP4 сохранено/);

  await send({ type: 'capture-file', format: 'gif', base64: 'R0lGODlh', frames: 2, sizeBytes: 100 });
  assert.match(downloads.at(-1).url, /^data:image\/gif;base64,/);
  assert.match(downloads.at(-1).filename, /^gif-.*\.gif$/);
  assert.equal(icons.at(-1).text, 'GIF');
  assert.equal(badge, '');
  assert.equal(saved.state, 'idle');
  assert.match(title, /сохранено 2 кадров/);

  await send({ type: 'capture-error', message: 'test error' });
  assert.equal(icons.at(-1).text, '!');
  assert.equal(badge, '!');
  assert.match(title, /test error/);
});
