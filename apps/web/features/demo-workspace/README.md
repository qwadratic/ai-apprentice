# Demo workspace (TASK-2.4)

Independent order → email → ticket component. All data is synthetic; Send records an in-memory snapshot only. There is no mail transport, persisted rule or tutor. The old `mac/` and `sandbox/` applications are untouched.

## Run and verify

Use Node 22.22 or newer. From the repository root:

```sh
node --test apps/web/features/demo-workspace/tests/*.test.ts
node apps/web/features/demo-workspace/preview.mjs
```

Open `http://127.0.0.1:4174`. This explicitly offline preview offers clear, warn, unknown, technical error, timeout and absent-agent mock responses. The mocks do not inspect the customer or draft and do not represent vision or a tutor. `preview.mjs` is a development-only server, not product runtime. Its loopback allowlist never serves tests, the canonical adapter or expected answers.

After the foundation commit is present, strict checking runs through the root workspace:

```sh
npm run typecheck --workspace @apprentice/web
```

Isolated verification resolves `@apprentice/contracts` from the foundation worktree. Current evidence: 38 colocated Node tests pass, 2 additional tests pass against the real doc-7 validators, and the complete feature including tests passes TypeScript 5.9.3 with the app's strict settings. Browser checks cover pending, edit invalidation, warn acknowledgement and manual Send, ticket resolution, Reset, text-plus-image, timeout, absent agent, unknown, second customer_12, elapsed idle and off-record cancellation.

## Connect to the app shell

Import `createWorkspace`, `createScreenBridgeCheckpointAdapter` and `mountDemoWorkspace` from `index.ts`, then load `workspace.css` through the shell bundler. The public mount does not own the app shell:

```ts
const adapter = createScreenBridgeCheckpointAdapter({
  registry: visionObservationRegistry,
  handleCheckpoint: tutorCheckpointHandler,
  contract: { parseScreenObservation, assertCurrentCheckpoint, parseCheckpointReply },
  getSessionEpochMs: id => sessions.epochFor(id),
});
const workspace = createWorkspace({
  sessionId: session.id,
  checkpoint: adapter,
  activityClock: sessionRelativeClock,
  onInputActivity: facts => publishWorkspaceInputActivity(facts),
});
const unmount = mountDemoWorkspace(container, workspace);

// App-shell cleanup:
unmount();
workspace.dispose();
```

The host owns the canonical ScreenBridge, session epoch, voice, knowledge and capture registry. `createScreenBridgeCheckpointAdapter` accepts only same-session ordered vision observations that match the current opaque order/email revisions. It creates and validates the canonical ActionCheckpoint, verifies reply `checkpointId` and `basedOn`, then revalidates the registry after the reply. It never receives order, email, customer, attachment or expected-answer facts from workspace state.

For global off-record, call `setOffRecord(true)` while the coordinator pauses screen and voice. Call `setCheckpoint(undefined)` on capture/agent loss. Restore the canonical adapter and call `setOffRecord(false)` only after both channels are ready. Reset and scenario changes clear local activity and pending checks without touching B's knowledge store. The coordinator starts a new shared session/epoch and calls `setSession(newId)` after reset.

See [SCREENBRIDGE-INTEGRATION.md](./SCREENBRIDGE-INTEGRATION.md) for provenance and owner boundaries.

## Behavior

The workspace exposes opaque `data-order-revision` and `data-email-revision` markers; they contain no user content. Draft edits change only the email revision, order edits change only the order revision, Preview changes the email revision before vision acquisition, and Send changes it again. Reset and session changes replace both. Any edit, Reset, session change, off-record or adapter replacement invalidates a pending or completed check. A late result cannot authorize a newer draft, even when its producer ignores AbortSignal.

Pending and technical errors disable Send. Unknown is labelled not verified. Warn and unknown require explicit human acknowledgement; clear enables the separate manual Send button. Nothing sends automatically, and repeated Send has no effect. After Send, order/email are frozen until Reset while the ticket summary remains editable.

Typing callbacks carry `{surface, typing, lastInputAtMs, idleMs}` on the injected session-relative clock. `idleMs` is the actual callback timestamp minus `lastInputAtMs`, including during typing. The first text input and a surface change report immediately; continued activity reports at most every 2 seconds. After 2 seconds without input, idle reports every 2 seconds through 10 seconds. Selects, checkboxes and Reset are not typing. Reset, session change, off-record and dispose cancel timers and queued callbacks; resume waits for fresh input. The host adds the canonical workspace-source observation envelope with no entity or Evidence. This reports activity only inside this sandbox.

Cases include two customer_07 orders, an image-only and text-plus-image variant of the second order, customer_03, an unidentified customer and two different customer_12 orders. Learn `ORD-2041` matches B fixture `30865d6`; the new customer_07 order is `ORD-2057`. Runtime data contains no preference or rationale. `tests/expectations.ts` is outside production imports and B owns corrected/unconfirmed rule checks.

## Integration still required

Supply the real processed-frame capture/vision registry and B CheckpointHandler, integrate Learn/Review/Teach and global off-record, then rehearse on the deployed stack. Confirm Reset starts a new session without clearing B's persisted memory. Offline mocks and the canonical-validator test do not demonstrate live vision or tutor behavior.
