# Clipa journey (TASK-3.33)

Clipa guides the expert, then the new hire, through the demo in doc-10. The journey is a small state machine over app events: it moves only when the app emits an event, and it drives the Clipa motion director (`createClipaDirector`): fly beside the target control, show one short line in the bubble, go home. Voice is the shell's job.

It is written against how the shell really works. A **mode** is the tab that is selected (learn, review, teach). A **session** is what the Start button makes: one per mode, live until End, the time limit or off the record. Nothing (screen share, microphone, the agent) works until the session of that mode is live, so the journey walks Start and End explicitly:

```
open (Start Learn) -> share -> learn (work) -> start-review -> review-board -> teach-back -> end-review
  -> handoff -> start-teach -> [share-teach] -> teach -> teach-fix -> end-teach (End Teach) -> summary
```

Share comes only after Start Learn. The hand-over to the new hire comes only after the Review session has ended, so the new hire's speech never lands in the expert's transcript. The summary comes when the Teach session ends (or on an explicit `teach_finished`), and then the journey is done and its saved position is cleared.

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
  isSynthetic: () => state.screen.source?.synthetic ?? true, // never claim to see a screen that is sample data
  camera: false,                                           // true only once stream A ships a camera source
  captureInTeach: false,                                   // true if the shell also shares the screen in Teach
  onSay: (line) => voice.speakIfOnRecord(line),            // optional: read the line aloud
});
bus.emit({ type: 'app_ready', mode: currentTab });         // greets, or says "welcome back" after a reload
// <ProgressStrip journey={journey} /> anywhere in the shell
```

`createJourney` returns `{ getSnapshot, subscribe, dispatch, replay, reset, destroy }`. The snapshot is stable between changes (`useSyncExternalStore`). The synthetic personas of TASK-3.32 drive the same engine by emitting the same events into the same bus. Call `journey.reset()` for a "start the demo again" control.

## `data-clipa-target` values the shell must expose

Put `data-clipa-target="<value>"` on the element Clipa should stand beside. The first visible match wins, so for a list mark only the item to point at. A missing target is not an error: Clipa uses the step's fallback, else says the line where she is. Several steps use the same control, so mark it once.

| Value | Element | Used by |
| --- | --- | --- |
| `session-start` | The Start button (its label follows the selected tab: "Start Learn", "Start Review", "Start Teach") | open, start-review, start-teach |
| `session-end` | The End session button (shown while the session is live) | learn (re-nudge), end-review, end-teach |
| `mode-learn` | The Learn tab | open (when another tab is selected) |
| `mode-review` | The Review tab | start-review (when another tab is selected) |
| `mode-teach` | The Teach tab | handoff, start-teach (when another tab is selected) |
| `share-screen` | The "Choose screen or window" button of the Screen panel | share, share-teach |
| `use-camera` | The camera button, only if the shell has a camera source (`camera: true`) | share (phone path) |
| `mask-confirm` | "Confirm masks and share" | share (mask review) |
| `screen-preview` | The live preview of the shared window | learn |
| `workspace` | The demo workspace (also the fallback for `screen-preview`) | learn (sample data), teach |
| `board-gap` | The first open gap on the Review view, only while a gap is open | review-board |
| `review-board` | The Review view (fallback for `board-gap` and `teachback`) | review-board, teach-back |
| `teachback` | The teach-back card | teach-back |
| `send` | The workspace Send button | teach-fix |
| `mastery-summary` | The mastery card of the Teach view | summary |

## Events the shell must emit

All through `bus.emit(...)` (or `journey.dispatch(...)`). Types are in `events.ts`. `app_ready` replaces the earlier `session_started`.

| Event | When |
| --- | --- |
| `app_ready` `{ mode? }` | The page is ready and the Start button is mounted. On every page load, with the selected tab. The journey says nothing before it. |
| `mode_changed` `{ mode }` | The person selected a tab. Only changes which control Clipa points at for Start. |
| `session_live` `{ mode }` | Start was pressed and the session is live (SESSION_READY). |
| `session_ended` `{ mode, reason? }` | The session ended: End, the 10 minute limit, or off the record (`reason: 'off_record'`, or `off_record` was emitted first). Off the record does not count as finishing the step. |
| `share_requested` | The person clicked Share screen. |
| `mask_review` | The picker returned and the person must confirm masks. Optional. |
| `screen_capturing` | The screen capture is live. |
| `camera_capturing` | The camera capture is live (only with a camera source). |
| `screen_unavailable` `{ reason? }` | Sharing was refused or cancelled (`denied`, `error`), is unsupported (`unsupported`), or dropped (`lost`). Only the Share step reacts. |
| `agent_asked` `{ guardrail? }` | The agent is about to ask a question: every spoken ASK_NOW and PREDICT in any mode, sent before the presenter plays. Clipa then stays out of its way for 12 s; the strip counts it; it also ends the Share step (the sample source asks without a shared window). |
| `teachback_started` | The agent speaks the teach-back. Not when it is only shown. |
| `teachback_confirmed` | The expert confirmed the teach-back. |
| `checkpoint_warned` | Teach: the checkpoint warned before Send. |
| `sent` | The new hire pressed Send and it went through. |
| `teach_finished` | An explicit Finish in the mastery card, if the shell has one. The end of the Teach session finishes the journey too. |
| `typing` `{ active }` | Edges, `true` then `false`, from the same source as the director's `isInputActive`. |
| `talking` `{ active, by? }` | Somebody speaks: the person (default) or `by: 'agent'`. |
| `off_record` `{ on }` | Off the record on or off. The journey calls `director.setOff(...)` too (it is idempotent). Emit it before `session_ended`. |

## Behaviour in short

- **Order and exits:** each step ends on its exit events (`journey.ts`), and `skip` events make a step pointless when the person is already further on (a new hire who presses Start Teach skips everything before it). `session_live` / `session_ended` match the named mode or any later one; `mode_changed` matches that tab only.
- **Agent has the floor:** teach-back and teach-fix are agent-voiced. Clipa does not speak there; if she is still pointing at her last control she goes home, and the step's line is only used for the one re-nudge.
- **Quiet:** typing, talking (person or agent), an agent question and off-record silence her at once: a flight in progress is called back, she goes home, and a line she had not said yet is said after the quiet has lasted 1.5 s. A flight the director was holding for the typing is called back the moment it lands. Nothing she already said is repeated.
- **Never stuck:** `director.idle()` does not resolve while she points, so the journey never waits on it then: at its own control it moves her on, at the agent's pose it tries again twice and leaves her. When the agent asks while she still points at a control, she goes home so the agent's approach is not queued behind her. When the new hire's Send goes through after a warning she goes home too.
- **Re-nudge:** at most one per step, a fixed time after the line, and never while quiet. It is stored, so a reload does not repeat it.
- **Reload:** the step is stored in `sessionStorage` under `apprentice.journey.v2` with a run id (every access in try/catch; entries older than 30 minutes, corrupt, finished or from another version are ignored). A reload ends the session, so the journey goes back to where that session is started (Start Learn, Start Review, Start Teach; the hand-over stays). A new tab, a finished journey or a new Learn session starts at step 1: a rehearsal's leftovers never reach the pitch. Teach does not ask the new hire to share a screen unless the shell sets `captureInTeach`.
- **Phones:** without `getDisplayMedia` the first step says plainly that the device cannot share a screen and suggests a laptop. The camera is offered only with `camera: true` (a camera source from stream A). `canShareScreen()` and `canUseCamera()` are in `capabilities.ts`.
- **Honest wording:** when the observation source is synthetic (`isSynthetic`), Clipa says she follows sample events, not the screen. There is no export in the product, so no line mentions one.
- **Reduced motion:** the director honours `prefers-reduced-motion` (no flight, a fade) as long as it is created with the default `reducedMotion: 'auto'`; the strip drops its transitions.
- **Who moves Clipa:** the journey only calls `point`, `speak`, `retreat` and `setOff`, and only when nobody else holds the stage.
- **Progress strip:** `ProgressStrip.tsx` shows Share, Learn, Review, Teach, Summary. A finished phase is a button ("Show me Review again") that makes Clipa say its step again; nothing else changes. If she cannot show it right now the strip says so.

## Checks

`npm test` and `npm run typecheck` in `apps/web/features/agent/clipa` run the journey tests (`journey/test/`) next to the motion tests. The Vite build of `apps/web` type-checks `ProgressStrip.tsx`. `npm run e2e:journey` mounts the real director and the engine on a page in Chromium (`journey/e2e/`) and checks that Clipa moves in the DOM and goes home on typing; it is not part of CI (it needs Playwright, like `npm run e2e`).
