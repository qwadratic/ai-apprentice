import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionCheckpoint, CheckpointReply, ScreenObservation } from '@apprentice/contracts';
import { createScreenBridgeCheckpointAdapter, type CanonicalContractRuntime } from '../screenBridgeAdapter.ts';
import { createWorkspace, type VersionScope } from '../workspace.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function observationSnapshot(scope: VersionScope, emailSequence = 2): ScreenObservation[] {
  return [
    { schemaVersion: 1, id: `order-${scope.revisions.order}`, sessionId: scope.sessionId, sequence: 1, timestampMs: 100,
      source: 'vision', frameId: 'frame-order', sourceRevision: scope.revisions.order, kind: 'order_view',
      facts: { customerRef: 'customer_07', orderId: 'ORD-2057', deliveryAddress: 'Synthetic address', deliveryWindow: 'Synthetic window' },
      entityRef: 'customer_07', evidenceIds: ['evidence-order'] },
    { schemaVersion: 1, id: `email-${scope.revisions.email}-${emailSequence}`, sessionId: scope.sessionId, sequence: emailSequence, timestampMs: 200,
      source: 'vision', frameId: 'frame-email', sourceRevision: scope.revisions.email, kind: 'email_draft',
      facts: { recipientRef: 'contact_customer_07', subject: 'Delivery', bodyText: 'Visible text', attachments: [], previewState: 'preview' },
      entityRef: 'customer_07', evidenceIds: ['evidence-email'] },
  ];
}

const contract: CanonicalContractRuntime = {
  parseScreenObservation(value: unknown) { return structuredClone(value) as ScreenObservation; },
  parseCheckpointReply(value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint reply.');
    return structuredClone(value) as CheckpointReply;
  },
  assertCurrentCheckpoint(value: unknown, sessionId: string, observations: readonly ScreenObservation[]) {
    const checkpoint = value as ActionCheckpoint;
    if (checkpoint.sessionId !== sessionId) throw new Error('Invalid checkpoint session.');
    const order = observations.filter((item): item is Extract<ScreenObservation, {kind: 'order_view'}> => item.kind === 'order_view').at(-1);
    const email = observations.filter((item): item is Extract<ScreenObservation, {kind: 'email_draft'}> => item.kind === 'email_draft').at(-1);
    if (!order || !email || email.facts.previewState !== 'preview') throw new Error('Preview observation required.');
    if (!checkpoint.observationIds.includes(order.id) || !checkpoint.observationIds.includes(email.id)) throw new Error('Stale observations.');
    if (checkpoint.revisions.order !== order.sourceRevision || checkpoint.revisions.email !== email.sourceRevision) throw new Error('Revision mismatch.');
    if (checkpoint.timestampMs < Math.max(order.timestampMs, email.timestampMs)) throw new Error('Checkpoint clock is stale.');
    return structuredClone(checkpoint);
  },
};

function harness(replyPatch: Record<string, unknown> = {}) {
  let current: ReturnType<typeof observationSnapshot> = [];
  const checkpoints: ActionCheckpoint[] = [];
  const registry = {
    async waitForCurrent({ sessionId, revisions, signal }: {sessionId: string; revisions: VersionScope['revisions']; signal: AbortSignal}) {
      signal.throwIfAborted();
      current = observationSnapshot({sessionId, revisions, taskGeneration: 0, draftRevision: 0});
      return structuredClone(current);
    },
    snapshot() { return structuredClone(current); },
  };
  const adapter = createScreenBridgeCheckpointAdapter({
    registry,
    contract,
    getSessionEpochMs: sessionId => sessionId === 'session-1' ? 1_000 : undefined,
    nowEpochMs: () => 1_500,
    createCheckpointId: () => 'checkpoint-1',
    async handleCheckpoint(checkpoint) {
      checkpoints.push(structuredClone(checkpoint));
      return {
        schemaVersion: 1, checkpointId: checkpoint.id, status: 'clear', message: 'Checked current pixels.', evidenceIds: ['evidence-email'],
        basedOn: structuredClone(checkpoint.revisions), ...replyPatch,
      } as unknown as CheckpointReply;
    },
  });
  return { adapter, registry, checkpoints, getCurrent: () => current, setCurrent: (value: typeof current) => { current = value; } };
}

test('canonical adapter sends only ids and opaque revisions, then authorizes manual Send', async () => {
  const fixture = harness();
  let revision = 0;
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: fixture.adapter, createRevision: () => `opaque-${++revision}` });
  await workspace.preview();
  assert.equal(workspace.getState().check.status, 'clear'); assert.equal(workspace.canSend(), true);
  assert.deepEqual(Object.keys(fixture.checkpoints[0]!).sort(), ['action', 'id', 'observationIds', 'revisions', 'schemaVersion', 'sessionId', 'timestampMs']);
  assert.deepEqual(fixture.checkpoints[0]!.observationIds, ['order-opaque-1', 'email-opaque-3-2']);
  assert.equal('facts' in fixture.checkpoints[0]!, false);
  assert.equal(workspace.getState().sent, null); assert.equal(workspace.send(), true);
  workspace.dispose();
});

