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
| `src/contract-draft.ts` | ScreenBridge v1 draft (`schemaVersion` 1): `ScreenObservation`, `ScreenStatus`, `ScreenEvidence`, `ActionCheckpoint`, `CheckpointReply`, the `ScreenBridge` interface, the facts schema (order, email draft, ticket, `input_activity` heartbeat) and validators. Proposal for TASK-1; stream A replaces it with `packages/contracts`. |
| `src/schema.ts` | Internal model: `WorkStep`, `Guardrail`, `Utterance`, `MapVersion`, `QuestionCandidate`, `CoachCommand`, `CoordinatorState`, `SessionState`, validators, the `KnowledgeStore` interface and `InMemoryKnowledgeStore`. |
| `src/fake/screen-bridge.ts` | `FakeScreenBridge`: replays a fixture on an injectable clock. `pause()` freezes the timeline, `resume()` continues without a jump. `raiseCheckpoint()` plays the sandbox at Preview. |
| `src/fake/voice-adapter.ts` | `VoiceAdapter` interface and the scripted `FakeVoiceAdapter` (`transcript`, `user_speaking`, `mode`, `spoken`, `status` events). |
| `src/fake/clock.ts`, `src/clock.ts` | `Clock` interface, system clock and the deterministic `FakeClock`. |
| `../../fixtures/agent/learn-customer07.json` | Mock Learn session: order opened, template screenshot attached then replaced by typed text, typing heartbeats, Preview. Synthetic data only. |
| `../../fixtures/agent/sandbox-requirements.md` | What stream A's demo workspace must provide. |

## Example

```ts
import { FakeClock, FakeScreenBridge, loadLearnCustomer07 } from "./src/index.ts";

const clock = new FakeClock(1_000_000);
const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
bridge.onObservation((o) => console.log(o.timestampMs, o.kind));
await bridge.start({ sessionId: "demo", sessionEpochMs: clock.now() });
clock.advance(26_000);
```

## Behaviour that real implementations must match

- Every `timestampMs` counts from the `sessionEpochMs` passed to `start()`.
- After `pause()` nothing is emitted; `resume()` continues from the same point of the timeline and does not replay or burst. Time spent paused is part of session time, so later timestamps shift accordingly.
- A voice `spoken` event fires only after the agent really finished speaking; a cancelled or paused utterance never counts as asked.
- Facts describe only what is visible. Unknown entities are `null`, never guessed.
