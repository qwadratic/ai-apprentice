# video/ - toolkit for the demo and tech videos

A standalone [Remotion](https://www.remotion.dev) project that renders the product videos from React and from script files, plus a Playwright recorder that films the real product. It is not a root workspace member: it has its own `package.json` and `package-lock.json`, and the root `package.json` and lockfile are not touched.

Everything on screen comes from JSON files in `scripts/`. The compositions hold no copy of their own, so the demo and tech video scripts (TASK-3.19, TASK-3.20) plug in without code changes.

## Quick start

```sh
cd video
npm ci
npm run record:sample     # films the public demo -> assets/recordings/sample.mp4 (+ sample.json)
npm run render:sample     # renders the Sample composition -> out/sample.mp4
npm run studio            # optional: Remotion Studio with live preview (needs a desktop browser)
```

`npm run render:sample` needs `assets/recordings/sample.mp4`, so record first. If it is missing the render stops with a message that says so.

Requirements: Node 20 or newer. No system ffmpeg is needed: Remotion and the recorder use the ffmpeg that ships with Remotion.

## Compositions

All are 1920x1080 at 30 fps. The duration of each comes from `durationSec` in its script.

| Id | What it shows | Default script |
| --- | --- | --- |
| `TitleCard` | Kicker, title, subtitle, footer; Clipa in the corner | `scripts/title-card.json` |
| `CaptionedClip` | A recording in a rounded frame with timed captions, optional highlight boxes and an honesty badge | `scripts/captioned-clip.json` |
| `ClipaIntro` | Clipa flies in, lands, waves and says hello in a speech bubble | `scripts/clipa-intro.json` |
| `ClipaOutro` | Headline, short lines, links, a note; Clipa rises and waves | `scripts/clipa-outro.json` |
| `LayersDiagram` | The four layers of doc-11 (Capture, Vision, Changes, Knowledge) animated with the customer_07 example and Clipa's question | `scripts/layers-diagram.json` |
| `Sample` | A storyboard: scenes chained with cross-fades. The default is title, captioned clip, outro (18 s) | `scripts/sample.json` |

`Sample` is the generic storyboard. Its script lists scenes, and each scene has a `type` (`title`, `clip`, `clipa-intro`, `clipa-outro`, `layers`) plus the fields of the matching script below. A scene's `durationSec` counts in full; each cross-fade (`transitionSec`, default 0.5) overlaps two neighbours, so the video is shorter by that much per join.

### Render

```sh
npm run render:sample                  # Sample -> out/sample.mp4
npm run render:title                   # TitleCard -> out/title-card.mp4
npm run render:clip                    # CaptionedClip -> out/captioned-clip.mp4
npm run render:intro                   # ClipaIntro
npm run render:outro                   # ClipaOutro
npm run render:layers                  # LayersDiagram

npm run render                         # no id: lists the composition ids
npm run render -- Sample --script scripts/demo.json --out out/demo.mp4
npm run still -- LayersDiagram --frame 300     # one PNG frame -> out/layers-diagram.png
```

Flags: `--script <file>` (use another script instead of the default), `--out <file>`, `--concurrency N`, `--crf 16` (lower is better quality), `--scale 0.5` (half size, for a fast preview), `--image-format jpeg` (faster, slightly lower quality, full-range colour). The plain Remotion CLI also works (`npx remotion render Sample out/sample.mp4`); `remotion.config.ts` sets the entry point, the public folder and the browser.

A 1080p render runs at about 7 frames per second on a 4-core machine without a GPU (the 18 s sample took about 80 s here).

### A new video from a script

1. Copy `scripts/sample.json` to `scripts/demo.json` and edit the scenes.
2. Put recordings in `assets/recordings/` (see the recorder below) and point `src` at them, relative to `assets/`.
3. `npm run render -- Sample --script scripts/demo.json --out out/demo.mp4`.

## Script format

Defined in `src/script.ts`. Times are seconds and count from the start of the scene they belong to.

- **title**: `durationSec`, `title`, optional `kicker`, `subtitle`, `footer`, `showClipa`.
- **clip**: `durationSec`, `src` (a file under `assets/` or an http(s) URL), optional `startFromSec` (trim), `playbackRate`, `layout` (`framed` or `full`), `heading`, `badge`, `captions` (`fromSec`, `toSec`, `text`) and `highlights` (`fromSec`, `toSec`, `x`, `y`, `w`, `h` as fractions of the picture, optional `label`). Keep the clip scene shorter than the recording.
- **clipa-intro**: `durationSec`, `greeting`, optional `line`, `footer`.
- **clipa-outro**: `durationSec`, `headline`, optional `lines`, `links` (`label`, `url`), `note`.
- **layers**: `durationSec`, `title`, optional `subtitle`, `exampleLabel`, `footer`, `layers` (`name`, `caption`, `example`) and optional `question` (`ask`, `answer`).

Copy rules for what goes on screen: English, short, honest. Say that simulation or synthetic content is synthetic (the sample has an "All data in this video is synthetic" footer and a "synthetic data" badge on the clip). No secrets and no real personal data. Do not claim the checkpoint blocks clicks outside our demo workspace, and say that Off the record does not recall data already sent (see the honesty rules in `CLAUDE.md`).

## Recorder

`recorder/record.ts` opens a URL in headless Chromium at 1920x1080, plays a scripted walkthrough with a visible cursor and click ripples, and writes:

- `assets/recordings/<name>.mp4`: H.264, 30 fps, what the compositions play;
- `assets/recordings/<name>.json`: the duration and the time (seconds on the mp4) of every step that has a `marker`, so captions can be aligned with the recording.

```sh
npm run record:sample                                  # recorder/walkthroughs/sample.json
npm run record -- my-flow                              # recorder/walkthroughs/my-flow.json
npm run record -- sample --url http://localhost:5173/  # a local build instead of the public demo
```

Other flags: `--headed` (watch it run, on a desktop), `--no-proxy`, `--no-warmup`, `--keep-frames`, `--verbose`, `--fps 30`.

A walkthrough is a JSON file with `url`, optional `permissions` (for example `["microphone"]`) and `steps`. Each step has `do` (`goto`, `click`, `check`, `hover`, `type`, `press`, `scroll`, `wait`), a target (`role` + `name`, `byLabel`, `text` or `selector`), and optionally `value`, `wait` (ms to pause afterwards), `marker`, `optional` and, for `goto`, `ready` (a target that must be visible). See `recorder/walkthroughs/sample.json`.

How it works, and why:

- The video is Chrome's screencast, with a real timestamp on every painted frame, assembled with the concat demuxer. Playwright's own `recordVideo` was tried first and drifted 10 to 20 percent from the wall clock on a busy machine, which put the captions in the wrong places.
- A warm-up pass loads the page once, unrecorded, and keeps its scripts, styles, fonts and images in memory; the recorded run replays them. This keeps the video free of loading stalls on a slow or flaky network. API calls are never replayed: the app talks to its real backend.
- The recording uses fake microphone and camera devices (`--use-fake-device-for-media-stream`), so nothing real is captured.
- The container's HTTPS proxy re-signs traffic with its own CA, so the context uses `ignoreHTTPSErrors`. The proxy is taken from `HTTPS_PROXY` for non-local URLs.
- **The sample walkthrough clicks "Start Learn", which opens a real session on the backend of the URL it records.** The recording stops two seconds later and the session expires on its own. Use `--url` with a local build, or drop that step, if you do not want that. The recording also shows the product as it is today; record again after the UI changes, then check `sample.json` against the new recording and adjust the captions.

## Browser and downloads

Nothing is downloaded. `lib/browser.ts` looks for a browser that is already installed, in this order: `REMOTION_BROWSER_EXECUTABLE`, `CHROMIUM_EXECUTABLE`, a Playwright cache (`PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers`, `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`; the headless shell first), then system installs (Chromium, Google Chrome). In the cloud container that is `/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell`. The renderer gets it as `browserExecutable` with `chromeMode: 'headless-shell'` (a full Chrome gets `chrome-for-testing`).

If none is found, Remotion downloads its own headless shell on the first render, and the recorder asks you to run `npx playwright-core install chromium` or to set `CHROMIUM_EXECUTABLE`. On a Mac with Chrome installed this just works.

`playwright-core` is pinned to the version that matches the preinstalled Chromium (1.56.1). It never downloads browsers by itself.

Fonts (Inter, JetBrains Mono) come from npm via `@fontsource`, so rendering needs no network. Remotion's "differing memory amounts" warnings in a container are harmless.

## Clipa

`src/components/Clipa.tsx` redraws the paperclip of `apps/web/features/agent/clipa` (teal wire, pale face plate, two dot eyes, no eyebrows) as plain SVG so a frame can be rendered from props. The web component is not edited. Never name it "Clippy" and do not use Microsoft artwork.

## License

Remotion is source-available and free for individuals, non-profits and for-profit companies with up to 3 employees; larger companies need a Company License (see [remotion.dev/docs/license](https://www.remotion.dev/docs/license)). This team has two people, so the free license applies. If the team grows past three, check the license first. The rest of this repo is MIT.

## Layout

```
video/
  package.json, package-lock.json   own dependencies, not a root workspace
  remotion.config.ts                for `npx remotion studio|render`
  render.ts                         headless render CLI (npm run render)
  lib/browser.ts                    finds an installed Chromium
  src/                              Root.tsx (compositions), compositions/, components/, script.ts (types), theme.ts
  scripts/*.json                    all on-screen text
  recorder/record.ts                Playwright recorder
  recorder/walkthroughs/*.json      what the recorder does
  assets/                           served as Remotion's public folder; assets/recordings/ holds the recordings (git-ignored)
  out/                              renders (git-ignored)
```
