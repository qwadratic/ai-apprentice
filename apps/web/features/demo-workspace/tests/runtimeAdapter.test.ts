import test from 'node:test';
import assert from 'node:assert/strict';
import type {ActionCheckpoint, CheckpointReply, ScreenObservation, SessionStart} from '@apprentice/contracts';
import {createCheckpointAdapter, type WorkspaceRuntimeHandle} from '../runtimeAdapter.ts';
import type {VersionScope} from '../workspace.ts';

const session: SessionStart = {sessionId: 'session-1', sessionEpochMs: 1_000};
const scope = (draftRevision = 1, email = 'email-r1'): VersionScope => ({sessionId: session.sessionId,
  taskGeneration: 1, draftRevision, revisions: {order: 'order-r1', email}});

function visuals(revisions = scope().revisions): ScreenObservation[] {
  return [
    {schemaVersion: 1, id: 'order-observation', sessionId: session.sessionId, sequence: 1, timestampMs: 100,
      source: 'vision', frameId: 'order-frame', sourceRevision: revisions.order, kind: 'order_view', entityRef: null,
      evidenceIds: ['order-evidence'], facts: {customerRef: null, orderId: 'SYN-1', deliveryAddress: null, deliveryWindow: null}},
    {schemaVersion: 1, id: 'email-observation', sessionId: session.sessionId, sequence: 2, timestampMs: 200,
      source: 'vision', frameId: 'email-frame', sourceRevision: revisions.email, kind: 'email_draft', entityRef: null,
      evidenceIds: ['email-evidence'], facts: {recipientRef: null, subject: 'Visible', bodyText: 'Visible pixels', attachments: [], previewState: 'preview'}},
  ];
}

function harness() {
  let currentSession: SessionStart | null = session;
  let current = visuals();
  const scopes: Array<{sessionId: string; revisions: VersionScope['revisions']}> = [];
  const activities: unknown[] = [];
  const checkpoints: ActionCheckpoint[] = [];
  let dispatch: (checkpoint: ActionCheckpoint, options?: {signal?: AbortSignal}) => Promise<CheckpointReply> = async checkpoint => ({
    schemaVersion: 1, checkpointId: checkpoint.id, status: 'clear', message: 'Current pixels checked.',
    evidenceIds: ['email-evidence'], basedOn: structuredClone(checkpoint.revisions),
  });
  const handle: WorkspaceRuntimeHandle = {
    registry: {async waitForCurrent({signal}) { signal.throwIfAborted(); return structuredClone(current); },
      snapshot() { return structuredClone(current); }},
    getSession: () => currentSession,
    setScope(value) { scopes.push(structuredClone(value)); },
    publishActivity(activity) { activities.push(structuredClone(activity)); return {schemaVersion: 1, id: 'activity',
      sessionId: session.sessionId, sequence: 3, timestampMs: activity.lastInputAtMs, source: 'workspace', frameId: null,
      sourceRevision: null, kind: 'input_activity', entityRef: null, evidenceIds: [], facts: structuredClone(activity)}; },
    async dispatchCheckpoint(checkpoint, options) { checkpoints.push(structuredClone(checkpoint)); return await dispatch(checkpoint, options); },
  };
  return {handle, scopes, activities, checkpoints, setVisuals(value: ScreenObservation[]) { current = value; },
    setSession(value: SessionStart | null) { currentSession = value; },
    setDispatch(value: typeof dispatch) { dispatch = value; }};
}

test('runtime adapter sends only activity directly and dispatches a current visual checkpoint', async () => {
  const fixture = harness();
  const adapter = createCheckpointAdapter({bridgeInternalHandle: fixture.handle});
  adapter.syncScope(scope());
  adapter.onInputActivity({surface: 'email', typing: true, lastInputAtMs: 250, idleMs: 0});
  const reply = await adapter.checkpoint.check(scope(), new AbortController().signal);
  assert.equal(reply.status, 'clear');
  assert.deepEqual(fixture.activities, [{surface: 'email', typing: true, lastInputAtMs: 250, idleMs: 0}]);
  assert.deepEqual(fixture.scopes, [{sessionId: 'session-1', revisions: {order: 'order-r1', email: 'email-r1'}}]);
  assert.deepEqual(fixture.checkpoints[0]?.observationIds, ['order-observation', 'email-observation']);
  assert.equal('facts' in fixture.checkpoints[0]!, false);
  adapter.dispose();
});

test('pause aborts dispatch and reset scope rejects the stale preview', async () => {
  const fixture = harness();
  let dispatchSignal: AbortSignal | undefined;
  fixture.setDispatch((_checkpoint, options) => new Promise((_resolve, reject) => {
    dispatchSignal = options?.signal;
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
  }));
  const adapter = createCheckpointAdapter({runtime: {workspace: fixture.handle}});
  adapter.syncScope(scope());
  const controller = new AbortController();
  const pending = adapter.checkpoint.check(scope(), controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(dispatchSignal?.aborted, true);

  const reset = scope(2, 'email-r2');
  adapter.syncScope(reset);
  await assert.rejects(adapter.checkpoint.check(scope(), new AbortController().signal), /scope is stale/);
  fixture.setVisuals(visuals(reset.revisions));
  fixture.setDispatch(async checkpoint => ({schemaVersion: 1, checkpointId: checkpoint.id, status: 'clear', message: 'Reset checked.', evidenceIds: [], basedOn: checkpoint.revisions}));
  assert.equal((await adapter.checkpoint.check(reset, new AbortController().signal)).status, 'clear');
  adapter.dispose();
});

test('session ownership and disposal fail closed', async () => {
  const fixture = harness();
  const adapter = createCheckpointAdapter({bridgeInternalHandle: fixture.handle});
  fixture.setSession(null);
  assert.throws(() => adapter.syncScope(scope()), /session does not match/);
  assert.throws(() => adapter.onInputActivity({surface: 'email', typing: true, lastInputAtMs: 1, idleMs: 0}), /session is unavailable/);
  adapter.dispose();
  assert.throws(() => adapter.syncScope(scope()), /disposed/);
});
