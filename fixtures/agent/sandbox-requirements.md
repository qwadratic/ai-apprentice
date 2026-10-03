# Demo workspace requirements (stream B to stream A)

For `apps/web/features/demo-workspace` (TASK-2 / doc-3 section 4). All data is synthetic. The types referenced here are in `packages/agent/src/contract-draft.ts` (draft ScreenBridge v1) and become `packages/contracts` when your skeleton lands. The agent must never be handed a ready-made personal rule: the workspace shows data and screens only.

## Process and screens

One process, three screens, in this order: **order** -> **email** -> **ticket**. All three stay reachable in one window (tabs or a stepper) so one shared window captures them.

1. **Order table / card** (`order_view`): customer, order id, delivery address, delivery window. Pick an order from a list.
2. **Email editor** (`email_draft`): recipient, subject, body text area, attachment list, a button to attach the "order template" screenshot (a rendered image of the order data, see below), a remove-attachment control, **Preview** and **Send**.
3. **Ticket** (`ticket`): ticket id, order id, customer, status (open / done), note field, a "mark done" action.

The order screen shows the delivery address and window in plain visible text, large enough for vision (like the 20 px of `sandbox/`). The template screenshot is an image containing the same essential data (order id, address, window) so OCR can read it (`attachments[].ocrText`).

## Facts the observations must carry

Per observation: `schemaVersion: 1`, `id`, `sessionId`, `sequence`, `timestampMs` (wall-clock offset from `sessionEpochMs`, paused time stays a gap), `source` (`vision` or `workspace`), `frameId` (`null` only when `source` is `workspace`), `sourceRevision` (opaque workspace revision at frame capture, or `null`), `kind`, `facts`, `entityRef` (customer id or `null`), `evidenceIds`. Heartbeats are `source: workspace`; everything else is `source: vision`.

| kind | facts |
| --- | --- |
| `order_view` | `customerRef` (`customer_07` ... ), `orderId`, `deliveryAddress`, `deliveryWindow`; each is `null` when unreadable, masked or unknown |
| `email_draft` | `recipientRef` (or `null`), `subject`, `bodyText`, `attachments[]` = `{kind: image\|pdf\|other, ocrText?}`, `previewState` = `editing\|preview\|sent` |
| `ticket` | `ticketId`, `orderId`, `customerRef`, `status` = `open\|done`, `summary` |
| `input_activity` | `surface` = `order\|email\|ticket`, `typing` (bool), `idleMs`, `lastInputAtMs` (session-relative time of the last actual input) |

A new observation is expected whenever one of these changes (order opened, attachment added or removed, body text changed, preview state changed). An unrecognised customer is `null`, not a guess. Fixture example: `fixtures/agent/learn-customer07.json`.

## Input-activity heartbeat

Screen capture cannot see keystrokes, so the workspace emits `input_activity` itself:

- every 2 s while the person types in any workspace field (`typing: true`, `idleMs: 0`);
- one heartbeat when typing stops (`typing: false`, `idleMs` growing), then again every 2 s while idle up to about 10 s, then stop;
- `source: workspace`, `frameId: null`, `sourceRevision: null`, `evidenceIds: []` (a heartbeat is not a screen moment); `entityRef: null`.

The agent uses it only to stay quiet while the expert types and to detect a pause.

## Scenario data (reset restores exactly this)

| Case | Customer | Orders | Purpose |
| --- | --- | --- | --- |
| Learn | `customer_07` | `ORD-2041` (14 Sample Lane, 1010 Exampletown, 2026-10-12 14:00-16:00) | The expert shows the flow and types the data as text instead of attaching the screenshot. Matches the Learn fixture. |
| Teach T1, T2 | `customer_07` | a second, different order (`ORD-2057`, other address and window) | T1: image only, expected to be caught before Send. T2: full text plus image, expected to be allowed. The same customer must have two clearly different orders. |
| Teach T3 | another known customer, e.g. `customer_03` | one order | The personal rule must not be applied automatically. |
| Teach T4 | unknown customer: not in the customer list, `customerRef: null` | one order | The agent must ask, not guess a match to `customer_07`. |
| Live new-fact test | spare `customer_12` | **two** orders: `ORD-3001` (expert order) and `ORD-3002` (novice order), different addresses and windows, no hint in the data about any preference | During the show the expert processes `ORD-3001` and states a new rule about `customer_12` out loud; the tutor must apply it on the novice order `ORD-3002`. Keep both orders untouched until then. |

Customer names, e-mail addresses and addresses are invented. No real people or companies.

## Preview -> Send checkpoint

- **Preview** switches the email to `previewState: "preview"`, emits an observation, then sends an `ActionCheckpoint` `{schemaVersion: 1, id, sessionId, timestampMs, observationIds, revisions: {order, email}, facts: {order, email}, action: "send"}`. `revisions` are opaque strings that change on every edit; `facts` are the workspace's own snapshot at Preview.
- `observationIds` must include the latest `order_view` observation and the latest `email_draft` observation (more are fine).
- The workspace waits for the agent's reply `{checkpointId, status: clear|warn|unknown, message, evidenceIds, basedOn: {order, email}}` and shows the message in the preview panel only if `basedOn` equals the current revisions (checked again on Send). `warn` and `unknown` do not disable **Send**: the human decides.
- Timeout (provisional 4 s after dispatch, per doc-7) or error: show "check did not complete" and never display it as a pass.
- **Send** sets `previewState: "sent"` and emits an observation. The checkpoint belongs to this workspace only; do not describe it as blocking clicks in other apps.

## Reset and rehearsal

- A visible **Reset scenario** button (and a URL parameter such as `?scenario=teach-t1`) restores all orders, the email draft, the ticket and customer data to the table above, and starts a new `sessionId` flow.
- Scenario selection is possible without code changes: the case list is data.
- Reset must not emit observations from before the reset after it happened (same rule as `pause()`).

## Pause, evidence and replay

- `start()` ends paused with reason `mask-review`; `pause()` stops capture and heartbeats and drops anything unsent; `resume()` continues with wall-clock timestamps, can be refused (resolves `{state: paused, reason}`), and never replays what happened while paused.
- `resolveEvidence(id)` returns `{assetRef, startMs, endMs}` of the processed (masked) frame or clip; the email replacement moment (attach, remove, type) should be a `clip` evidence so the Review and Teach UIs can replay it.

## Open questions for stream A

- Where does the workspace run (same origin as the app shell or an iframe)? A shared window or a second tab changes how `getDisplayMedia` is used.
- Do you emit observations from the DOM state directly, or only through vision? Both are fine for the contract; say which per field so the agent knows how much to trust `ocrText`.