for (const [name, replyPatch, expected] of [
  ['wrong checkpoint id', { checkpointId: 'checkpoint-old' }, /another checkpoint/],
  ['stale order basedOn', { basedOn: { order: 'old-order', email: 'opaque-3' } }, /stale workspace revisions/],
  ['stale email basedOn', { basedOn: { order: 'opaque-1', email: 'old-email' } }, /stale workspace revisions/],
] as const) {
  test(`${name} is explicitly failed and cannot authorize Send`, async () => {
    const fixture = harness(replyPatch);
    const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: fixture.adapter, createRevision: (() => { let id = 0; return () => `opaque-${++id}`; })() });
    await workspace.preview();
    assert.equal(workspace.getState().check.status, 'error'); assert.match((workspace.getState().check as {message: string}).message, expected);
    assert.equal(workspace.canSend(), false); workspace.dispose();
  });
}

test('vision revision mismatch fails before checkpoint dispatch', async () => {
  let dispatched = 0;
  const adapter = createScreenBridgeCheckpointAdapter({
    contract, getSessionEpochMs: () => 0, nowEpochMs: () => 500,
    registry: {
      async waitForCurrent({ sessionId, revisions }) {
        return observationSnapshot({ sessionId, revisions: {...revisions, email: 'old-email'}, taskGeneration: 0, draftRevision: 0 });
      },
      snapshot() { return []; },
    },
    async handleCheckpoint() { dispatched++; throw new Error('must not dispatch'); },
  });
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: adapter });
  await workspace.preview(); assert.equal(dispatched, 0); assert.equal(workspace.getState().check.status, 'error'); assert.equal(workspace.canSend(), false);
  workspace.dispose();
});

test('reordered registry snapshot is rejected before checkpoint dispatch', async () => {
  let dispatched = 0;
  const adapter = createScreenBridgeCheckpointAdapter({
    contract, getSessionEpochMs: () => 0, nowEpochMs: () => 500,
    registry: {
      async waitForCurrent({ sessionId, revisions }) { return observationSnapshot({ sessionId, revisions, taskGeneration: 0, draftRevision: 0 }).reverse(); },
      snapshot() { return []; },
    },
    async handleCheckpoint() { dispatched++; throw new Error('must not dispatch'); },
  });
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: adapter });
  await workspace.preview(); assert.equal(dispatched, 0); assert.match((workspace.getState().check as {message: string}).message, /reordered/);
  workspace.dispose();
});

test('a newer email observation published while the agent checks invalidates its reply', async () => {
  let current: ReturnType<typeof observationSnapshot> = [];
  const response = deferred<Record<string, unknown>>();
  const adapter = createScreenBridgeCheckpointAdapter({
    contract, getSessionEpochMs: () => 1_000, nowEpochMs: () => 1_500, createCheckpointId: () => 'checkpoint-1',
    registry: {
      async waitForCurrent({ sessionId, revisions }) { current = observationSnapshot({ sessionId, revisions, taskGeneration: 0, draftRevision: 0 }); return structuredClone(current); },
      snapshot() { return structuredClone(current); },
    },
    async handleCheckpoint(checkpoint) { return await response.promise as never; },
  });
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: adapter, createRevision: (() => { let id = 0; return () => `opaque-${++id}`; })() });
  const pending = workspace.preview(); await tick();
  const email = current[1]!;
  current.push({ ...structuredClone(email), id: 'newer-email', sequence: 3, timestampMs: 300 });
  response.resolve({ schemaVersion: 1, checkpointId: 'checkpoint-1', status: 'clear', message: 'Old result', evidenceIds: [], basedOn: {order: 'opaque-1', email: 'opaque-3'} });
  await pending;
  assert.equal(workspace.getState().check.status, 'error'); assert.equal(workspace.canSend(), false); workspace.dispose();
});

test('editing during a pending canonical check aborts it and a late reply stays irrelevant', async () => {
  const reply = deferred<Record<string, unknown>>();
  let checkpoint: {id: string; revisions: {order: string; email: string}} | undefined;
  const fixture = harness();
  const adapter = createScreenBridgeCheckpointAdapter({
    contract, registry: fixture.registry, getSessionEpochMs: () => 1_000, nowEpochMs: () => 1_500,
    async handleCheckpoint(value) { checkpoint = value; return await reply.promise as never; },
  });
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: adapter });
  const pending = workspace.preview(); await tick(); workspace.editDraft({ body: 'Edited after Preview' }); await pending;
  reply.resolve({ schemaVersion: 1, checkpointId: checkpoint!.id, status: 'clear', message: 'Late result', evidenceIds: [], basedOn: checkpoint!.revisions });
  await tick(); assert.equal(workspace.getState().check.status, 'idle'); assert.equal(workspace.canSend(), false); workspace.dispose();
});

test('unknown remains visibly unverified and needs a human acknowledgement', async () => {
  const fixture = harness({ status: 'unknown', message: 'Unable to verify current evidence.' });
  const workspace = createWorkspace({ sessionId: 'session-1', checkpoint: fixture.adapter });
  await workspace.preview(); assert.equal(workspace.getState().check.status, 'unknown'); assert.equal(workspace.canSend(), false);
  workspace.acknowledgeRisk(true); assert.equal(workspace.canSend(), true); workspace.dispose();
});
