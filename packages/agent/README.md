# @apprentice/agent

Stream B's standalone package: the agent side of the AI Apprentice. It has no runtime dependencies and needs no network or keys; its own `package.json` and lockfile hold only dev tools (TypeScript, `@types/node`), so it can be developed and tested before stream A's root workspace lands.

## Run the tests

```
cd packages/agent
npm ci
npm run typecheck   # tsc --noEmit (TypeScript 7), strict
npm test            # node --test, Node >= 22.18 (native TypeScript stripping)
```

Code rules for this package: `.ts` files only, explicit `.ts` import extensions, no enums, no parameter properties, no path aliases, `import type` for types, no `any`, no `@ts-ignore`, no non-null assertions (tests use `must()` from `test/helpers.ts`). The tsconfig enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. Validation is hand-written (`src/validation.ts`) until zod lands with the skeleton.

## Contents

| Path | What |
| --- | --- |
| `src/contract-draft.ts` | ScreenBridge v1 draft (`schemaVersion` 1): `ScreenObservation`, `ScreenStatus`, `ScreenEvidence`, `ActionCheckpoint`, `CheckpointReply`, the `ScreenBridge` interface, the facts schema (order with nullable fields, email draft, ticket with `summary`, `input_activity` heartbeat with `lastInputAtMs`), the envelope (`source` vision or workspace, nullable `frameId` and `sourceRevision`), checkpoint `revisions` (no facts) and reply `basedOn`, `factsFromCheckpoint` (order and email facts read from the referenced vision observations, or `{incomplete: true, reason}`), lifecycle methods returning `Promise<void>` (`onStatus` is authoritative), and validators. Aligned with doc-7 and its v1.1 notes (TASK-3.23). Proposal for TASK-1; stream A replaces it with `packages/contracts`. |
| `src/schema.ts` | Internal model: `WorkStep`, `Guardrail`, `Utterance` (speakers expert, agent, novice), `MapVersion` (keyed by `workMapId`, not by session), `QuestionCandidate`, `CoachCommand`, `CoordinatorState`, `SessionState`, validators, the `KnowledgeStore` interface (`getLatestConfirmedMap(workMapId)`), `InMemoryKnowledgeStore` and `attributeMarkerTurns` (turns that start with `[ASK]` are the agent's question, source `harness`). |
| `src/fake/screen-bridge.ts` | `FakeScreenBridge`: takes a fixture object and replays it on an injectable clock; browser-safe (no `node:` imports). `start()` pauses with `mask-review` until `confirmMasks()`; lifecycle calls resolve to `void` and the outcome is read from `onStatus`; `pause()` while already paused never downgrades `off_record`; checkpoint ids are `${sessionId}:cp-N`; the timeline runs on the wall clock and observations that fall due while paused are dropped; `blockResume(reason)` simulates a refused resume. `raiseCheckpoint()` plays the sandbox at Preview (observation ids and revisions, no facts); `replyToCheckpoint` rejects unknown checkpoint ids (including ones from an earlier session) and a `basedOn` that differs from the checkpoint's revisions; `confirmMasks()` resumes only from a `mask-review` pause and never lifts an off-the-record pause; `lastInputAtMs` is shifted by the same capture-start offset as `timestampMs`. |
| `src/fake/fixture-node.ts` | Node-only fixture loader (`loadFixture`, `loadLearnCustomer07`). Exported as the subpath `@apprentice/agent/node`; never imported from `src/index.ts`, which a test keeps free of `node:` modules. |
| `src/fake/voice-adapter.ts` | `VoiceAdapter` interface and the scripted `FakeVoiceAdapter` (`transcript` with roles `expert`, `novice` and `agent`, `user_speaking`, `mode`, `spoken`, `status` events); its script runs on the wall clock and steps due while paused are dropped. |
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
await bridge.start({ sessionId: "demo", sessionEpochMs: clock.now() }); // status: paused, reason mask-review
await bridge.confirmMasks(); // status: capturing
clock.advance(26_000);
```

## Behaviour that real implementations must match

- Every `timestampMs` counts from the `sessionEpochMs` passed to `start()` and is a wall-clock offset (`now - sessionEpochMs`).
- `start()` ends paused with reason `mask-review`; capturing begins only after the masks are confirmed. `start()`, `pause()`, `resume()` and `stop()` resolve to `void`, and a resolved call does not mean the screen is capturing: `onStatus` is authoritative. Mask review, a refused resume (geometry change, muted source) and `off_record` arrive only as a `ScreenStatus`; a refusal is not an error, and the UI shows "review masks" instead of "capturing".
- After `pause()` nothing is emitted. Observations that would have occurred while paused are dropped, never deferred or replayed in a burst; paused time is a gap in session time. `pause('off_record')` is the off-the-record action and reports `reason: 'off_record'`; a later plain `pause()` does not downgrade it, only `resume()` or `stop()` end it.
- `input_activity` has `source: 'workspace'`, `frameId: null`, `sourceRevision: null`; every other observation is `source: 'vision'` with a real `frameId`. `input_activity` obeys `idleMs = timestampMs - lastInputAtMs` (validator: within 1 ms, `lastInputAtMs <= timestampMs`): no heartbeat before the first input of a session, one right on input then at most every 2 s, the first `typing:false` about 2000 ms after the last input with its real idle time, idle heartbeats every 2 s and none after the first one at or after 10000 ms. A checkpoint carries `observationIds` and opaque `revisions` only; read the facts with `factsFromCheckpoint` (vision source, same session, matching revisions; otherwise incomplete, never clear). The reply echoes `basedOn`; apply a reply only if `replyIsCurrent` (both revisions still current).
- A voice `spoken` event fires only after the agent really finished speaking; a cancelled or paused utterance never counts as asked.
- Facts describe only what is visible. Unknown entities are `null`, never guessed.

## Known gaps

- Nothing known beyond the open TASK-1 items: A publishes `packages/contracts`, then B migrates its imports; the polling return path (`GET /screen/sessions/{sessionId}/updates`) is pinned by A.
