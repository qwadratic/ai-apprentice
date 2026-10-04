# Submission videos

Two videos for the submission (TASK-3.19). The web app header links to both ("Demo video", "Tech video").

| File | What it covers | Script |
| --- | --- | --- |
| `apps/web/public/videos/clipa-demo.mp4` | The product: the problem, then the whole journey Show → Reflect → Pass it on in the live web app | [video-demo.md](video-demo.md) |
| `apps/web/public/videos/clipa-tech.mp4` | How it is built: architecture, the screen contract, the Conductor, the Work Map, the tutor check, how we built it, honest limits | [video-tech.md](video-tech.md) |

Both are 1920x1080, H.264 with an AAC track, rendered with the Remotion toolkit in [`video/`](../../video/README.md). They have **captions and no voice-over**: the ElevenLabs key in the build environment was not valid, so the audio track is silent. A voice-over can be added later, either recorded by Ivan or generated with ElevenLabs TTS on the VM, and muxed onto the same files (see "Replace a file" below).

## How they were made

1. **Product capture.** `video/recorder/journey.ts` drives the live web app (https://qwadratic.github.io/clipa/) in headless Chromium against the live API (https://apprentice.exe.xyz) and films it through Chrome's screencast: Start Show, typing in the demo workspace, End Show, Reflect, Confirm, Pass it on, a new demo case, Off the record. The other clips come from `video/recorder/walkthroughs/ui-tour.json` (the rail and the header without a session).
2. **Composition.** `video/scripts/demo.json` and `video/scripts/tech.json` hold every word on screen: title cards, captioned clips, the architecture diagram and the fact cards. `npm run render -- Sample --script scripts/demo.json --out out/clipa-demo.mp4` renders a video.
3. **Audio.** A silent AAC track is added so that every player treats the files alike.

## What is real and what is simulated

Real:

- The web app UI, its sessions on the live API, the Conductor's decisions and every Clipa line shown in the product captures: the questions in Show, the Work Map, the open point and the teach-back in Reflect, the warning in Pass it on. They were produced live by the API and its model runner (the Codex CLI) during the recording, not written by us.
- The architecture, the timing rules, the test counts and the deployment facts in the tech video (from `docs/pitch/video-tech.md`, `backlog/docs/doc-11` and doc-12).

Simulated, and labelled on screen:

- **The screen.** Headless Chromium cannot share a screen, so the recorder posts the typed `screen_activity` observations that the vision step would produce for the shared screen (the conductor protocol accepts observations from a client). Each one describes what the demo workspace in the page shows at that moment.
- **The voice.** No voice conversation was opened: the recorder blocks the voice signed-URL request, so the app runs without voice and says so in a banner. The expert's and the new hire's spoken answers are posted to the live API as transcript text.
- **The people and the data.** The expert and the new hire are synthetic (a teammate's words, played by the recorder). Every customer, order, address and amount is synthetic.

The clips carry the badge "Simulated input … synthetic data". The videos keep the honesty lines: Clipa warns and never clicks or blocks another app; Off the record stops both channels and does not recall what was already sent; masks protect the screen, not speech.

## Replace a file

Drop a new MP4 at the same path (`apps/web/public/videos/clipa-demo.mp4` or `clipa-tech.mp4`); the header links stay the same. Keep it H.264 + AAC, ideally 1920x1080 and under 40 MB, with `-movflags +faststart` so it starts playing before it has fully downloaded. For example, for a Mac screen recording:

```sh
ffmpeg -i recording.mov -vf "scale=1920:-2" -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k -movflags +faststart apps/web/public/videos/clipa-demo.mp4
```

To add a voice-over to the existing video, mux it in place of the silent track:

```sh
ffmpeg -i clipa-demo.mp4 -i voiceover.m4a -map 0:v -map 1:a -c:v copy -c:a aac -shortest -movflags +faststart clipa-demo-vo.mp4
```

To re-render from the toolkit: `cd video && npm ci && npx tsx recorder/journey.ts` (a new capture; it opens real sessions on the live API), then adjust the times in `scripts/demo.json` to the new `assets/recordings/journey.json` markers and render as above.
