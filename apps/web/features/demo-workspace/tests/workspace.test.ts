import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, type CheckpointPort, type CheckOutcome } from '../workspace.ts';
import { demoCases } from '../cases.ts';
import { createMockCheckpoint } from '../mock.ts';

const clear: CheckOutcome = { status: 'clear', message: 'Checked.', evidenceIds: ['evidence-1'] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function controlled() {
  const replies: ReturnType<typeof deferred<CheckOutcome>>[] = [];
  const signals: AbortSignal[] = [];
  const scopes: unknown[] = [];
  const port: CheckpointPort = {
    check(scope, signal, onDispatch) {
      scopes.push(structuredClone(scope)); signals.push(signal);
      onDispatch?.();
      const reply = deferred<CheckOutcome>(); replies.push(reply); return reply.promise;
    },
  };
  return { port, replies, signals, scopes };
}
function make(port?: CheckpointPort, timeoutMs = 500) { return createWorkspace({ sessionId: 'session-1', checkpoint: port, timeoutMs, now: () => 1234 }); }

test('manual local send, immutable sent snapshot and editable ticket', async () => {
  const model = make(createMockCheckpoint('clear', 0));
  assert.equal(model.send(), false);
  await model.preview();
  assert.equal(model.getState().sent, null);
  assert.equal(model.send(), true);
  assert.equal(model.send(), false);
  assert.equal(model.getState().sent?.sentAtMs, 1234);
  assert.equal(model.editDraft({ body: 'Changed after send' }), false);
  assert.equal(model.editOrder({ customerRef: 'customer_12' }), false);
  model.editTicket('Delivery email completed in the demo.');
  assert.equal(model.resolveTicket(), true);
  assert.equal(model.getState().ticket.status, 'resolved');
  model.reset(); assert.equal(model.getState().sent, null); assert.equal(model.getState().ticket.summary, '');
  model.dispose();
});

for (const status of ['warn', 'unknown'] as const) {
  test(`${status} requires a separate human acknowledgement; edits clear it`, async () => {
    const model = make(createMockCheckpoint(status, 0));
    await model.preview(); assert.equal(model.getState().check.status, status); assert.equal(model.send(), false);
    model.acknowledgeRisk(true); assert.equal(model.canSend(), true);
    model.editDraft({ body: 'Edited.' }); assert.equal(model.canSend(), false); assert.equal(model.getState().acknowledged, false);
    await model.preview(); model.acknowledgeRisk(true); assert.equal(model.send(), true); model.dispose();
  });
}

test('pending rejects double Preview and double Send without losing the original request', async () => {
  const fixture = controlled(); const model = make(fixture.port);
  const first = model.preview(); await tick(); await model.preview();
  assert.equal(fixture.replies.length, 1); assert.equal(model.getState().check.status, 'pending');
  assert.equal(model.send(), false); assert.equal(model.send(), false);
  fixture.replies[0]!.resolve(clear); await first;
  assert.equal(typeof (fixture.scopes[0]! as {revisions: {order: string}}).revisions.order, 'string');
  assert.equal(model.canSend(), true); model.dispose();
});

for (const [name, change] of [
  ['body', model => model.editDraft({ body: 'New text' })],
  ['subject', model => model.editDraft({ subject: 'New subject' })],
  ['recipient', model => model.editDraft({ customerRef: 'customer_12' })],
  ['attachments', model => model.editDraft({ attachments: [] })],
  ['order', model => model.editOrder({ deliveryWindow: 'Tomorrow' })],
  ['order customer', model => model.editOrder({ customerRef: null })],
  ['session', model => model.setSession('session-2')],
  ['reset', model => model.reset()],
  ['new case', model => model.reset('other')],
  ['agent disconnected', model => model.setCheckpoint(undefined)],
  ['off record', model => model.setOffRecord(true)],
] as [string, (model: ReturnType<typeof make>) => unknown][]) {
  test(`${name} invalidates a pending result, even if the adapter ignores abort`, async () => {
    const fixture = controlled(); const model = make(fixture.port);
    const old = model.preview(); await tick(); change(model); await old;
    assert.equal(fixture.signals[0]!.aborted, true);
    fixture.replies[0]!.resolve(clear); await tick();
    assert.equal(model.getState().check.status, 'idle'); assert.equal(model.canSend(), false); model.dispose();
  });
}

test('an old response cannot replace a newer warning', async () => {
  const fixture = controlled(); const model = make(fixture.port);
  const old = model.preview(); await tick(); model.editDraft({ body: 'New draft' }); await old;
  const current = model.preview(); await tick();
  fixture.replies[1]!.resolve({ status: 'warn', message: 'Current warning', evidenceIds: [] }); await current;
  fixture.replies[0]!.resolve(clear); await tick();
  assert.equal(model.getState().check.status, 'warn'); assert.equal(model.canSend(), false); model.dispose();
});

test('edits invalidate a completed clear result and its acknowledgement', async () => {
  const model = make(createMockCheckpoint('clear', 0));
  for (const edit of [() => model.editDraft({ body: 'Body' }), () => model.editDraft({ attachments: [] }), () => model.editDraft({ customerRef: null })]) {
    await model.preview(); assert.equal(model.canSend(), true); edit(); assert.equal(model.canSend(), false);
  }
  model.dispose();
});

test('timeout aborts stalled work; its late response cannot authorize sending', async () => {
  const fixture = controlled(); const model = make(fixture.port, 15);
  await model.preview(); assert.equal(model.getState().check.status, 'error'); assert.equal(fixture.signals[0]!.aborted, true);
  fixture.replies[0]!.resolve(clear); await tick(); assert.equal(model.canSend(), false); model.dispose();
});

test('evidence acquisition may exceed four seconds without consuming the separate reply deadline', async () => {
  let dispatched = false;
  const model = createWorkspace({
    sessionId: 'session-1', acquisitionTimeoutMs: 5_000, replyTimeoutMs: 15, now: () => 1234,
    checkpoint: {
      async check(_scope, signal, onDispatch) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 4_100);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, {once: true});
        });
        onDispatch?.(); dispatched = true;
        return clear;
      },
    },
  });
  const preview = model.preview();
  assert.equal(model.getState().check.status, 'acquiring');
  await preview;
  assert.equal(dispatched, true);
  assert.equal(model.getState().check.status, 'clear');
  model.dispose();
});

