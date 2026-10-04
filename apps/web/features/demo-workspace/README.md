# Demo workspace (TASK-2.4)

Independent order → email → ticket component. All data is synthetic; Send only records a snapshot in memory. No mail transport, network request, persisted rule or tutor is implemented here. The old `mac/` and `sandbox/` applications are untouched.

## Run and verify

Use Node 24 (or a Node release with native TypeScript stripping). From the repository root:

```sh
node --test apps/web/features/demo-workspace/tests/*.test.ts
node apps/web/features/demo-workspace/preview.mjs
```

Open `http://127.0.0.1:4174`. The preview is explicitly offline and lets a human select clear, warn, unknown, technical error, timeout or absent agent. Responses are independent of the customer and draft; these mocks are not vision or a working tutor. The server serves only an explicit file allowlist on loopback. Test expectations are never served.

Strict type checking with TypeScript 5.9.3 or compatible compiler:

```sh
tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --lib ES2022,DOM,DOM.Iterable apps/web/features/demo-workspace/index.ts apps/web/features/demo-workspace/mock.ts
```

Independent verification: 30 Node tests pass; production sources and the mock pass strict type checking. In the in-app browser, verified pending, edit invalidation with a visible activity event, warning acknowledgement and manual Send, ticket resolution, Reset, new text-plus-image case, timeout, absent agent and unknown. The compatibility update also verified the second customer_12 case, idle after text input and off-record cancellation with no heartbeat from local edits while paused. Activity timer tests cover typing/idle cadence, all three surfaces, cancellation of saved callbacks, task/session reset, off-record and dispose. This verifies the offline component, not live ScreenBridge/tutor behavior or host memory persistence. The local preview does not serve tests or their expected answers.

## Connect to the app shell

Import `createWorkspace` and `mountDemoWorkspace` from `index.ts`, and load `workspace.css` through the shell's bundler. No root dependency or lockfile changes are required. A host can mount this component inside a React ref/effect without giving it ownership of the shell:

```ts
const workspace = createWorkspace({
  sessionId: session.id,
  checkpoint: adapter,
  onInputActivity: activity => reportSandboxInputActivity(activity),
});
const unmount = mountDemoWorkspace(container, workspace);
// On shell cleanup:
unmount();
workspace.dispose();
```

The host owns session timing, the actual ScreenBridge, voice and knowledge. For a new session call `setSession(newId)`. On pause/off-record call `setOffRecord(true)` to stop workspace heartbeats and invalidate authorization. Call `setCheckpoint(undefined)` on agent disconnect or lost screen capture; reconnect with a fresh adapter after both channels are ready, then call `setOffRecord(false)` to resume the workspace. The workspace off-record flag does not itself stop the host's screen capture or microphone. Replacing the adapter invalidates the check. Reset and case switching clear activity timers and never call the host's knowledge store. Reset preserves the current sessionId and off-record flag; the host may start a new session flow after a task reset.

`CheckpointPort` is a local injection seam, **not an alternative ScreenBridge contract**:

- `observeCurrentScreen(scope, signal)` must acquire current order and email observations through the approved bridge and return `{scope, orderId, emailId}`. Only echo a scope after those observations have been obtained from the displayed pixels for that version. Historical order observations can be reused only if the visible order is unchanged. Echoing a token without observing is not freshness verification.
- `evaluate(observationIds, signal)` must construct the approved ActionCheckpoint using the host sessionId/sessionEpochMs and a unique checkpoint id, await the agent response and verify its checkpointId before returning `{status, message, evidenceIds}`.

The component passes a version token and observation ids. It never passes the body, customer, order facts, attachment contents or expected answers into these callbacks. The adapter must bind to the host session, honor abort where possible and correlate replies. The state machine rejects obsolete work even when an adapter ignores abort.

The exact imports, bridge observation-acquisition mechanism, facts schema and correlation implementation await TASK-1/TASK-2.1. Do not wire this seam directly to a tutor with a domain-state feed.

## Behavior

Preview snapshots the local version, not a hidden copy of order facts. Any edit to order, client, subject, body or attachments invalidates a pending or completed check. Reset, session change and adapter replacement also invalidate it. The UI keeps editing available during pending so cancellation is observable. Double Preview does not start a second request. Timeouts, exceptions, missing observations and malformed outcomes show a technical error and disable Send. Warn/unknown require a separate explicit human acknowledgement; clear enables a manual Send. Acknowledgement is cleared by every new check or edit. Send never happens automatically and a second Send has no effect. After Send, the draft and source order are frozen until Reset; the ticket summary remains editable.

Typing notifications carry `{surface, typing, idleMs}`. Only actual text-field/textarea input in this component starts activity. The first event and a surface change report typing immediately; continued typing reports at most every 2 s per surface. After 2 s without input, report idle with elapsed idleMs, then every 2 s until 10 s idle. No initial idle is fabricated before the first input. Selects, checkboxes and Reset do not count as typing. Task reset, session change, off-record and dispose cancel timers and suppress already-scheduled callbacks. Resume waits for fresh input instead of replaying old activity. The host converts these local facts to the approved `input_activity` observation envelope with no entity or evidence. This does not detect keyboard use in other apps or clear agent knowledge.

There are two distinct customer_07 orders, a second-order image-only and text-plus-image pair, customer_03, an unidentified customer and two distinct customer_12 orders. Learn order ORD-2041 matches B fixture 30865d6; the second customer_07 order is ORD-2057. Delivery details are visible in the order and rendered attachment. The runtime has no customer preference or rationale. `tests/expectations.ts` is a human/test oracle for B and is outside the production import graph. B owns checks of corrected and unconfirmed rules. See `ADAPTER-PROPOSAL.md` for the compatibility audit and decisions still needing agreement.

## Integration still required

Use the actual bridge to obtain fresh observation ids and validate correlated agent replies; verify with real capture/vision and B's tutor. Integrate with Learn/Review/Teach and global off-record in the shell. Confirm this component does not clear B's persisted memory on Reset. The offline mock preview does not demonstrate these integrations.
