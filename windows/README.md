# Clipa for Windows (preview)

The same [web app](https://qwadratic.github.io/clipa/) in an Electron window instead of a browser
tab, built for [issue #101](https://github.com/qwadratic/clipa/issues/101). It is a shell, not a
port of [the macOS companion](../mac/README.md): no overlay that sits over other apps, and no
pointer stream. Everything Clipa does -- the questions, the Work Map, the warnings, the voice --
is the web app's own code, unchanged, running exactly as it does in Chrome or Edge today.

What the shell adds on top of the browser tab:

- it opens straight to the app, with a tray icon (Show / Quit) instead of a browser window and
  tabs;
- "share the whole screen" skips the browser's own picker: the app hands the primary screen to
  `getDisplayMedia()` itself (see [Limits](#honest-limits) for what that means with more than one
  monitor);
- only `https://qwadratic.github.io/clipa/` may ask for the screen or the microphone, and the
  window never navigates or opens a tab anywhere else -- out-of-origin links open in the system
  browser instead, or are dropped.

It makes no backend calls of its own and changes nothing on the server: it is the same app
pointed at the same API (`apprentice.exe.xyz`), in a different window.

## Install

1. Download `Clipa-windows.exe` from the
   [clipa-windows-latest](https://github.com/qwadratic/clipa/releases/tag/clipa-windows-latest)
   release. It is a portable build: no installer, nothing written outside the one file.
2. Run it. The build is unsigned, so Windows SmartScreen blocks it on first run: click **More
   info**, then **Run anyway**.
3. Allow the microphone and the screen when the app asks. Windows' own Privacy & security ->
   Microphone switch can block the microphone before the app ever sees the request; if Clipa
   cannot hear you, check that switch first.

## Build it yourself

Needs Node (`.nvmrc` at the repo root: 22.22.0) and about 300 MB free for Electron's own download.

```bash
cd windows
npm install --no-audit   # see "Why npm install, not npm ci" below
npm run dist              # -> windows/dist/Clipa-windows.exe
```

### Why `npm install`, not `npm ci`

`windows/package.json` pins exact versions for its two dependencies (`electron`, `electron-builder`,
no range operators), but there is no `windows/package-lock.json` yet -- it was never generated,
since generating one means running `npm install` somewhere, and this was written on a machine with
too little free disk for Electron's download. CI (`.github/workflows/windows-build.yml`) runs
`npm install --no-audit` against the exact pins in `package.json`, which resolves and downloads
the dependency tree fresh on every run instead of replaying a lockfile. A follow-up can commit the
lockfile `npm install` produces in CI and switch the workflow to `npm ci` for a byte-identical
install; until then, a transitive version can drift between CI runs even though the two direct
dependencies stay pinned.

## Honest limits

- **Not run on real Windows hardware.** This preview was written and packaged without access to a
  Windows machine. CI (`windows-build.yml`, `windows-latest`) proves the app installs its
  dependencies, packages, and that the packaged `.exe` starts and stays running for a few seconds
  -- a process-level smoke test, not a check that a window renders, that screen share actually
  captures, or that the tray icon looks right. Treat it as a preview until someone runs it on an
  actual machine.
- **No monitor picker.** `getDisplayMedia()` is answered with the first screen `desktopCapturer`
  reports and nothing else: no list, no window-level sharing. On a single-monitor machine that is
  the whole screen, as intended; which physical display "first" means on a multi-monitor machine
  is whatever Windows' enumeration order happens to be that run.
- **Masks, synthetic data, the checkpoint's limits: same as the rest of Clipa.** Screen masking
  happens in the web app's own code, in the browser, on whatever `MediaStream` it is handed --
  this shell changes how that stream is obtained, not what the app does with it afterward, so
  masks are expected to behave the same as in Chrome or Edge. That expectation has not been
  checked on real hardware either. Use synthetic demo data only; see the root
  [README's Honesty section](../README.md#honesty) for what the checkpoint does and does not do.
- **Unsigned, no auto-update.** No code-signing certificate, so SmartScreen warns on every machine
  it has not been run on before, and a new build must be downloaded by hand; there is no
  installer and no updater.
- **Single display, single window.** The window is resizable but there is no multi-window, no
  remembered size or position, and no dark/light handling beyond whatever the web app already
  does in a browser tab.
