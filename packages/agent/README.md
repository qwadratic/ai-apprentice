# @apprentice/agent

Stream B's standalone package: the agent side of the AI Apprentice. It has no runtime dependencies and needs no network, keys or root install, so it can be developed and tested before stream A's skeleton lands.

## Run the tests

```
cd packages/agent
npm test        # node --test, Node >= 22.18 (native TypeScript stripping)
```

Code rules for this package: `.ts` files only, explicit `.ts` import extensions, no enums, no parameter properties, no path aliases, `import type` for types. Validation is hand-written (`src/validation.ts`) until zod lands with the skeleton.

## Contents

| Path | What |
| --- | --- |
| `src/contract-draft.ts` | ScreenBridge v1 draft (`schemaVersion` 1): `ScreenObservation`, `ScreenStatus`, `ScreenEvidence`, `ActionCheckpoint`, `CheckpointReply`, the `ScreenBridge` interface, the facts schema (order with nullable fields, email draft, ticket with `summary`, `input_activity` heartbeat with `lastInputAtMs`), the envelope (`source` vision or workspace, nullable `frameId` and `sourceRevision`), checkpoint `revisions`/`facts` and reply `basedOn`, `start()`/`resume()` returning `{state, reason}`, and validators. Aligned with doc-7 and its v1.1 notes (TASK-3.23). Proposal for TASK-1; stream A replaces it with `packages/contracts`. |
| `src/schema.ts` | Internal model: `WorkStep`, `Guardrail`, `Utterance` (speakers expert, agent, novice), `MapVersion` (keyed by `workMapId`, not by session), `QuestionCandidate`, `CoachCommand`, `CoordinatorState`, `SessionState`, validators, the `KnowledgeStore` interface (`getLatestConfirmedMap(workMapId)`), `InMemoryKnowledgeStore` and `attributeMarkerTurns` (turns that start with `[ASK]` are the agent's question, source `harness`). |
| `src/fake/screen-bridge.ts` | `FakeScreenBridge`: takes a fixture object and replays it on an injectable clock; browser-safe (no `node:` imports). `start()` pauses with `mask-review` until `confirmMasks()`; the timeline runs on the wall clock and observations that fall due while paused are dropped; `blockResume(reason)` simulates a refused resume. `raiseCheckpoint()` plays the sandbox at Preview (revisions and facts included). |
| `src/fake/fixture-node.ts` | Node-only fixture loader (`loadFixture`, `loadLearnCustomer07`). Exported as the subpath `@apprentice/agent/node`; never imported from `src/index.ts`, which a test keeps free of `node:` modules. |
| `src/fake/voice-adapter.ts` | `VoiceAdapter` interface and the scripted `FakeVoiceAdapter` (`transcript`, `user_speaking`, `mode`, `spoken`, `status` events). |
| `src/fake/clock.ts`, `src/clock.ts` | `Clock` interface, system clock and the deterministic `FakeClock`. |
| `../../fixtures/agent/learn-customer07.json` | Mock Learn session: order opened, template screenshot attached then replaced by typed text, typing heartbeats, Preview. Synthetic data only. |
| `../../fixtures/agent/sandbox-requirements.md` | What stream A's demo workspace must provide. |

## Example

```ts
import { FakeClock, FakeScreenBridge } from "./src/index.ts";
import { loadLearnCustomer07 } from "./src/fake/fixture-node.ts"; // package subpath: @apprentice/agent/node

const clock = new FakeClock(1_000_000);
const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
bridge.onObservation((o) => console.log(o.timestampMs, o.kind));
await bridge.start({ sessionId: "demo", sessionEpochMs: clock.now() }); // -> { state: "paused", reason: "mask-review" }
await bridge.confirmMasks(); // -> { state: "capturing" }
clock.advance(26_000);
```

## Behaviour that real implementations must match

- Every `timestampMs` counts from the `sessionEpochMs` passed to `start()` and is a wall-clock offset (`now - sessionEpochMs`).
- `start()` ends paused with reason `mask-review`; capturing begins only after the masks are confirmed. `start()` and `resume()` resolve to `{state, reason?}`; a refused resume (mask review, geometry change, muted source) is a normal result, not an error, and the UI shows "review masks" instead of "capturing".
- After `pause()` nothing is emitted. Observations that would have occurred while paused are dropped, never deferred or replayed in a burst; paused time is a gap in session time. `pause('off_record')` is the off-the-record action and reports `reason: 'off_record'`.
- `input_activity` has `source: 'workspace'`, `frameId: null`, `sourceRevision: null`; every other observation is `source: 'vision'` with a real `frameId`. A checkpoint carries opaque `revisions` and the workspace `facts`, and the reply echoes `basedOn`; apply a reply only if `replyIsCurrent` (both revisions still current).
- A voice `spoken` event fires only after the agent really finished speaking; a cancelled or paused utterance never counts as asked.
- Facts describe only what is visible. Unknown entities are `null`, never guessed.

## Known gaps

- `FakeScreenBridge.replyToCheckpoint` validates the reply shape but does not reject unknown checkpoint ids or stale `basedOn` revisions (use `replyIsCurrent`).
- `FakeVoiceAdapter` still emits transcript roles `expert` and `agent` only and freezes its timeline on pause; it has not been aligned with the wall-clock rule or the `novice` role.
- Open between the streams (TASK-1): stream A's review asks to drop `ActionCheckpoint.facts` and to define `idleMs = timestampMs - lastInputAtMs`; this draft keeps B's position (`facts` present, `idleMs` as in doc-7) until the owners agree.
