// E2E-проверка на реальном Chrome: расширение загружается через --load-extension
// в ИЗОЛИРОВАННЫЙ временный профиль, записывается только синтетическая тестовая
// страница, скачанные GIF сохраняются в временную папку (не в ~/Downloads).
//
// Запуск: NODE_PATH=$(npm root -g) node test/e2e.mjs
// Проверяются: команда расширения, выделение мышью, счётчик на иконке, остановка,
// скачивание, декодирование GIF независимым декодером, повторный запуск,
// отмена по Esc и связь CSS-координат с кадром при DPR 1 и 2.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GifReader } from 'omggif';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright не найден: запустите NODE_PATH=$(npm root -g) node test/e2e.mjs');
  process.exit(2);
}

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageHtml = readFileSync(join(projectDir, 'test', 'smoke-page.html'));
const heavyPageHtml = readFileSync(join(projectDir, 'test', 'heavy-page.html'));
const TARGET_BLUE = [29, 78, 216];
const TARGET_YELLOW = [250, 204, 21];
const COLOR_TOLERANCE = 40;
const COVERAGE_MIN = 0.98;
const RECORD_MS = 2600;

const SCENARIOS = [
  {
    label: 'CSS-выделение 1×',
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    scale: 1,
    // Расширенные проверки (перезапуск service worker, протокол остановки,
    // транспорт GIF) выполняются один раз в первом сценарии.
    full: true,
  },
  { label: 'выделение при DPR 2', viewport: { width: 400, height: 300 }, deviceScaleFactor: 2, scale: 2 },
  { label: 'детальная область 1280 px', viewport: { width: 2560, height: 1600 }, deviceScaleFactor: 1, scale: 1, detail: true },
];

