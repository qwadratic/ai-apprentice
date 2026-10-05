# Clipa for macOS

Clipa without a window. She lives in the corner of your screen, streams the main display to the Clipa server while a stage runs, talks with you through the same ElevenLabs agents as the web app, and at the end hands you a link to the web app, where you reflect on what was done.

The app is one face of the **Clipa Conductor** (backlog doc-12). What Clipa says, and when, is decided on the server, the same way for the web app and for this app. The app's jobs:

- stream the screen;
- report what the person does: typing, pauses, talking, what they said;
- render the conductor's cues: how far Clipa comes out, where she points, her lines;
- speak through the voice agent.

It is a menu-bar app built for Hack-Nation 7, challenge 01 "The AI Apprentice" (ElevenLabs). It has no Dock icon and no windows: a paperclip in the menu bar, and Clipa on a click-through overlay.

## Run it

Every push to `main` publishes the latest build as the release `clipa-macos-latest`.

1. Download [Clipa.dmg](https://github.com/qwadratic/clipa/releases/download/clipa-macos-latest/Clipa.dmg), open it and drag Clipa onto the Applications shortcut.
2. Open Clipa from Applications. The app is ad-hoc signed, not notarized, so on the first launch macOS blocks it. Open System Settings > Privacy & Security, click **Open Anyway** and confirm. This is needed once per build.
3. Grant Screen Recording, Microphone and Input Monitoring when asked. After granting Screen Recording, quit and reopen Clipa.

From Terminal instead, one line that installs into `~/Applications` without the quarantine (no Open Anyway step), resets the permission grants of the previous build and opens the app:

```bash
curl -fsSL https://raw.githubusercontent.com/qwadratic/clipa/main/mac/scripts/install.sh | bash
```

Or build it yourself on macOS 14+ with Xcode 15.2+ (no external dependencies):

```bash
cd mac
scripts/build-app.sh            # release build -> build/Clipa.app, ad-hoc signed
open build/Clipa.app
```

Then use the paperclip in the menu bar:

| Menu item | What happens |
| --- | --- |
| **Start Show (expert)** | Starts the conductor's `learn` stage with the interviewer agent: the expert does the real task and talks; Clipa asks at natural pauses. |
| **Start Pass it on (new hire)** | Starts the `teach` stage with the tutor agent on the latest confirmed Work Map: Clipa steps in before a guardrail is broken. |
| **End** | Ends the stage. The conductor answers with a link, and Clipa opens it in your browser: Reflect for the expert, the summary for the new hire. |
| **Off the record** | Clipa stops the screen stream (no capture at all) and closes the voice conversation. The conductor is told first. |
| **Open Reflect in browser** | Opens the last Reflect link again, or the web app. |
| **Grant permissions..., Open session log, Quit Clipa** | |

The menu says plainly that while a stage runs, the main display is streamed to the Clipa server. Its first lines show the stage, the stream (frames sent, last outcome, latency), the voice and the cue stream.

### Demo cases

Two cases, on synthetic data only:

- **An email.** A mail draft for customer_07 with the order details as text.
- **A table.** An order table.

Open them in any app (the vision on the server is generic), start Show, and work while talking.

## How it works

```
Clipa.app ──POST /api/agent/sessions──────────────────────────────▶ session id + token
          ──POST /screen/sessions/{id}/start, /frames (JPEG) ───▶ server vision ──▶ conductor
          ──POST /api/agent/conductor/{id}/events ─────────────▶ conductor
          ◀─GET  /api/agent/conductor/{id}/cues (SSE) ──────────── cues: presence, point, ask, warn, open_web...
          ◀▶ ElevenLabs Conversational AI WebSocket (signed URL from /api/agent/elevenlabs/signed-url)
```

Every request carries `Origin: app://apprentice-macos` and the session token as `Authorization: Bearer`. The token is never logged.

### Screen streaming

`ScreenStreamer.swift` and `FrameUploader.swift`:

- **Capture.** An `SCStream` of the main display, not snapshots. `minimumFrameInterval` is 0.5 s (about 2 fps). ScreenCaptureKit scales each frame to at most 1280 px wide. The system pointer is not drawn, and Clipa's own overlay is excluded.
- **Pointer.** `PointerTracker.swift` samples the mouse every 100 ms (the last 5 s, kept on the Mac). When the pointer is on the main display, each sent frame gets a magenta ring with a dot at the hotspot, and the upload carries an optional `pointer` field: the position normalised 0..1, the dwell in ms (resting within 1.5 % of the frame width for at least 600 ms, else 0) and at most 8 trail points `[x, y, msAgo]`. When the pointer comes to rest away from the ring on the last frame, that frame goes again with the ring moved. The server tells the vision model what the ring means. Turn it off with `"pointer_marker": false` or `CLIPA_POINTER=0`.
- **Skipping unchanged frames.** ScreenCaptureKit delivers a complete frame only when the screen changed. On top of that, a 128x80 grayscale thumbnail is compared with the last frame that was sent. A frame is skipped unless at least 2 cells moved by more than 10 gray levels, which filters out a blinking caret.
- **Encoding.** JPEG at quality 0.6, typically 80 to 250 KB per frame.
- **Upload.** One request in flight, and the latest frame wins: a frame that arrives while another is uploading replaces the one waiting, which is dropped as stale. Uploads are paced to 1.6 s, because the server analyses one frame per 1.5 s. If the server answers `sampled_out`, the same picture is sent again with a fresh timestamp.
- **Latency.** Every upload writes a `frame` line to the session log: `queue_ms` (capture to request), `upload_ms` and `total_ms` (capture to server reply), plus size, changed cells and the server's outcome. The menu shows the last value and a moving average.
- **Lifecycle.** Off the record pauses the server session and stops the capture. Back on the record resumes both. End stops both.
- **Timestamps.** The server vision turns frames into observations and feeds them straight to the session's conductor; the app does not forward observations. Frame timestamps count from `sessionEpochMs`, which is aligned to the server clock once per stage.

### Conductor client

`ConductorClient.swift`:

- **Events.** The app sends `hello {client: macos, persona}`, `mode`, `session` (live, then ended), `share`, `activity` from the idle monitor (typing / working / pause / idle / away), `talking` (the person, from the agent's voice activity score; Clipa, from playback), final `transcript` turns, `cue_done`, and `off_record`.
- **Delivery.** Events are batched (at most 50), each with `seq` and `atMs`. A failed POST is retried; the server skips a seq it already has.
- **Cues.** The cue stream is read with `URLSession.bytes`. It reconnects with `after=<last seq>`, so no cue is rendered twice.

### The face

`ClipaController+Face.swift`, `OverlayController.swift`, `BuddyView.swift` (Clipa's SwiftUI drawing from `feat/clipa`):

- **`presence`.** `dot` is small, in the lower right corner. `peek` is medium. `full` is large, next to the target when the anchor is `target`.
- **`point`.** The region box `[x, y, w, h]` is normalised 0..1 to the captured frame. The app maps it onto the captured display and Clipa flies beside it, her arm toward it.
- **Lines.** `ask`, `warn`, `say`, `teachback`, and a `guide` with `speak` appear in the speech bubble and are said by the voice agent as `[ASK] text`.
  - `cue_done` reports `spoken` when the agent has finished, and `shown` without voice.
  - It reports `skipped` when the cue expired, or the person was typing or talking.
  - It reports `interrupted` when the line was cancelled while it was being said.
- **`context`.** Goes to the agent as a `contextual_update`.
- **`open_web`.** Opens the URL with `NSWorkspace`.
- **`state`.** Sets Clipa's pose.
- **`cancel`.** Clears the line.

### Voice

`VoiceAgent.swift` speaks the ElevenLabs Conversational AI WebSocket protocol directly:

- **Microphone.** 16 kHz mono 16-bit PCM, sent as base64 `user_audio_chunk`.
- **Playback.** The agent's `audio` events are played as they arrive; `interruption` flushes playback; `ping` is answered with `pong`.
- **Echo.** The microphone sends silence while Clipa speaks. Voice processing (echo cancellation) is opt-in (`"echo_cancellation": true`); with it the microphone stays open.
- **Roles.** Show uses `role=interviewer`; Pass it on uses `role=tutor`.
- **Secrets.** The signed URL is a secret: it is never logged, and connection errors are reported by code only.

### Smoke test

`Clipa.app/Contents/MacOS/Clipa --smoke` runs headless, with no menu bar, no overlay, no capture and no audio devices. It uses the app's own client code against the live server:

1. creates a session and reads the cue stream;
2. sends the conductor events;
3. starts the screen session and uploads one synthetic JPEG frame through the uploader;
4. opens the ElevenLabs WebSocket and pushes one second of synthetic audio through the microphone converter;
5. has the agent say one `[ASK]` line;
6. ends the stage and waits for `open_web`.

It prints statuses only and exits non-zero on failure. CI runs it on manual runs (`workflow_dispatch`) only, so a push never calls the server.

## Permissions

| Permission | Why | Without it |
| --- | --- | --- |
| Screen Recording | the SCStream of the main display | No screen stream. The stage still runs, with voice. After granting, quit and reopen Clipa. |
| Microphone | talking with Clipa | Clipa still speaks, but cannot hear you. |
| Input Monitoring (or Accessibility) | typing detection from input timing (`CGEventSource`), so Clipa never asks while you type | Typing may not be detected. |

The menu item **Grant permissions...** asks for them and opens the right pane in System Settings. Ad-hoc signatures change on every build, so after a rebuild macOS may keep a stale grant. Reset it like this:

```bash
tccutil reset ScreenCapture com.hacknation.clipa
tccutil reset Microphone com.hacknation.clipa
tccutil reset ListenEvent com.hacknation.clipa
```

## Configuration

Optional. Nothing secret is configured on the Mac: the server issues the session token and the signed voice URL. Use `~/Library/Application Support/Clipa/config.json` or environment variables:

```json
{ "server": "https://apprentice.exe.xyz", "web": "https://qwadratic.github.io/clipa/", "fps": 2,
  "max_width": 1280, "jpeg_quality": 0.6, "upload_interval": 1.6, "voice": true, "echo_cancellation": false,
  "pointer_marker": true }
```

| Variable | Meaning |
| --- | --- |
| `CLIPA_SERVER` | API base (default `https://apprentice.exe.xyz`) |
| `CLIPA_WEB` | web app opened when there is no Reflect link |
| `CLIPA_FPS` | capture rate, 0.5 to 5 |
| `CLIPA_VOICE=0` | no voice conversation; Clipa only shows her lines |
| `CLIPA_AEC=1` | try macOS voice processing (echo cancellation) first, so Clipa can be interrupted while she speaks. Off by default: the plain audio engine, and the microphone is muted while she speaks |
| `CLIPA_POINTER=0` | no pointer ring on frames and no pointer track with uploads (`"pointer_marker": false` in the file); on by default |

The session log is in `~/Library/Application Support/Clipa/sessions/`. It holds one JSONL file per run with stages, cue types, voice state and per-frame latency. It never holds tokens, signed URLs, images or what was said.

## Code map

```
Sources/Clipa/
  ClipaApp.swift                 entry point, accessory app
  ClipaController.swift          stages (Show, Pass it on), off the record, screen and voice wiring, menu status
  ClipaController+Face.swift     cue rendering, cue_done, [ASK] lines, pointing
  ConductorClient.swift          events out (seq, atMs, retry), SSE cues in (reconnect after last seq)
  ServerAPI.swift                sessions, signed voice URL, screen start/frames/lifecycle, conductor routes
  ScreenStreamer.swift           SCStream capture, change detection, pointer ring, JPEG
  PointerTracker.swift           pointer samples (100 ms, last 5 s), dwell, thinned trail
  FrameUploader.swift            one in flight, latest wins, pacing, latency log
  VoiceAgent.swift               ElevenLabs Conversational AI WebSocket, microphone and playback
  SmokeTest.swift                Clipa --smoke, the headless server-path check
  OverlayController.swift        presence, flight to a target, speech bubble
  BuddyView.swift, BuddyModel.swift, OverlayWindow.swift   Clipa and the click-through overlay
  IdleMonitor.swift              typing / working / pause / idle / away
  MenuBarController.swift, Permissions.swift, Config.swift, Paths.swift, SessionLog.swift, ImageTools.swift
Resources/Info.plist
Resources/kb/                    the old knowledge bases, kept only for sandbox/check_cues.py; not in the app
scripts/build-app.sh
```

## Honest limits

- **Not run interactively on a Mac yet.** The macos-15 CI build runs `swift test`, then compiles and assembles a universal (arm64 + x86_64) app, checked with `lipo`. `Clipa --smoke` (below) runs the server path with the app's own code on the CI Mac, on every push to `release` and on a manual run, whenever the Clipa server answers (skipped, not failed, when it does not). Screen capture, the real microphone (voice processing), playback through the speakers, the overlay motion and the display-change/sleep-wake restart below are untested on real hardware unless that CI smoke run proves the server path still works.
- **No masking on macOS frames yet.** Frames leave the Mac as they are on screen: no masks, no redaction. Use synthetic demo data only. Off the record stops the stream and the voice, but does not recall frames or audio already sent. The screen pipeline does not clean speech.
- **Main display only.** Pointing maps onto the main display, and the overlay sits on every screen.
- **Typing detection.** Input Monitoring is now requested at first launch, next to Screen Recording, not only from the "Grant permissions..." menu item. It still needs the grant on current macOS; without it, Clipa may start a question while you type, though the conductor still waits for pauses in what it sees. A denied microphone no longer starts the voice session silently: the bubble says so once, the same way a denied screen does.
- **Server must be https.** `CLIPA_SERVER` (env var or the config file) is ignored, with a reason logged to stderr, unless it is `https://`: every request to it carries frames, the transcript and the bearer token. `CLIPA_WEB`, only ever opened in a browser, still accepts `http://` too.
- **Display changes and sleep.** The screen step restarts (through the same serialized `screenStep` queue used for pause/resume/stop) on `NSApplication.didChangeScreenParametersNotification` and on wake, and pauses cleanly before sleep, so a resolution change, a monitor swap or a nap no longer leaves the stream dead until an SCStream error. Not yet run through an actual sleep/wake cycle or a monitor change on real hardware.
- **Echo cancellation is opt-in.** By default Clipa plays through the plain audio engine (the path the CI smoke test plays through) and mutes the microphone while she speaks, so she cannot be interrupted by voice. `"echo_cancellation": true` (or `CLIPA_AEC=1`) tries macOS voice processing first; where it cannot start, or starts but plays nothing (the app checks with 0.2 s of silence), she switches back to the plain engine and the menu says "echo cancellation off". If she cannot be heard at all, the bubble says why once, and the menu's Voice line keeps the reason.
- **Reflect link.** The link from `open_web` carries a join code that works once, for five minutes. Opened later, the web app starts unlinked.
- **Distribution.** Ad-hoc signed universal (arm64 + x86_64) build: still no notarization and no auto-update.

The cursor-companion patterns come from [Clicky](https://github.com/farzaa/clicky) (MIT); see `THIRD_PARTY_NOTICES.md`.
