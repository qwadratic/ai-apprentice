import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenFixtures } from '../src/fixtures.ts';
import { ContractValidationError, MockScreenBridge, parseActionCheckpoint, parseCheckpointReply, parseScreenObservation } from '../src/index.ts';
import type { CheckpointReply, ScreenObservation } from '../src/index.ts';

test('doc-7 facts preserve unknown order fields and use ticket summary', () => {
  const unknown = createScreenFixtures('session').observations[3]!;
  assert.equal(unknown.kind, 'order_view');
  if (unknown.kind === 'order_view') {
    assert.deepEqual(unknown.facts, {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null});
  }
  const ticket = createScreenFixtures('session').observations[4]!;
  assert.equal(ticket.kind, 'ticket');
  if (ticket.kind === 'ticket') assert.equal(ticket.facts.summary, 'Customer identity not visible.');
  assert.throws(() => parseScreenObservation({...ticket, facts: {...ticket.facts, note: 'obsolete'}}), ContractValidationError);
});

test('doc-7 input activity uses the same session-relative idle clock', () => {
  const input = createScreenFixtures('session').observations[1]!;
  assert.equal(input.kind, 'input_activity');
  if (input.kind === 'input_activity') {
    assert.equal(input.timestampMs - input.facts.lastInputAtMs, input.facts.idleMs);
    const idle: ScreenObservation = {...input, id: 'input-idle', sequence: 3, timestampMs: 4000, facts: {...input.facts, typing: false, idleMs: 2000}};
    assert.deepEqual(parseScreenObservation(idle), idle);
    assert.throws(() => parseScreenObservation({...idle, facts: {...idle.facts, idleMs: 0}}), /lastInputAtMs/);
  }
});

test('checkpoint wire shape contains opaque revisions and forbids DOM facts', () => {
  const checkpoint = {schemaVersion: 1, id: 'cp-1', sessionId: 'session', timestampMs: 3000, observationIds: ['order-1', 'email-1'], revisions: {order: 'order-r1', email: 'email-r1'}, action: 'send'};
  assert.deepEqual(parseActionCheckpoint(checkpoint), checkpoint);
  assert.throws(() => parseActionCheckpoint({...checkpoint, facts: {order: {}, email: {}}}), /unexpected field facts/);
  const reply = {schemaVersion: 1, checkpointId: 'cp-1', status: 'clear', message: 'Synthetic result', evidenceIds: [], basedOn: checkpoint.revisions};
  assert.deepEqual(parseCheckpointReply(reply), reply);
  assert.throws(() => parseCheckpointReply({...reply, basedOn: {order: '', email: 'email-r1'}}), /basedOn/);
});

test('mock correlates basedOn and invalidates replies after a revision change', async () => {
  const bridge = new MockScreenBridge();
  await bridge.start({sessionId: 'session', sessionEpochMs: 0});
  bridge.advanceTo(3000);
  const checkpoint = bridge.raiseCheckpoint();
  assert.deepEqual(checkpoint.revisions, {order: 'order-r1', email: 'email-r1'});
  const reply: CheckpointReply = {schemaVersion: 1, checkpointId: checkpoint.id, status: 'clear', message: 'Synthetic result', evidenceIds: [], basedOn: checkpoint.revisions};
  await assert.rejects(bridge.replyToCheckpoint({...reply, basedOn: {...reply.basedOn, email: 'email-r0'}}), /revision mismatch/);
  await bridge.replyToCheckpoint(reply);
  assert.equal(bridge.replies.length, 1);

  const next = bridge.raiseCheckpoint();
  bridge.advanceTo(4000);
  await assert.rejects(bridge.replyToCheckpoint({...reply, checkpointId: next.id}), /tracked source revisions|stale/);
});
