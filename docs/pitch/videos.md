# Submission videos

Two videos for the submission (TASK-3.19). The web app header links to both ("Demo video", "Tech video").

| File | What it covers | Script |
| --- | --- | --- |
| `apps/web/public/videos/clipa-story.mp4` | The story in 52 s: the problem, Meet Clipa, Show → Reflect → Pass it on on the customer_07 case, the closing line. Illustrated, synthetic data, AI voice; made by the team outside this toolkit | — |
| `apps/web/public/videos/clipa-demo.mp4` | The product: the problem, then the whole journey Show → Reflect → Pass it on in the live web app | [video-demo.md](video-demo.md) |
| `apps/web/public/videos/clipa-tech.mp4` | How it is built: architecture, the screen contract, the Conductor, the Work Map, the tutor check, how we built it, honest limits | [video-tech.md](video-tech.md) |

Both are 1920x1080, H.264 with an AAC track, rendered with the Remotion toolkit in [`video/`](../../video/README.md). They have **captions and no voice-over**: the ElevenLabs key in the build environment was not valid, so the audio track is silent. A voice-over can be added later, recorded by Ivan or generated with ElevenLabs TTS on the VM, and muxed onto the same files (see "Replace a file").

## How they were made

1. **Product capture.** `video/recorder/journey.ts` drives the live web app (https://qwadratic.github.io/clipa/) in headless Chromium against the live API (https://apprentice.exe.xyz) and films it through Chrome's screencast, in one take: Start Show, the expert's typing in the demo workspace, End Show, Reflect with its Work Map, the open point, the teach-back, a correction and Confirm, then Pass it on with a new case, the fix, the allow case and Off the record. The rail clip comes from `video/recorder/walkthroughs/ui-tour.json`, recorded earlier the same morning, before the header moved Off the record into its More menu.
2. **Storyboards.** `video/capture/build-storyboards.mjs` writes `video/scripts/demo.json` and sets the clip times in `video/scripts/tech.json` from the take's markers (`assets/recordings/journey.json`). Every Clipa line quoted in a caption is copied from the cues the API sent during the take (`journey.cues.json`).
3. **Render.** `npm run render -- Sample --script scripts/demo.json --out out/clipa-demo.mp4`, the same for `tech.json`.
4. **Web-ready file.** `bash capture/finalize.sh out/clipa-demo.mp4 ../apps/web/public/videos/clipa-demo.mp4` re-encodes to H.264 with faststart and adds a silent AAC track. The committed files went through `capture/splice-outro.sh` instead, which does the same and swaps in a re-rendered closing card (`npm run render -- ClipaOutro --script …`) without rendering the whole video again.

## What is real and what is simulated

Real:

- The web app and its UI, its sessions on the live API, the Conductor's timing decisions and every Clipa line in the product clips: the questions in Show, the Work Map and its versions, the open point, the teach-back and the confirmation in Reflect, the warning before Send and the silence in the allow case in Pass it on. The live API and its model runner (the Codex CLI) produced them during the take; none of them was written by us.
- The architecture, the timing rules, the test counts (from `npm run check` on this branch) and the deployment facts in the tech video, taken from `docs/pitch/video-tech.md`, `backlog/docs/doc-11` and doc-12.

Simulated, and labelled on screen ("Simulated input: screen events and answers posted as text · synthetic data"):

- **The screen.** Headless Chromium cannot share a screen, so the recorder posts the typed `screen_activity` observations that the vision step would produce for a shared screen (the conductor protocol accepts observations from a client). Each one describes what the demo workspace in the page shows at that moment. The typing in the workspace itself is real input in the page.
- **The voice.** No voice conversation was opened: the recorder blocks the voice signed-URL request, so the app runs without voice and says so. The expert's and the new hire's spoken answers are posted to the live API as transcript text. The captions quote them word for word.
- **The people and the data.** The expert and the new hire are played by the recorder with answers a teammate wrote. Every customer, order, address and amount is synthetic.

The videos keep the honesty lines: Clipa warns and never clicks or blocks another app; Off the record stops the screen and the voice and does not recall what was already sent; masks protect the screen, not speech.

The takes confirmed synthetic customer_07 maps on the live API (the process library). Clear them before a live take as `demo-script.md` says (remove `/var/lib/apprentice/maps.json`, then restart the API).

## Replace a file

Drop a new MP4 at the same path (`apps/web/public/videos/clipa-demo.mp4` or `clipa-tech.mp4`); the header links stay the same. Keep it H.264 + AAC, ideally 1920x1080 and under 40 MB, with faststart so it plays before it has fully downloaded. For a Mac screen recording, for example:

```sh
ffmpeg -i recording.mov -vf "scale=1920:-2" -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k -movflags +faststart apps/web/public/videos/clipa-demo.mp4
```

To add a voice-over to the existing video, mux it in place of the silent track:

```sh
ffmpeg -i clipa-demo.mp4 -i voiceover.m4a -map 0:v -map 1:a -c:v copy -c:a aac -shortest -movflags +faststart clipa-demo-vo.mp4
```

To make a new take: `cd video && npm ci && NODE_USE_ENV_PROXY=1 npx tsx recorder/journey.ts` (it opens real sessions on the live API; `NODE_USE_ENV_PROXY` is only needed behind an HTTPS proxy), then `node capture/build-storyboards.mjs`, render and finalize as above.