const server = createServer((request, response) => {
  const html = request.url === '/heavy' ? heavyPageHtml : pageHtml;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const heavyPageUrl = `${pageUrl}heavy`;

let failures = 0;

try {
  for (const scenario of SCENARIOS) {
    try {
      await runScenario(scenario);
    } catch (error) {
      failures += 1;
      console.error(`e2e FAILED (${scenario.label}):`, error);
    }
  }
} finally {
  server.close();
}

if (failures > 0) {
  console.error(`e2e: ${failures} сценариев упало`);
  process.exitCode = 1;
} else {
  console.log('e2e: ok');
}

async function runScenario(scenario) {
  const workDir = mkdtempSync(join(tmpdir(), 'gifcap-e2e-'));
  const profileDir = join(workDir, 'profile');
  const downloadsDir = join(workDir, 'downloads');
  mkdirSync(join(profileDir, 'Default'), { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chromium',
    viewport: scenario.viewport,
    deviceScaleFactor: scenario.deviceScaleFactor,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [
      `--window-size=${scenario.viewport.width},${scenario.viewport.height}`,
      `--disable-extensions-except=${projectDir}`,
      `--load-extension=${projectDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    await worker.evaluate(() => {
      const setIcon = chrome.action.setIcon.bind(chrome.action);
      chrome.action.setIcon = async (details) => {
        if (!details.imageData) {
          await setIcon(details);
          return;
        }
        let hash = 0;
        for (const byte of details.imageData.data) hash = (hash * 31 + byte) | 0;
        await setIcon(details);
        globalThis.gifTestIconHash = hash;
      };
    });
    const page = await context.newPage();
    await page.goto(pageUrl);
    if (scenario.detail) {
      await page.locator('#target').evaluate((target) => {
        const stripes = document.createElement('div');
        Object.assign(stripes.style, {
          position: 'absolute', left: '16px', top: '16px', width: '64px', height: '8px',
          background: 'repeating-linear-gradient(90deg, white 0 1px, black 1px 2px)',
        });
        target.appendChild(stripes);
      });
    }
    await page.bringToFront();

    const cdp = await context.newCDPSession(page);
    const pressShortcut = () => pressExtensionShortcut(cdp);
    const overlay = page.locator('#gifcap-overlay');
    const actionState = () =>
      worker.evaluate(async () => ({
        badge: await chrome.action.getBadgeText({}),
        title: await chrome.action.getTitle({}),
        iconHash: globalThis.gifTestIconHash,
      }));

    const box = await page.locator('#target').boundingBox();
    assert.ok(box && box.width > 40 && box.height > 40, 'на тестовой странице нет целевого блока');

    await checkCancelFlow({ page, overlay, pressShortcut });
    await checkQualitySlider({ page, overlay, pressShortcut });

    const runs = [];
    for (const index of [1, 2]) {
      runs.push(
        await recordOnce({
          page,
          overlay,
          actionState,
          pressShortcut,
          downloadsDir,
          box,
          scenario,
          label: `${scenario.label}, прогон ${index}`,
        }),
      );
    }

    assert.notEqual(runs[0].path, runs[1].path, 'повторная запись должна сохранить новый файл');
    for (const run of runs) {
      assertRun(run, scenario);
    }
    for (const run of runs) logRun(run, scenario);

    await checkRestrictedPageError({ context, page, overlay, actionState, pressShortcut });

    if (scenario.full) {
      await checkMp4Flow({ page, overlay, actionState, pressShortcut, downloadsDir, box });
      const browserCdp = await context.browser().newBrowserCDPSession();
      await checkServiceWorkerRestart({
        page,
        overlay,
        actionState,
        pressShortcut,
        downloadsDir,
        box,
        browserCdp,
      });
      await checkStopWithoutSession({ worker, browserCdp, pressShortcut, actionState });
      await checkStaleSelection({ page, overlay, actionState, pressShortcut, worker, browserCdp, box });
      await checkRapidStartStop({ page, overlay, actionState, pressShortcut, worker, box });
      await checkTransport({
        page,
        overlay,
        actionState,
        pressShortcut,
        downloadsDir,
        worker,
        browserCdp,
      });
    }

    if (process.env.EVIDENCE_DIR) {
      mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      const name = scenario.detail ? 'e2e-detail-1280.gif' : `e2e-${scenario.scale}x.gif`;
      copyFileSync(runs[0].path, join(process.env.EVIDENCE_DIR, name));
    }
  } finally {
    await closeContext(context);
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function checkCancelFlow({ page, overlay, pressShortcut }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await pressShortcut();
    await overlay.waitFor({ state: 'attached', timeout: 10000 });
    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'detached', timeout: 5000 });
  }
  console.log('отмена по Esc и повторный вызов выделения: ок');
}

async function checkQualitySlider({ page, overlay, pressShortcut }) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const estimate = page.locator('#gifcap-overlay #gifcap-estimate');
  const slider = page.locator('#gifcap-overlay input[type=range]');

  const atDefault = await estimate.textContent();
  await setSlider(slider, '0');
  const atLow = await estimate.textContent();
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });

  // Выбранное качество должно пережить закрытие оверлея (chrome.storage.local).
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const afterReopen = await estimate.textContent();
  assert.equal(afterReopen, atLow, 'качество не сохранилось между открытиями оверлея');

  await setSlider(slider, '100');
  const atHigh = await estimate.textContent();
  for (const text of [atDefault, atLow, atHigh]) {
    assert.match(text, /≈\s?\d+(?:,\d)? (?:КБ|МБ)/, `подпись размера без числа качества: "${text}"`);
    assert.ok(!text.includes('%'), 'в интерфейсе не должно быть процентов');
  }
  assert.notEqual(atLow, atHigh, 'оценка размера должна меняться вместе со слайдером');
  console.log(`слайдер качества: "${atLow}" -> "${atHigh}" (default "${atDefault}", сохраняется)`);

  await setSlider(slider, String(80));
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
}

// Ошибка выделения — обычна ситуация (chrome:// и другие защищённые страницы):
// расширение обязано сообщить о ней и вернуться в рабочее состояние.
// Ошибка выделения — обычная ситуация (chrome:// и другие защищённые
// страницы): расширение обязано сообщить о ней и остаться работоспособным.
async function checkRestrictedPageError({ context, page, actionState, overlay, pressShortcut }) {
  const restricted = await context.newPage();
  await restricted.goto('chrome://version/');
  await restricted.bringToFront();
  const restrictedCdp = await context.newCDPSession(restricted);
  await pressExtensionShortcut(restrictedCdp);

  await waitFor(async () => (await actionState()).badge === '!', 8000, 'нет бейджа ошибки на защищённой странице');
  const failed = await actionState();
  assert.match(failed.title, /недоступно/, `подсказка об ошибке: "${failed.title}"`);
  await restricted.close();
  await page.bringToFront();

  // Следующее действие сбрасывает ошибку и начинает новое выделение.
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  assert.equal((await actionState()).badge, '', 'новое действие должно сбросить бейдж ошибки');
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  console.log(`ошибка на защищённой странице: "${failed.title}"`);
}

async function setSlider(slider, value) {
  await slider.evaluate((element, next) => {
    element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function recordingSeconds(state) {
  const match = state.title.match(/^GIF-рекордер: запись (\d+) с/);
  return match ? Number(match[1]) : null;
}

async function recordOnce({ page, overlay, actionState, pressShortcut, downloadsDir, box, scenario, label }) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const before = new Set(listDownloads(downloadsDir));

  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 10 });
  await page.mouse.up();
  await overlay.waitFor({ state: 'detached', timeout: 5000 });

  const recordStart = Date.now();
  await waitFor(async () => recordingSeconds(await actionState()) !== null, 10000, `${label}: таймер не появился`);
  const started = await actionState();
  await sleep(RECORD_MS);

  const during = await actionState();
  assert.ok(recordingSeconds(during) >= 2, `${label}: счётчик секунд не обновляется`);
  assert.equal(during.badge, '', `${label}: бейдж не должен закрывать счётчик на иконке`);
  assert.equal(typeof during.iconHash, 'number', `${label}: setIcon не принял изображение`);
  assert.notEqual(during.iconHash, started.iconHash, `${label}: пиксели иконки не изменились`);
  assert.equal(await page.locator('#gifcap-overlay').count(), 0, `${label}: оверлей должен быть удалён`);

  await pressShortcut();
  const recordStop = Date.now();
  await waitFor(async () => /сохранено/.test((await actionState()).title), 60000, `${label}: кодирование не завершилось`);

  const state = await actionState();
  const path = await waitForFile(before, downloadsDir, 30000, `${label}: GIF не появился в загрузках`, state);
  const reader = new GifReader(readFileSync(path));
  const decoded = decodeFrames(reader);

  let onTarget = 0;
  let yellowPixels = 0;
  for (let offset = 0; offset < decoded.firstFrame.length; offset += 4) {
    const isBlue = isNearColor(decoded.firstFrame, offset, TARGET_BLUE);
    const isYellow = isNearColor(decoded.firstFrame, offset, TARGET_YELLOW);
    if (isBlue || isYellow) onTarget += 1;
    if (isYellow) yellowPixels += 1;
  }

  let changed = 0;
  for (let offset = 0; offset < decoded.firstFrame.length; offset += 4) {
    if (
      decoded.firstFrame[offset] !== decoded.lastFrame[offset] ||
      decoded.firstFrame[offset + 1] !== decoded.lastFrame[offset + 1] ||
      decoded.firstFrame[offset + 2] !== decoded.lastFrame[offset + 2]
    ) {
      changed += 1;
    }
  }

  let detailContrast = 0;
  for (let x = 16; x < 79; x++) {
    const offset = (20 * reader.width + x) * 4;
    detailContrast += Math.abs(decoded.firstFrame[offset] - decoded.firstFrame[offset + 4]);
  }
  detailContrast /= 63;

  return {
    label,
    path,
    box,
    scenario,
    frames: reader.numFrames(),
    width: reader.width,
    height: reader.height,
    durationMs: decoded.durationMs,
    wallMs: recordStop - recordStart,
    sizeBytes: statSync(path).size,
    coverage: onTarget / (reader.width * reader.height),
    yellowPixels,
    changed,
    detailContrast,
  };
}

function assertRun(run, scenario) {
  const { label } = run;
  assert.ok(run.frames >= 3, `${label}: кадров ${run.frames}, ожидалось >= 3`);
  assert.ok(run.sizeBytes > 2000, `${label}: GIF подозрительно маленький (${run.sizeBytes} Б)`);

  const tolerance = run.wallMs * 0.6 + 400;
  assert.ok(
    Math.abs(run.durationMs - run.wallMs) <= tolerance,
    `${label}: длительность GIF ${run.durationMs} мс против ${run.wallMs} мс записи`,
  );

  const expectedWidth = Math.round(run.box.width * scenario.scale);
  const expectedHeight = Math.round(run.box.height * scenario.scale);
  assert.ok(
    Math.abs(run.width - expectedWidth) <= 4 && Math.abs(run.height - expectedHeight) <= 4,
    `${label}: GIF ${run.width}×${run.height}, ожидалось ${expectedWidth}×${expectedHeight} ` +
      `(выделение ${run.box.width}×${run.box.height} CSS, масштаб ${scenario.scale})`,
  );

  assert.ok(
    run.coverage >= COVERAGE_MIN,
    `${label}: в целевой блок попали ${(run.coverage * 100).toFixed(1)}% кадра — ` +
      'значит, выделение или затемнение видны в GIF',
  );
  assert.ok(run.yellowPixels >= 200, `${label}: движущийся элемент не попал в кадр`);
  assert.ok(run.changed >= 100, `${label}: кадры не меняются (${run.changed} пикселей)`);
  if (scenario.detail) {
    assert.ok(run.detailContrast >= 200, `${label}: полосы 1 px размыты (контраст ${run.detailContrast})`);
    console.log(`${label}: полосы 1 px сохранены, контраст ${run.detailContrast.toFixed(0)}/255`);
  }
}

function logRun(run, scenario) {
  console.log(
    `${run.label}: ${run.frames} кадров, ${run.width}×${run.height} (ожидалось ` +
      `${Math.round(run.box.width * scenario.scale)}×${Math.round(run.box.height * scenario.scale)}), ` +
      `${run.durationMs} мс GIF против ${run.wallMs} мс записи, ${(run.sizeBytes / 1024).toFixed(1)} КБ, ` +
      `покрытие целевого блока ${(run.coverage * 100).toFixed(1)}%`,
  );
}

function isNearColor(pixels, offset, expected) {
  return (
    Math.abs(pixels[offset] - expected[0]) <= COLOR_TOLERANCE &&
    Math.abs(pixels[offset + 1] - expected[1]) <= COLOR_TOLERANCE &&
    Math.abs(pixels[offset + 2] - expected[2]) <= COLOR_TOLERANCE
  );
}

function decodeFrames(reader) {
  const size = reader.width * reader.height * 4;
  const firstFrame = new Uint8Array(size);
  const lastFrame = new Uint8Array(size);
  reader.decodeAndBlitFrameRGBA(0, firstFrame);
  reader.decodeAndBlitFrameRGBA(reader.numFrames() - 1, lastFrame);

  let durationMs = 0;
  for (let i = 0; i < reader.numFrames(); i++) durationMs += reader.frameInfo(i).delay * 10;
  return { firstFrame, lastFrame, durationMs };
}

// Playwright сохраняет downloads.download() из service worker под GUID-именем
// (без расширения) и может переименовать файл в момент завершения загрузки,
// поэтому файлы ищем по содержимому и пропускаем исчезнувшие пути.
function listDownloads(downloadsDir) {
  return readdirSync(downloadsDir)
    .map((name) => join(downloadsDir, name))
    .filter((path) => {
      try {
        if (!statSync(path).isFile()) return false;
        const bytes = readFileSync(path);
        return bytes.toString('ascii', 0, 4) === 'GIF8' || bytes.toString('ascii', 4, 8) === 'ftyp';
      } catch {
        return false;
      }
    });
}

async function waitForFile(existing, downloadsDir, timeoutMs, message, state) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fresh = listDownloads(downloadsDir).find((path) => !existing.has(path));
    if (fresh) {
      try {
        const size = statSync(fresh).size;
        await sleep(250);
        if (statSync(fresh).size === size && size > 0) return fresh;
      } catch {
        // Файл переименовывается после завершения загрузки — ищем снова.
      }
    }
    await sleep(150);
  }
  console.error('состояние расширения:', JSON.stringify(await state()));
  throw new Error(message);
}

async function waitFor(check, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}

// Playwright-клавиатура доставляет событие только в страницу, а Chrome
// обрабатывает горячие клавиши расширения на уровне браузера: isSystemKey: true
// прогоняет rawKeyDown через обработчик chrome.commands.
async function pressExtensionShortcut(cdp) {
  const params = {
    modifiers: 1 | 8,
    windowsVirtualKeyCode: 71,
    nativeVirtualKeyCode: 71,
    code: 'KeyG',
    key: 'G',
    isSystemKey: true,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- проверки, которые запускаются один раз (scenario.full) ---

// F1: пока идёт выбор области, Chrome может остановить service worker (он не
// получает событий). Сессия должна восстанавливаться из chrome.storage.session,
// иначе выбранная область молча ничего не делает.
async function checkServiceWorkerRestart({
  page,
  overlay,
  actionState,
  pressShortcut,
  downloadsDir,
  box,
  browserCdp,
}) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const before = new Set(listDownloads(downloadsDir));
  await killServiceWorker(browserCdp);

  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 10 });
  await page.mouse.up();
  await overlay.waitFor({ state: 'detached', timeout: 5000 });

  await waitFor(
    async () => recordingSeconds(await actionState()) !== null,
    10000,
    'F1: после перезапуска service worker запись не стартовала',
  );
  await sleep(1200);
  await pressShortcut();
  await waitFor(async () => /сохранено/.test((await actionState()).title), 60000, 'F1: кодирование не завершилось');

  const path = await waitForFile(before, downloadsDir, 30000, 'F1: GIF не появился', actionState);
  const reader = new GifReader(readFileSync(path));
  assert.ok(reader.numFrames() >= 3, `F1: кадров ${reader.numFrames()}`);
  console.log(
    `перезапуск service worker во время выбора: запись стартовала, ${reader.numFrames()} кадров, ` +
      `${(statSync(path).size / 1024).toFixed(1)} КБ`,
  );
}

// F2: offscreen-документ обязан отвечать на capture-stop всегда, иначе service
// worker не отличит «остановил» от «останавливать нечего», и бейдж 'gif' зависнет.
async function checkStopWithoutSession({ worker, browserCdp, pressShortcut, actionState }) {
  await worker.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'capture.html',
      reasons: ['USER_MEDIA'],
      justification: 'e2e: проверка остановки без записи',
    });
  });

  const reply = await worker.evaluate(() =>
    chrome.runtime
      .sendMessage({ type: 'capture-stop' })
      .then((value) => value, (error) => `ERR ${error.message}`),
  );
  assert.deepEqual(reply, { active: false }, `F2: ответ пустого offscreen: ${JSON.stringify(reply)}`);

  await worker.evaluate(() =>
    chrome.storage.session.set({
      captureSession: { state: 'recording', overlayTabId: null, captureTabId: null },
    }),
  );
  await killServiceWorker(browserCdp);
  await pressShortcut();

  await waitFor(
    async () => (await readStoredSession(worker))?.state === 'idle',
    10000,
    'F2: сессия не сброшена после stop без записи',
  );
  await waitFor(async () => (await offscreenCount(worker)) === 0, 10000, 'F2: offscreen не закрылся');
  const state = await actionState();
  assert.equal(state.badge, '', `F2: бейдж после stop без записи: "${state.badge}"`);
  assert.match(state.title, /выделить область/, `F2: подсказка не сброшена: "${state.title}"`);
  console.log('stop без активной записи: сессия сброшена, offscreen закрыт, бейдж пуст');
}

// F1: если состояние сессии потеряно (перезапуск SW без сохранённой сессии),
// выбранная область не должна молча ничего делать — отказ обязан быть видимым.
async function checkStaleSelection({ page, overlay, actionState, pressShortcut, worker, browserCdp, box }) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  await worker.evaluate(() => chrome.storage.session.clear());
  await killServiceWorker(browserCdp);

  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 10 });
  await page.mouse.up();

  await waitFor(async () => (await actionState()).badge === '!', 10000, 'F1: отказ выбранной области не виден');
  const failed = await actionState();
  assert.match(failed.title, /устарело/, `F1: подсказка отказа: "${failed.title}"`);

  // Следующее действие сбрасывает ошибку и снова открывает выделение.
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  assert.equal((await actionState()).badge, '', 'F1: ошибка не сбросилась новым действием');
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  console.log(`потерянное состояние: отказ видим ("${failed.title}"), следующее действие работает`);
}

// F2: стоп сразу после выделения не должен оставлять вечный бейдж 'gif'
// и обязан возвращать расширение в рабочее состояние.
async function checkRapidStartStop({ page, overlay, actionState, pressShortcut, worker, box }) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 10 });
  await page.mouse.up();
  await pressShortcut();

  await waitFor(
    async () => (await readStoredSession(worker))?.state === 'idle',
    20000,
    'F2: быстрый стоп не завершил сессию',
  );
  await waitFor(
    async () => (await offscreenCount(worker)) === 0,
    10000,
    'F2: offscreen не закрылся после быстрого стопа',
  );
  const state = await actionState();
  assert.notEqual(state.badge, 'gif', 'F2: бейдж залип на gif');
  assert.ok(['', '!'].includes(state.badge), `F2: неожиданный бейдж "${state.badge}"`);

  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  console.log(`быстрый start/stop: сессия сброшена, бейдж "${state.badge}", оверлей снова открывается`);
}

async function checkMp4Flow({ page, overlay, actionState, pressShortcut, downloadsDir, box }) {
  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const format = page.locator('#gifcap-format');
  assert.equal(await format.inputValue(), 'gif');
  if (await format.locator('option[value=mp4]').isDisabled()) {
    console.log('MP4 не поддерживается этим Chromium — проверка пропущена');
    await page.keyboard.press('Escape');
    return;
  }
  // Оценка появляется только после асинхронного overlay-init.
  await waitFor(
    async () => (await page.locator('#gifcap-estimate').textContent()).startsWith('≈'),
    5000,
    'оценка не отрисовалась',
  );
  const gifEstimate = await page.locator('#gifcap-estimate').textContent();
  await format.selectOption('mp4');
  assert.notEqual(await page.locator('#gifcap-estimate').textContent(), gifEstimate);
  if (process.env.EVIDENCE_DIR) {
    mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.EVIDENCE_DIR, 'format-selector.png') });
  }
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });

  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  await waitFor(async () => (await format.inputValue()) === 'mp4', 5000, 'формат не сохранился');
  const before = new Set(listDownloads(downloadsDir));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height - 1, { steps: 10 });
  await page.mouse.up();
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
  await waitFor(async () => recordingSeconds(await actionState()) !== null, 10000, 'MP4: запись не стартовала');
  await sleep(RECORD_MS);
  assert.ok(recordingSeconds(await actionState()) >= 2, 'MP4: счётчик не обновляется');
  await pressShortcut();
  await waitFor(async () => /MP4 сохранено/.test((await actionState()).title), 30000, 'MP4 не сохранён');

  const path = await waitForFile(before, downloadsDir, 15000, 'MP4 не скачался', actionState);
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', 'это должен быть настоящий MP4, не WebM с другим расширением');
  const playbackData = { base64: bytes.toString('base64'), blue: TARGET_BLUE, yellow: TARGET_YELLOW, tolerance: COLOR_TOLERANCE };
  const playback = await page.evaluate(async ({ base64, blue, yellow, tolerance }) => {
    const video = document.createElement('video');
    video.muted = true;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MP4 не декодируется')), 5000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message ?? 'ошибка MP4')); };
        video.src = `data:video/mp4;base64,${base64}`;
      });
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 700));
      video.pause();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const isNearColor = (offset, color) => color.every((value, index) => Math.abs(pixels[offset + index] - value) <= tolerance);
      let onTarget = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (isNearColor(offset, blue) || isNearColor(offset, yellow)) onTarget++;
      }
      return { width: canvas.width, height: canvas.height, time: video.currentTime, duration: video.duration, coverage: onTarget / (pixels.length / 4) };
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }, playbackData);
  assert.equal(playback.width, Math.floor((box.width - 1) / 2) * 2);
  assert.equal(playback.height, Math.floor((box.height - 1) / 2) * 2);
  assert.ok(playback.time >= 0.3, 'MP4 должен воспроизводиться');
  if (Number.isFinite(playback.duration)) {
    assert.ok(playback.duration >= 2, `MP4 оказался короче записи: ${playback.duration} с`);
  }
  assert.ok(playback.coverage >= COVERAGE_MIN, `MP4: неверная область (${playback.coverage})`);
  if (process.env.EVIDENCE_DIR) {
    mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
    copyFileSync(path, join(process.env.EVIDENCE_DIR, 'e2e.mp4'));
  }
  console.log(`MP4: ftyp, ${playback.width}×${playback.height}, воспроизведение ${playback.time.toFixed(2)} с из ${Number.isFinite(playback.duration) ? playback.duration.toFixed(2) : '?'} с, ${(bytes.length / 1024).toFixed(1)} КБ, выбор сохраняется`);

  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  await waitFor(async () => (await format.inputValue()) === 'mp4', 5000, 'формат сбросился после записи');
  await format.selectOption('gif');
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 });
}

// F3: реальная тяжёлая синтетическая запись (GIF > 2 МиБ) и затем прямая
// проверка транспорта: тот же настоящий файл отправляется реальным
// runtime-сообщением из offscreen-контекста и скачивается downloads.download.
async function checkTransport({
  page,
  overlay,
  actionState,
  pressShortcut,
  downloadsDir,
  worker,
  browserCdp,
}) {
  await page.goto(heavyPageUrl);
  await page.bringToFront();
  const box = await page.locator('#heavy-target').boundingBox();
  assert.ok(box && box.width >= 400, 'на тяжёлой странице нет целевого блока');

  await pressShortcut();
  await overlay.waitFor({ state: 'attached', timeout: 10000 });
  const before = new Set(listDownloads(downloadsDir));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height, { steps: 8 });
  await page.mouse.up();
  await overlay.waitFor({ state: 'detached', timeout: 5000 });

  const recordStart = Date.now();
  await waitFor(async () => recordingSeconds(await actionState()) !== null, 10000, 'F3: запись не стартовала');
  await sleep(2500);
  await pressShortcut();
  const wallMs = Date.now() - recordStart;
  await waitFor(async () => /сохранено/.test((await actionState()).title), 60000, 'F3: кодирование не завершилось');

  const realPath = await waitForFile(before, downloadsDir, 30000, 'F3: тяжёлый GIF не появился', actionState);
  const realBytes = readFileSync(realPath);
  const reader = new GifReader(realBytes);
  let duration = 0;
  for (let index = 0; index < reader.numFrames(); index += 1) {
    duration += reader.frameInfo(index).delay * 10;
  }
  const frameBuffer = new Uint8Array(reader.width * reader.height * 4);
  for (let index = 0; index < reader.numFrames(); index += 1) {
    reader.decodeAndBlitFrameRGBA(index, frameBuffer);
  }
  assert.ok(
    realBytes.length > 2 * 1024 * 1024,
    `F3: тяжёлый GIF ${(realBytes.length / 1048576).toFixed(2)} МиБ, ожидалось больше 2 МиБ`,
  );
  assert.ok(reader.width >= 400 && reader.height >= 400, `F3: кадр ${reader.width}×${reader.height}`);
  assert.ok(
    Math.abs(duration - wallMs) <= wallMs * 0.6 + 500,
    `F3: длительность GIF ${duration} мс против ${wallMs} мс записи`,
  );

  await worker.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'capture.html',
      reasons: ['USER_MEDIA'],
      justification: 'e2e: проверка транспорта GIF',
    });
  });
  const beforeTransport = new Set(listDownloads(downloadsDir));
  const expression =
    `(async () => { await chrome.runtime.sendMessage({ type: 'capture-file', format: 'gif', ` +
    `base64: ${JSON.stringify(realBytes.toString('base64'))}, frames: ${reader.numFrames()}, ` +
    `sizeBytes: ${realBytes.length} }); return 'sent'; })()`;
  // Ответа ждать нельзя: service worker закрывает offscreen сразу после скачивания.
  await Promise.race([evaluateInOffscreen(browserCdp, expression), sleep(15000)]);

  const copiedPath = await waitForFile(
    beforeTransport,
    downloadsDir,
    30000,
    'F3: GIF не скачался через транспорт',
    actionState,
  );
  await waitFor(
    async () => statSync(copiedPath).size === realBytes.length,
    15000,
    'F3: размер скачанного файла не совпал',
  );
  const copied = readFileSync(copiedPath);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(copied.length, realBytes.length, 'F3: размер файла после транспорта');
  assert.equal(digest(copied), digest(realBytes), 'F3: содержимое после транспорта отличается');
  const copiedReader = new GifReader(copied);
  assert.equal(copiedReader.numFrames(), reader.numFrames(), 'F3: число кадров после транспорта');
  for (let index = 0; index < copiedReader.numFrames(); index += 1) {
    copiedReader.decodeAndBlitFrameRGBA(index, frameBuffer);
  }
  console.log(
    `транспорт GIF ${(realBytes.length / 1048576).toFixed(2)} МиБ: скачан целиком (sha256), ` +
      `${copiedReader.numFrames()} кадров, декод всех кадров ок, ${duration} мс против ${wallMs} мс записи`,
  );
}

async function closeContext(context) {
  // Playwright может не закрыть контекст после остановки service worker:
  // ограничиваем ожидание, чтобы прогон не завис.
  await Promise.race([context.close().catch(() => {}), sleep(10000)]);
}

async function findServiceWorker(browserCdp) {
  const targets = await browserCdp.send('Target.getTargets');
  return targets.targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.includes('background.js'),
  );
}

async function killServiceWorker(browserCdp) {
  const target = await findServiceWorker(browserCdp);
  assert.ok(target, 'service worker target не найден');
  const result = await browserCdp.send('Target.closeTarget', { targetId: target.targetId });
  assert.equal(result.success, true, 'Chrome не закрыл service worker');
  await waitFor(async () => !(await findServiceWorker(browserCdp)), 5000, 'service worker не остановился');
}

function readStoredSession(worker) {
  return worker.evaluate(async () => (await chrome.storage.session.get('captureSession')).captureSession);
}

function offscreenCount(worker) {
  return worker.evaluate(
    async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length,
  );
}

async function evaluateInOffscreen(browserCdp, expression) {
  const targets = await browserCdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.url.includes('capture.html'));
  assert.ok(target, 'offscreen-документ не найден');
  const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId });
  const reply = new Promise((resolve) => {
    browserCdp.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== sessionId) return;
      if (JSON.parse(event.message).id === 1) resolve(event);
    });
  });
  await browserCdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  });
  return reply;
}
