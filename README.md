# chrome-ext-gif

A small Manifest V3 Chrome extension: select an area of the current tab, record
it, and get a GIF in your Downloads folder. Everything runs locally — no cloud,
no accounts, no analytics, no build step.

## Install (Load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Done — the extension is ready to use as is.

Requires Chrome 116+ (`tabCapture.getMediaStreamId` and the offscreen API).

## Usage

1. Press `Alt+Shift+G` (or click the toolbar icon) to open the area selector.
2. Drag over the area to record — recording starts when you release the mouse
   (`Esc` cancels). The page stays usable and a timer runs on the toolbar icon.
3. Press `Alt+Shift+G` again (or click the icon) to stop. The GIF is encoded and
   downloaded automatically.

The shortcut can be changed at `chrome://extensions/shortcuts`.

## Quality slider

One slider (0–100, default 80), labeled with the estimated GIF size for a
5-second, 512×512 sample instead of a percentage. Default 80 is roughly 1–2 MiB
for that sample; real size depends on content, area and duration. Behind the
value: 6–14 fps, 320–720 px on the long side and a 48–256 color palette
(12 fps, 640 px, 214 colors at 80). The selected area is only ever scaled down,
and the chosen quality is kept in `chrome.storage.local`.

## Limits

- Only the active tab is captured; frames freeze when you switch tabs or
  minimize the window.
- Recording stops by itself at 60 seconds or 900 frames.
- GIF: 256 colors max, no partial transparency.
- The finished GIF travels through one `chrome.runtime.sendMessage` call, so a
  very dense recording can hit the ~48 MiB limit and fail with an error instead
  of a download.
- Selection is unavailable on protected pages (`chrome://`, Chrome Web Store,
  other extensions' pages); DRM video and some hardware-accelerated pages may
  produce black frames.

## Development

```sh
npm install        # dev-only dependency: omggif, an independent GIF decoder for tests
npm test           # unit tests: GIF encoding, size calibration, geometry, states
npm run lint:syntax
npm run test:e2e   # one-off browser smoke test; needs global playwright:
                   # NODE_PATH=$(npm root -g) node test/e2e.mjs
git config core.hooksPath .githooks   # required once per local checkout: gitleaks hooks for commit and push
```

The e2e test launches Chromium with the extension in an isolated temporary
profile.

## License

MIT (`LICENSE`). Third-party components and their licenses are listed in
`THIRD_PARTY_NOTICES.md` (`vendor/gifenc.js` — MIT, by Matt DesLauriers).
