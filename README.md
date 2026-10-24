# chrome-ext-gif

A small Manifest V3 Chrome extension: select an area of the current tab, record
it, and get a GIF or MP4 in your Downloads folder. Everything runs locally — no cloud,
no accounts, no analytics, no build step.

## Install (Load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Done — the extension is ready to use as is.

Requires Chrome 116+ (`tabCapture.getMediaStreamId` and the offscreen API).
The extension version is `0.2.0` (`manifest.json`).

## Usage

1. Press `Alt+Shift+G` (or click the toolbar icon) to open the area selector.
2. Choose **GIF** or **MP4**, then drag over the area to record (`Esc` cancels).
   The toolbar icon shows elapsed seconds; your format choice is remembered.
3. Press `Alt+Shift+G` again (or click the icon) to stop and download the file.

The shortcut can be changed at `chrome://extensions/shortcuts`.

## Quality slider

One slider (0–100, default 80), labeled with the estimated file size for a
5-second, 512×512 sample instead of a percentage. Default 80 is roughly 1–2 MiB
for that sample in GIF; real size depends on content, area and duration. For
GIF, the slider controls 6–14 fps, 640–1440 px on the long side and 128–256 colors per frame
(12 fps, 1280 px, 256 colors at 80). Each frame gets a fresh palette, so later
scenes keep their colors. Larger areas produce larger files. The selected area
is only ever scaled down; the chosen quality is kept in `chrome.storage.local`.
MP4 uses native browser encoding, a target of 30 fps and a bitrate based on
quality and frame size. H.264 is preferred when available.
The size estimate follows the selected format.

## Limits

- Only the active tab is captured; frames freeze when you switch tabs or
  minimize the window.
- Recording stops by itself at 60 seconds; GIF also has a 900-frame limit.
- MP4 records video without audio. It needs native MP4 support in Chrome;
  unsupported builds disable the MP4 option.
- GIF: 256 colors max, no partial transparency.
- The finished file travels through one `chrome.runtime.sendMessage` call, so a
  very dense recording can hit the ~48 MiB limit and fail with an error instead
  of a download.
- Selection is unavailable on protected pages (`chrome://`, Chrome Web Store,
  other extensions' pages); DRM video and some hardware-accelerated pages may
  produce black frames.

## Development

```sh
npm install        # dev-only dependency: omggif, an independent GIF decoder for tests
npm test           # unit tests: GIF encoding, size calibration, MP4 settings, geometry, states
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
