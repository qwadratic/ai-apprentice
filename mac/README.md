# Apprentice (macOS)

A small buddy that lives next to your cursor and learns how you work. It watches the screen, stays quiet while you type or talk, and at a natural pause asks one short question: why did you do that, is there a limit, when would you stop and ask someone. Your spoken answer is saved as knowledge.

This is the macOS app for Hack-Nation 7, challenge 01 "The AI Apprentice" (ElevenLabs). It is a menu-bar app: no Dock icon, no window, one status item.

Built in the spirit of [Clicky](https://github.com/farzaa/clicky) (MIT), the open-source cursor buddy. See `THIRD_PARTY_NOTICES.md`.

## How it maps to the brief

| Brief module | Status here |
| --- | --- |
| 1. Capture: watch the screen, turn changes into events, ask why at pauses, at least one guardrail question | Done. This is the app. |
| 2. Map: debrief, teach-back, clickable Work Map | Next. The session log (`sessions/*.jsonl`) and `learned.jsonl` are the raw material: every screen event, intervention, answer and OCR snippet with a timestamp and a rule id. |
| 3. Teach: tutor coaches a new hire, catches a wrong decision before it is saved | First slice done: **Teach mode** speaks the expert's warning, with the expert's own reason, when the cursor reaches a risky button on a risky screen. Predict-the-next-step, replay of the expert's screen moment and the mastery summary are next. |

How the app answers the five Apprentice Test questions:

1. **When to ask.** Input timing only (`CGEventSource.secondsSinceLastEventType`): typing, working, pause (2.5 to 8 s without input), idle, away. Questions only in `pause`, never while the expert holds push-to-talk or the buddy is speaking.
2. **What to ask.** A question is picked only after a meaningful screen change matched a rule from the knowledge base (cues seen by on-device OCR). The question is the rule's, or in Claude mode a screenshot-aware rewording of it. Answered rules do not come back.
3. **When it has understood.** Not in this module (debrief is the Map module). `learned.jsonl` already tells which rules have an expert answer and which are still seed text.
4. **Whether the new hire learned.** Teach mode logs every warning and the novice's spoken replies (`novice_answer`). Scoring is next.
5. **Trust.** "Off the record" in the menu stops screenshots, OCR, the microphone and the hotkey, forgets in-memory screen text, and logs only the switch itself. OCR text goes to logs only as a short redacted excerpt (emails, IBANs, card numbers, phone numbers masked). Everything on the default path runs on this Mac.

## The intervention policy

All in `InterventionPolicy.swift` and `ApprenticeController+Flow.swift`.

- Silent while typing (a key within 1.5 s), while the expert talks (push-to-talk held) or while the buddy speaks.
- Learn mode asks only at a `pause`, and only about a screen that just changed meaningfully and matched a rule.
- At most 4 interventions per 10 minutes.
- A rule never repeats in a session unless the screen context changed (the set of numbers and ids on screen, for example invoice 4471 versus 4473). Switching scenario starts a new session.
- At least one guardrail question per session: after two "why" questions with no guardrail, the next question is turned into "is there a limit here, when would you stop and ask someone?" about the matched rule.
- Teach mode warnings protect a novice, so they skip the pause gate and the 4-per-10-minutes budget (they still count in it, still obey the no-repeat rule, and have a 20 s cooldown). A warning fires only when the cursor is on or near one of the rule's `action_words` (Merge, Post, Approve, Refund...) on a screen where the rule's cues are visible.

A rule matches when any `cues` string appears in the OCR text (case-insensitive) and all `requires` strings appear. `kind` ("why" or "guardrail") does not gate the mode; it only labels the entry for the Work Map.

## Build

Requires macOS 14+, Xcode 15.2+ or the Swift 5.9+ toolchain. No external dependencies.

```bash
cd mac
swift build                    # debug binary, quick compile check
scripts/build-app.sh           # release build -> build/Apprentice.app, ad-hoc signed
UNIVERSAL=1 scripts/build-app.sh   # arm64 + x86_64
open build/Apprentice.app
```

`swift run` also works (the binary sets the accessory activation policy itself and finds `Resources/kb` next to the package), but macOS then attributes permissions to your terminal. Use the `.app` for the demo.

CI: `.github/workflows/macos-build.yml` (repo root) builds on `macos-15` and uploads `Apprentice-macos.zip` as an artifact. An app downloaded from a browser is quarantined and ad-hoc signed: run `xattr -dr com.apple.quarantine Apprentice.app` once, or right-click and Open.

## Permissions

Grant these on first use (menu: "Grant permissions..." opens the right panes).

| Permission | Why | Needed for |
| --- | --- | --- |
| Screen Recording | ScreenCaptureKit screenshots | watching the screen (without it the buddy is blind, nothing else breaks) |
| Microphone | push-to-talk answers | voice input |
| Speech Recognition | on-device transcription | voice input |
| Input Monitoring **or** Accessibility | global Control+Option hotkey | push-to-talk while another app is in front |

Granting Screen Recording usually needs an app restart. Idle detection uses only event timing and needs no permission.

Reset after a rebuild (ad-hoc signatures change on every build, so macOS may keep a stale grant that no longer matches):

```bash
tccutil reset ScreenCapture com.hacknation.apprentice
tccutil reset Microphone com.hacknation.apprentice
tccutil reset SpeechRecognition com.hacknation.apprentice
tccutil reset Accessibility com.hacknation.apprentice
tccutil reset ListenEvent com.hacknation.apprentice
```

## Using it

Menu bar eye icon (it becomes a crossed-out eye when off the record):

- **Show buddy**: keep a small buddy visible. By default it is hidden and fades in only to speak.
- **Off the record**: pause all capture and listening.
- **Mode**: Learn (asks the expert why) or Teach (warns the novice).
- **Scenario**: from `kb/index.json`.
- **Open knowledge base folder**, **Open session log**, **Quit**.
- Disabled lines at the top show activity state, screen status, mode, voice, brain and the question budget.

Push-to-talk: hold **Control+Option**, speak, release. The transcript is attached to the last question (within 3 minutes) and appended to `kb/<scenario>/learned.jsonl` with timestamp, rule id and the OCR snippet. Without a recent question it is saved as a note. In Teach mode it is only logged as the novice's answer.

### Demo

Sandbox pages with fake data and 20 px text (so fast OCR reads them) are in `../sandbox/`: `accountant.html`, `programmer.html`, `support.html`. Open one in a browser, pick the matching scenario, and follow `Resources/kb/<scenario>/demo.md` (it is copied to `~/Library/Application Support/Apprentice/kb/<scenario>/demo.md`). For the accountant: Learn mode, open invoice 4471, re-code the cost center to 0400, stop typing for three seconds, and the buddy asks why. Switch to Teach mode, move the pointer to "Post" on a risky invoice, and it warns with the expert's reason.

## Knowledge base

On every launch the bundled `Resources/kb/` is copied to `~/Library/Application Support/Apprentice/kb/`: files that already exist are never overwritten (your edits win), missing files are added, and `index.json` entries are merged by id. To reset a scenario, delete its folder.

```
kb/index.json                  [{"id": "programmer", "name": "...", "title": "..."}]
kb/<id>/profile.md             role, specialty, duties (free markdown; goes into Claude prompts)
kb/<id>/rules.json             [{"id", "title", "kind": "why"|"guardrail", "cues": [...], "requires": [...],
                                 "action_words": [...], "question", "warning", "why", "source": "seed"|"learned"}]
kb/<id>/learned.jsonl          appended by the app: {ts, scenario, rule_id, question, answer, ocr_snippet, mode, kind}
```

The newest learned answer for a rule replaces its seed `why` (shown as `source: learned`) and is what Teach mode quotes.

## Configuration

Optional. With no keys at all the app is complete: rules brain, system voice, on-device OCR and speech.

Environment variables win over `~/Library/Application Support/Apprentice/config.json`. A Finder-launched app does not see shell variables, so for the `.app` use the file:

```json
{
  "elevenlabs_api_key": "YOUR_ELEVENLABS_KEY",
  "elevenlabs_voice_id": "YOUR_VOICE_ID",
  "elevenlabs_model_id": "eleven_v4_turbo",
  "anthropic_api_key": "YOUR_ANTHROPIC_KEY",
  "claude_model": "claude-sonnet-5-5",
  "speech_locale": "en-US"
}
```

| Variable | Meaning |
| --- | --- |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | both set: speak with ElevenLabs (`POST /v1/text-to-speech/{voice_id}`, `model_id` `eleven_v4_turbo`), otherwise the system voice |
| `ELEVENLABS_MODEL_ID` | override the TTS model |
| `ANTHROPIC_API_KEY` | enables the Claude brain (menu toggle "Use Claude brain") |
| `APPRENTICE_CLAUDE_MODEL` | default `claude-sonnet-5-5` |
| `APPRENTICE_LOCALE` | speech locale for dictation and the system voice, default `en-US` |

Keys are never printed or logged. The Claude brain sends a downscaled screenshot (not redacted) to Anthropic: it only runs when a key is configured and the menu toggle is on.

### Swap SystemVoice for ElevenLabs

Nothing to edit: set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (or the two config fields) and restart. `VoiceFactory.make` in `VoiceOutput.swift` picks `ElevenLabsVoice`; if a request fails the line is spoken by `SystemVoice`, so the buddy is never mute. To add another engine, implement the `VoiceOutput` protocol (`speak(_:) async`, `stop()`).

## Code map

```
Sources/Apprentice/
  ApprenticeApp.swift             entry point, accessory app
  ApprenticeController.swift      wiring, state, menu actions, off the record
  ApprenticeController+Flow.swift screen change -> rule -> pause -> words -> speech -> record
  InterventionPolicy.swift        when may the buddy speak
  RulesEngine.swift               cues / requires / action words, context signature
  IdleMonitor.swift               typing / working / pause / idle / away
  ScreenWatcher.swift             ScreenCaptureKit, difference hash, settle logic
  TextRecognizer.swift            Vision OCR (fast mode)
  Brain.swift, ClaudeBrain.swift  RuleBrain (offline), ClaudeBrain (optional)
  VoiceOutput.swift               SystemVoice, ElevenLabsVoice
  PushToTalk.swift, SpeechInput.swift
  OverlayWindow.swift, OverlayController.swift, BuddyView.swift, BuddyModel.swift
  MenuBarController.swift
  KnowledgeBase.swift, KnowledgeModels.swift
  SessionLog.swift, Redactor.swift, ImageTools.swift, Paths.swift, AppSettings.swift, Permissions.swift
Resources/                        Info.plist, kb/
scripts/build-app.sh
```

Data lives in `~/Library/Application Support/Apprentice/`: `kb/`, `sessions/session-<time>.jsonl`, `config.json`.

## Known limits

- Uncertain Apple API calls were reviewed against Apple documentation; the first real check is the macos-15 CI build.
- Screen watching follows the display under the cursor, one display at a time. The first frame after switching displays counts as a meaningful change.
- On macOS 15 the system may ask every few weeks to re-approve screen recording for the app. Approve it, or the buddy goes blind again.
- Fast-mode OCR misses small or low-contrast text. Rules should use cues that are visible words at normal UI sizes.
- Personal data: redaction is regex only (email, IBAN, card, phone). Names and addresses are not caught. Raw OCR text stays in memory and is never written in full. The screenshot sent to Claude is not redacted. Microsoft Presidio is the planned upgrade.
- The expert's speech is captured only while the hotkey is held. A buddy that hears you think aloud (voice activity detection) is not built, so "stay silent while the expert talks" covers push-to-talk and the buddy's own voice, not ambient talking.
- Push-to-talk needs Input Monitoring or Accessibility; modifier-only shortcuts cannot be seen otherwise.
- No debrief, teach-back or Work Map viewer yet (modules 2 and 3 of the brief).
- Ad-hoc signing only: no notarization, no auto-update, no login item.
