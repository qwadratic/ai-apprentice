---
id: doc-12
title: 'Clipa Conductor v1.1 - one Clipa for web and macOS, driven from the server'
type: specification
created_date: '2026-10-04 04:25'
updated_date: '2026-10-04 04:56'
---
# Clipa Conductor v1.1: one Clipa for web and macOS, driven from the server

Status: v1 proposed by stream B on 4 Oct, 04:35 UTC, after Ivan decided that the conductor runs on the server. v1.1 (05:30 UTC) follows Ivan's later answers: each face has its own experience, macOS hands over to the web, the person edits the map only by talking, and reactions are fast. Stream A builds the macOS app and owns its side; counter-proposals go to the Hive integration thread. B owns the conductor and its protocol. Implementation: TASK-3.44 (`apps/api/agent/conductor/`).

## Two faces, one loop (v1.1)

- **Web: the whole journey.** Clipa knows she is in the web app and guides through every stage: share, Learn, Review (the reflection board), Teach and the summary.
- **macOS: a lighter face.** Clipa waits as a dot in the corner and comes out (`presence` peek or full, anchored at the target) to ask or to warn. When it is time for Review or the summary she sends the person to the web (`open_web`). The rest happens in the person's web account: they look at how Clipa understood their workflow, comment and change it.
- **One server loop leads both.** The macOS session's `open_web` link carries a single-use join code (5 minutes). The web app creates its own session, posts `{code}` to `POST /api/agent/conductor/:webSessionId/link`, and from then on its events and cue stream belong to the same conductor. Every cue has `for: all | web | macos`. Each stream gets only its own face's cues, chosen by its hello or by `?client=`.
- **Voice editing.** In Review the person only talks. Everything the expert says goes through `map_edit`, which returns checked operations: set a field, add a step or rule, remove, comment, resolve a gap. The conductor applies them, publishes the new `map` version, says what changed (`say`) and reads the teach-back again when it changed. A reason added by voice keeps the expert's words as its quote.
- **Reaction speed.**
  - Learn questions are prepared as soon as the screen settles after a change (700 ms) and said the moment the pause begins (2.5 s quiet). A newer screen makes a prepared question out of date.
  - In Teach, a visible pending action is checked after 400 ms without waiting for a full pause.
  - The latency-bound tasks (`generic_question`, `guardrail_check`) run on a fast model (`AGENT_FAST_MODEL`); the runner falls back to its default model when that one is not allowed.
  - The conductor's clock ticks every 200 ms. The SSE socket has no Nagle delay.
- **Screen.** The vision path already runs on the VM. To feed observations to the conductor server-side (without a client forwarding them), the screen module calls `agent.observeScreen(sessionId, observation)`; this needs a one-line hook in stream A's hub. Until then, clients forward observations as `observation` events.

## Why

Clipa must be one character across Learn, Review and Teach, and she guides both the expert and the new hire. Her lines, her timing and her behaviour (when to stay quiet, when to ask, where to point, when to warn, what comes next) are decided in one place: the conductor on the VM. Every client is only a face. The web shell and the macOS app render the same cues, each in its own way: in the page, or as an overlay on the real screen.

## Shape

- **Transport.** HTTP only, with no new dependencies. The client POSTs events, and the server streams cues back as Server-Sent Events. URLSession can read a streamed response in Swift, and `fetch` can read it in the browser. The session token goes in the `Authorization: Bearer` header, never in a URL.
  - `POST /api/agent/sessions`: unchanged. It returns `{sessionId, token, issuedAtMs, serverNowMs}`.
  - `GET  /api/agent/conductor/:sessionId/cues?after=<seq>`: an SSE stream of cues. Reconnect with the last seq you saw, and missed cues are replayed.
  - `POST /api/agent/conductor/:sessionId/events`: a batch of client events.
- **Native origin.** The API checks `Origin`. The macOS app sends `Origin: app://apprentice-macos`. Adding that value to `ALLOWED_ORIGINS` on the VM is a live config change, so it needs Ivan's OK.
- **Time.** Every `atMs` counts from the session's `sessionEpochMs`, as in ScreenBridge v1.
- **Voice.** The server never speaks. The client keeps its own ElevenLabs conversation: it gets the signed URL from `GET /api/agent/elevenlabs/signed-url?role=interviewer|tutor`. When a cue carries `speak`, the client sends `[ASK] <text>` into that conversation. The agents' prompts already say that text in the conversation's language.
- **Screen.** Observations come from the vision path (stream A, `ScreenObservation`, including the new `screen_activity` kind with `regions`). The conductor reads them server-side by session id; the client does not forward them. Region boxes are normalised 0..1 to the frame they were read from. The client maps them to its own coordinates: the page preview on the web, the captured display on macOS.

