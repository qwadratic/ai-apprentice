# Compatibility audit and adapter proposal

TASK-2.4 audit against `origin/task-3.1-mocks-contract` revision `30865d6`, specifically `fixtures/agent/sandbox-requirements.md`, `fixtures/agent/learn-customer07.json` and `packages/agent/src/contract-draft.ts`. This is a proposal for agreement with B, not an approved shared contract. No B files or shared types were changed or copied into this module.

## Aligned in the local workspace

- Learn: `ORD-2041`, `customer_07`, `14 Sample Lane, 1010 Exampletown`, `2026-10-12 14:00-16:00`, exactly matching the source order in the Learn fixture.
- New customer_07 case: `ORD-2057`, with a different visible address and window. Image-only and text-plus-image variants use the same new order. B specifies the id but no exact second address/window in the reviewed requirements; the chosen data is `82 Sample Walk, 1010 Exampletown`, `2026-10-13 09:00-11:00`.
- Other known customer: `customer_03`; unidentified customer remains null. No alias is guessed for the unknown customer.
- Live new-fact cases: `spare` / `DEMO-1201` and `spare-new` / `DEMO-1202`, both customer_12, with different addresses and windows. Neither contains a preference or rule. The expert supplies the fact live; B tests transfer on the second order.
- The source fields use 20 px text. An attachment renders the order id, address and window visibly. The UI exposes Editing / Preview / Sent in demo and ticket id, order id, customer and Open / Done. Internal `resolved` corresponds to the visible Done state; it is not exported as screen facts.
- Text input reports local `{surface, typing, idleMs}` facts. Typing starts immediately; periodic heartbeat is every 2 s. Silence for 2 s reports idle, followed by 2 s idle heartbeats through 10 s. Changing surface reports the new surface immediately. There is no activity event before the first actual input. Select controls and checkboxes do not report typing.
- Off-record stops activity and checks and invalidates Send authorization. Reset, session changes and dispose clear timers, including protection against already-queued callbacks. Resume never replays activity from before pause. Local editing while off-record remains possible without output.

## Proposed host adaptation

1. Mount `mountDemoWorkspace` in the app shell with one controller and its CSS. The order, email and ticket share one window. The existing local port is a dependency-injection seam; the host should implement it using the agreed contracts package once available.
2. Preview changes visible UI before invoking `observeCurrentScreen`. The adapter must wait for the UI paint and real capture/vision observations for the displayed version. It returns latest order/email observation ids bound to that scope. Reuse an older order observation only with proof the visible order has not changed; otherwise wait or fail explicitly. Do not construct order/email/ticket facts from `getState()`, SVG source, case ids, test expectations or runtime fixture text. Attachment `ocrText` must come from actual image recognition.
3. The host converts local activity facts into the approved `input_activity` envelope: session/sequence/timestamps from the coordinator, `entityRef: null`, `evidenceIds: []`, and an agreed frameId/provenance convention. It must be identified as sandbox input, not vision or global keyboard capture. No order, client, text, preference or rationale is present in this callback.
4. The host constructs the actual ActionCheckpoint with a unique id, both latest observation ids and timestamps relative to its sessionEpochMs. Correlate checkpointId and session before returning a local outcome. Honor AbortSignal when possible; the component independently rejects obsolete replies. This module does not export a competing ScreenBridge.
5. For global off-record, the coordinator calls `workspace.setOffRecord(true)` alongside stopping screen and voice. Only after the channels are ready may it restore the adapter and call `setOffRecord(false)`. Component cleanup calls both the unmount function and `workspace.dispose()`.

## Decisions requiring agreement with B

- The fixture uses `contact_customer_07` as email recipientRef, while the workspace visibly identifies the recipient as `customer_07`. Agree the canonical recipient/entity convention or add a visible contact identity. Do not silently invent a contact-to-customer association in the adapter.
- B says warn/unknown leave Send available. The current workspace requires an explicit acknowledgement before Send; both preserve a human decision. Agree whether to keep this extra acknowledgement or rely on the Send click. No change to this policy is made by this compatibility patch.
- B asks Reset to start a new sessionId flow. The workspace resets taskGeneration and discards old checks/activity while retaining sessionId and confirmed agent memory. The coordinator should detect/reset the task and start a fresh shared session id/epoch, then call `setSession`. It must not clear the confirmed Work Map. Agree this lifecycle before integration.
- B permits DOM-derived observations in its open questions. The user's scope requires real visual observation of order/email/ticket facts. Only scoped input activity is emitted directly; agree this provenance explicitly.
- Agree an initial idle event if B needs one before any input. This patch reports idle after observed input stops, avoiding a claim about keyboard activity outside the sandbox.

Expected answers remain in `tests/expectations.ts`, outside the production import graph and preview server allowlist. There are no hidden personal rules in runtime data or callbacks. Real capture, tutor behavior and preserved B memory still require an integrated browser rehearsal.
