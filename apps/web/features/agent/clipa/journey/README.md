# Clipa journey (TASK-3.33)

Clipa guides the expert, then the new hire, through the demo in doc-10: Share, Learn, Review (the briefing board and the teach-back), Teach, Summary. The journey is a small state machine over app events. It moves only when the app emits an event, and it drives the Clipa motion director (`createClipaDirector`): fly beside the target control, show one short line in the bubble, go home. Voice is the shell's job.

This note is the handoff for whoever wires it into the shell: what to mark in the DOM, what to emit, and how to construct it.

## Wiring

```ts
import { createClipaDirector } from '../clipa/src/index.ts';
import {
  createDomTargetResolver, createJourney, createJourneyEventBus, createJourneyTargetResolver,
} from '../clipa/journey/index.ts';
import { ProgressStrip } from '../clipa/journey/ProgressStrip.tsx';

const bus = createJourneyEventBus();                       // the shell emits into this
const byValue = createDomTargetResolver(document);         // data-clipa-target value -> rect
const director = createClipaDirector({
  root: document.body,
  isInputActive,                                           // the shell's own typing detector
  resolveTarget: createJourneyTargetResolver(byValue, existingResolveTarget), // journey targets + the brain's surfaces
});
const journey = createJourney({
  director, events: bus, resolveTarget: byValue,
  isCapturing: () => capture.state === 'capturing',        // false after a reload, which is right
  onSay: (line) => voice.speakIfOnRecord(line),            // optional: read the line aloud
});
bus.emit({ type: 'session_started', mode: currentMode });  // greets, or resumes after a reload
// <ProgressStrip journey={journey} /> anywhere in the shell
```

`createJourney` returns `{ getSnapshot, subscribe, dispatch, replay, reset, destroy }`. The snapshot is stable between changes (`useSyncExternalStore`). The synthetic personas of TASK-3.32 drive the same engine by emitting the same events into the same bus. Call `journey.reset()` for a "start the demo again" control.

## `data-clipa-target` values the shell must expose

Put `data-clipa-target="<value>"` on the element Clipa should stand beside. The first visible match wins, so for a list mark only the item to point at. A missing target is not an error: Clipa uses the step's fallback, else says the line where she is.

| Value | Element | Used by |
| --- | --- | --- |
| `share-screen` | The "Share screen" / "Choose screen or window" button | open, share |
| `use-camera` | The camera button, shown when screen sharing is unavailable (phones) | open, share (phone path) |
| `mask-confirm` | "Confirm masks and share" | share (mask review) |
| `screen-preview` | The live mini-preview of the shared window | learn |
| `workspace` | The demo workspace (also the fallback for `screen-preview`) | learn, teach |
| `mode-review` | The Review tab or button | learn (re-nudge) |
| `board-gap` | The first open gap on the briefing board, only while a gap is open | review-board |
| `review-board` | The briefing board itself (fallback for `board-gap` and `teachback`) | review-board, teach-back |
| `teachback` | The teach-back card | teach-back |
| `mode-teach` | The Teach tab or button | handoff |
| `send` | The workspace Send button | teach-fix |
| `mastery-summary` | The mastery summary panel | summary |

## Events the shell must emit

All through `bus.emit(...)` (or `journey.dispatch(...)`). Types are in `events.ts`.

| Event | When |
| --- | --- |
| `session_started` `{ mode? }` | The page is ready and a session id exists, with the Share control mounted. Also after every reload, with the current mode. The journey says nothing before it. |
| `share_requested` | The person clicked Share screen (or the camera button). |
| `mask_review` | The picker returned and the person must confirm masks. Optional. |
| `screen_capturing` | The screen capture is live. |
| `camera_capturing` | The camera capture is live. |
| `screen_unavailable` `{ reason? }` | Sharing was refused or cancelled (`denied`, `error`), is unsupported (`unsupported`), or dropped during Learn or Teach (`lost`). |
| `mode_changed` `{ mode }` | The app entered `learn`, `review`, `teach` or `summary`. |
| `agent_asked` `{ guardrail? }` | The agent asked a live question. Clipa then stays out of its way for 12 s and the strip counts the question. |
| `teachback_started` | The agent begins the teach-back. |
| `teachback_confirmed` | The expert confirmed the teach-back (the map is confirmed). |
| `checkpoint_warned` | Teach: the checkpoint warned before Send. |
| `sent` | The person pressed Send and it went through. |
| `typing` `{ active }` | Edges, `true` then `false`, from the same source as the director's `isInputActive`. |
| `talking` `{ active, by? }` | Somebody speaks: the person (default) or `by: 'agent'`. |
| `off_record` `{ on }` | Off the record on or off. The journey calls `director.setOff(...)` too (it is idempotent). |

## Behaviour in short

- **Order:** open, share, learn, review-board, teach-back, handoff, teach, teach-fix, summary. A step ends on its exit events (`journey.ts`), and `mode_changed` also skips every step of an earlier mode, so a new hire who starts in Teach goes straight there. A step that names a mode is said only once the app has reached it (the summary waits for `mode_changed: summary`, not for the first `sent`).
- **Agent has the floor:** teach-back and teach-fix are agent-voiced (the agent speaks the teach-back and the checkpoint warning). Clipa does not touch the director then; her line is only used for the one re-nudge.
- **Quiet:** typing, talking (person or agent), an agent question and off-record silence her at once: a flight in progress is dropped, she goes home, and a line she had not said yet is said after the quiet has lasted 1.5 s. Nothing she has already said is repeated.
- **Re-nudge:** at most one per step, a fixed time after the line, and never while quiet. It is stored, so a reload does not repeat it.
- **Reload:** the step is stored in `localStorage` under `apprentice.journey.v1` (every access in try/catch; a stale, corrupt or finished entry is ignored). Steps that need a live capture rewind to the start, because a reload ends the capture.
- **Phones:** without `getDisplayMedia` the first step offers the camera (`use-camera`); with neither it says plainly that the device cannot share and suggests a laptop. `canShareScreen()` and `canUseCamera()` are in `capabilities.ts`.
- **Reduced motion:** the director honours `prefers-reduced-motion` (no flight, a fade) as long as it is created with the default `reducedMotion: 'auto'`; the strip drops its transitions.
- **Who moves Clipa:** the journey only calls `point`, `speak`, `retreat` and `setOff`, and only when nobody else holds the stage. It lets go of her (without moving her) when the agent warns, starts the teach-back or speaks, and it sends her home when the agent asks while she is still at one of its controls, so the agent's approach is not queued behind her.
- **Progress strip:** `ProgressStrip.tsx` shows Share, Learn, Review, Teach, Summary. A finished phase is a button that makes Clipa say its first step again; nothing else changes.

## Checks

`npm test` and `npm run typecheck` in `apps/web/features/agent/clipa` run the journey tests (`journey/test/`) next to the motion tests. The Vite build of `apps/web` type-checks `ProgressStrip.tsx`.