## Client to server: events

`{seq, atMs, event}`, where `event` is one of:

| event | when |
| --- | --- |
| `hello {client: 'web' or 'macos', version, persona: 'expert' or 'new_hire', language?}` | first, after the session is created |
| `mode {mode: 'learn', 'review' or 'teach'}`, `session {mode, live: true or false, reason?}` | the person chose a mode, started it or ended it |
| `share {state: 'requested', 'capturing', 'camera' or 'unavailable', reason?}` | screen sharing |
| `activity {state: 'typing', 'working', 'pause', 'idle' or 'away'}` | macOS reads this from CGEventSource; the web from page input. Send it on every change. This is the main pause signal |
| `talking {by: 'person' or 'agent', active}` and `transcript {role: 'expert' or 'agent', text}` | from the ElevenLabs SDK on the client; only final turns are sent |
| `ui {action: 'confirm', 'correct', 'answer_gap', 'ask_about' or 'finish', targetId?, text?}` | buttons and clicks on the map |
| `cue_done {cueId, outcome: 'spoken', 'shown', 'skipped' or 'interrupted'}` | after rendering each cue |
| `off_record {on}` | off the record. The conductor stops every cue except `state hidden`, aborts its LLM calls and keeps no transcript of that span |

## Server to client: cues

`{seq, cueId, atMs, mode, persona, cue, expiresAtMs?}`. A cue past `expiresAtMs`, or one that arrives while the person is typing or talking, is dropped and reported as `skipped`.

| cue | the client does |
| --- | --- |
| `state {clipa: 'idle', 'listen', 'think', 'speak', 'point', 'warn', 'celebrate', 'retreat' or 'hidden'}` | Clipa's pose and motion |
| `guide {step, phase, text, target?}` | a journey step for this persona: share the screen, start Learn, work and talk, Review the map, confirm the teach-back, a new hire starts Teach, the summary. The text is short and spoken or shown. The target is a UI element |
| `ask {questionId, text, topic, regions[], evidenceIds[]}` | a question at a pause. Speak it through `[ASK]` and point at `regions[0]` |
| `point {target}` | target is `{kind: 'region', regionId, label, box: [x,y,w,h], evidenceId}` or `{kind: 'ui', name}` (`share`, `start`, `mode_tab`, `board_gap`, `teachback`, `summary`) |
| `context {text}` | forward it as an ElevenLabs contextual update, without speaking it |
| `map {version, map}` | a Work Map snapshot (steps, guardrails, gaps) for the Review board |
| `teachback {version, text}` | the read-back that the expert confirms or corrects (`ui confirm` or `ui correct`) |
| `warn {guardrailId, text, regions[], evidenceIds[]}` | Teach, before a pending action that a confirmed guardrail covers. Speak it, point at it, offer the expert's moment. Wording: the tutor warns; it never blocks another app |
| `say {text}` | speak it through `[ASK]` (a reply to the person, for example what Clipa changed on the map) |
| `presence {size: 'dot', 'peek' or 'full', anchor: 'corner' or 'target'}` | macOS only: how far Clipa comes out of the corner |
| `open_web {page: 'review', 'teach' or 'summary', url, text}` | macOS only: say the text and open the URL (it carries a single-use join code) |
| `cancel {cueId}` | the moment passed: stop speaking or pointing |
| `quiet {reason}` | Clipa chose to stay silent and says why (for the log and the debug view only) |

## Behaviour the conductor owns (one place for both clients)

- **Learn.** Ask only at a pause after a meaningful change. At most 4 questions per 10 minutes, at least 45 s apart. Narrow questions that point at regions (`generic_question`).
- **Review.**
  - Build the map from the session (`map_synthesis`). Ask the gaps one at a time.
  - Read the teach-back. Confirm or correct it (`reply_classification`). Resynthesise after a correction.
  - On the board, the person can click a step, a guardrail or a gap, and talk about it (`ui ask_about` / `answer_gap`).
- **Teach.** At a pause, when a pending action or a change appears, run `guardrail_check` against the confirmed guardrails only, then `warn` with the expert's words and moment.
- **Journey.** Guide each persona from the current step to the next. This reuses the DOM-free journey engine from PR #37, moved into a package the server can import.
- **Language.** Follow the language the person speaks now. The agents translate `[ASK]` text, and the generic tasks take the language.
- **Silence.** Never speak while the person types or talks. Ask less and later.

## Out of scope

Server-side speech, blocking clicks in other apps, and accounts that keep maps across sessions (the confirmed map lives in server memory: one team, one demo server).
