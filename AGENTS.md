# AGENTS.md

Local-only Chrome extension: Manifest V3, Chrome 116+, plain JavaScript ES modules.
Load this folder unpacked via `chrome://extensions`; there is no build step.
See `README.md` for installation, usage and browser limitations.

## Entry points

- `background.js`: service worker, session state, capture orchestration and downloads.
- `overlay.js`: injected area selector and quality slider.
- `capture.html` / `capture.js`: offscreen media stream, canvas and GIF encoding.
- `shared.js`: quality, geometry, streaming encoder and state transitions.

## Checks

- `npm ci` installs the test dependency (`omggif`); no npm runtime dependencies.
- `npm test`: built-in `node:test` tests in `test/*.test.js`, not Vitest.
- `npm run lint:syntax`: syntax checks for the four extension scripts.
- Optional browser smoke: `NODE_PATH="$(npm root -g)" npm run test:e2e`.
  Requires global Playwright and its Chromium browser. `test/e2e.mjs` uses
  synthetic pages and temporary profile/download directories; never use a real profile.
- Keep `.githooks` enabled (`git config core.hooksPath .githooks` once per checkout).
  The commit/push hooks require `gitleaks`; do not bypass them.

## Safeguards

- Keep capture and encoding local, without cloud calls or analytics.
- Keep media/canvas work offscreen and downloads in the service worker. Preserve
  stream-track/timer cleanup and offscreen/session reset on completion or error.
- Preserve `chrome.storage.session` hydration and start/stop acknowledgements:
  worker restarts and rapid start/stop must not strand a recording or the badge.
- Keep streaming encoding and `LIMITS` in `shared.js` (60 seconds / 900 frames).
  Do not accumulate all raw frames. The base64 GIF uses one runtime message;
  retain the ~48 MiB transport caveat documented in `README.md`.
- Do not hand-edit third-party `vendor/gifenc.js`; see `THIRD_PARTY_NOTICES.md`.