test('no agent, rejected response and malformed response are technical errors', async () => {
  const model = make(); await model.preview(); assert.equal(model.getState().check.status, 'error'); assert.equal(model.send(), false);
  model.setCheckpoint(createMockCheckpoint('error', 0)); await model.preview(); assert.equal(model.getState().check.status, 'error');
  model.setCheckpoint({ async check() { return { status: 'clear' } as CheckOutcome; } });
  await model.preview(); assert.equal(model.getState().check.status, 'error'); assert.equal(model.send(), false); model.dispose();
});

test('opaque order and email revisions change only with their visible surfaces', async () => {
  let revision = 0;
  const model = createWorkspace({ sessionId: 'session-1', checkpoint: createMockCheckpoint('clear', 0), createRevision: () => `r-${++revision}` });
  const initial = model.getState().scope.revisions;
  model.editDraft({ body: 'Changed body' });
  const draft = model.getState().scope.revisions;
  assert.equal(draft.order, initial.order); assert.notEqual(draft.email, initial.email);
  model.editOrder({ deliveryWindow: 'Changed window' });
  const order = model.getState().scope.revisions;
  assert.notEqual(order.order, draft.order); assert.equal(order.email, draft.email);
  await model.preview();
  const preview = model.getState().scope.revisions;
  assert.equal(preview.order, order.order); assert.notEqual(preview.email, order.email);
  assert.equal(model.send(), true); assert.notEqual(model.getState().scope.revisions.email, preview.email);
  model.reset();
  assert.notEqual(model.getState().scope.revisions.order, preview.order);
  model.dispose();
});

test('reset does not emit input activity; snapshots cannot mutate the workspace', () => {
  let heartbeats = 0;
  const model = createWorkspace({ sessionId: 'session-1', onInputActivity() { heartbeats++; } });
  model.inputActivity(); model.inputActivity(); model.reset('spare');
  assert.equal(heartbeats, 1);
  const snapshot = model.getState(); snapshot.draft.body = 'External mutation';
  assert.notEqual(model.getState().draft.body, snapshot.draft.body); model.dispose();
});

test('synthetic cases vary visible data without a hidden rule or oracle', () => {
  const practice = demoCases.find(item => item.id === 'practice')!;
  const image = demoCases.find(item => item.id === 'new-image')!;
  const text = demoCases.find(item => item.id === 'new-text-image')!;
  assert.notEqual(practice.order.id, image.order.id); assert.notEqual(practice.order.deliveryAddress, image.order.deliveryAddress);
  assert.equal(image.order.customerRef, 'customer_07'); assert.equal(image.draft.body.includes(image.order.deliveryAddress), false);
  assert.ok(text.draft.body.includes(text.order.deliveryAddress)); assert.ok(text.draft.body.includes(text.order.deliveryWindow));
  assert.equal(demoCases.find(item => item.id === 'unknown')!.draft.customerRef, null);
  assert.equal(demoCases.find(item => item.id === 'spare')!.draft.customerRef, 'customer_12');
  const spare = demoCases.find(item => item.id === 'spare')!;
  const spareNew = demoCases.find(item => item.id === 'spare-new')!;
  assert.equal(spareNew.draft.customerRef, 'customer_12');
  assert.notEqual(spare.order.id, spareNew.order.id);
  assert.notEqual(spare.order.deliveryAddress, spareNew.order.deliveryAddress);
  assert.notEqual(spare.order.deliveryWindow, spareNew.order.deliveryWindow);
  for (const item of demoCases) {
    assert.deepEqual(Object.keys(item).sort(), ['draft', 'id', 'label', 'order']);
    const attachment = item.draft.attachments[0];
    assert.ok(attachment);
    const encodedArtwork = attachment.imageUrl.split(',')[1];
    assert.ok(encodedArtwork);
    const artwork = decodeURIComponent(encodedArtwork);
    assert.ok(artwork.includes(item.order.deliveryAddress)); assert.ok(artwork.includes(item.order.deliveryWindow));
  }
});

test('Learn source details match the B fixture revision 30865d6', () => {
  const practice = demoCases.find(item => item.id === 'practice')!;
  assert.equal(practice.order.id, 'ORD-2041');
  assert.equal(practice.order.customerRef, 'customer_07');
  assert.equal(practice.order.deliveryAddress, '14 Sample Lane, 1010 Exampletown');
  assert.equal(practice.order.deliveryWindow, '2026-10-12 14:00-16:00');
  assert.equal(demoCases.find(item => item.id === 'new-image')!.order.id, 'ORD-2057');
});

test('disposal aborts the pending check and prevents late subscriptions or sends', async () => {
  const fixture = controlled(); const model = make(fixture.port);
  const pending = model.preview(); await tick(); model.dispose(); await pending;
  fixture.replies[0]!.resolve(clear); await tick(); assert.equal(model.canSend(), false);
  assert.throws(() => model.send(), /disposed/); assert.throws(() => model.subscribe(() => {}), /disposed/);
});
