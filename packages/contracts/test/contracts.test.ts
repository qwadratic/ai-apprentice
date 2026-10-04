import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenFixtures } from '../src/fixtures.ts';
import { assertCurrentCheckpoint, ContractValidationError, EvidenceUnavailableError, MockScreenBridge, ObservationGate, parseActionCheckpoint, parseCheckpointReply, parseScreenEvidence, parseScreenObservation, parseScreenStatus } from '../src/index.ts';
import type { ActionCheckpoint, CaptureToken, ScreenObservation, ScreenStatus } from '../src/index.ts';
const checkpoint: ActionCheckpoint = {schemaVersion: 1, id: 'check-1', sessionId: 'session', timestampMs: 3000, observationIds: ['order-1', 'email-1'], revisions: {order: 'order-r1', email: 'email-r1'}, action: 'send'};
function fixture() { return createScreenFixtures('session'); }
function fromToken(token: CaptureToken): ScreenObservation {
  return {...fixture().observations[0]!, source: 'vision', sessionId: token.sessionId, sequence: token.sequence, timestampMs: token.timestampMs, frameId: token.frameId, sourceRevision: token.sourceRevision};
}
test('all neutral facts and evidence validate and return independent copies', () => {
  const f = fixture();
  for (const o of f.observations) assert.deepEqual(parseScreenObservation(o), o);
  for (const e of f.evidence) assert.deepEqual(parseScreenEvidence(e), e);
  const parsed = parseScreenObservation(f.observations[0]); parsed.evidenceIds.length = 0;
  assert.equal(f.observations[0]!.evidenceIds.length, 1);
  assert.equal(parseScreenStatus({schemaVersion: 1, sessionId: 'session', state: 'paused'}).state, 'paused');
});
test('validators reject schema drift, invalid clock, wrong facts, inferred identity and global input', () => {
  const o = fixture().observations[0]!;
  for (const patch of [{schemaVersion: 2}, {sequence: 0}, {timestampMs: -1}, {timestampMs: NaN}, {kind: 'voice'}, {rationale: 'invented'}, {entityRef: null}, {facts: {customerRef: 'synthetic_customer_A'}}]) {
    assert.throws(() => parseScreenObservation({...o, ...patch}), ContractValidationError);
  }
  const input = fixture().observations[1]!;
  assert.throws(() => parseScreenObservation({...input, facts: {surface: 'global_keyboard', typing: true, idleMs: 0, lastInputAtMs: 2000}}), ContractValidationError);
  assert.throws(() => parseScreenObservation({...input, evidenceIds: ['invented']}), ContractValidationError);
  assert.throws(() => parseScreenObservation({...input, frameId: 'global-input'}), ContractValidationError);
  assert.throws(() => parseScreenObservation({...input, facts: {...input.facts, idleMs: 1}}), ContractValidationError);
  assert.throws(() => parseScreenEvidence({...fixture().evidence[0], endMs: 999}), ContractValidationError);
});
test('unknown entity remains null through mock replay', async () => {
  const bridge = new MockScreenBridge(10000); const events: ScreenObservation[] = [];
  bridge.onObservation((o) => events.push(o)); await bridge.start({sessionId: 'session', sessionEpochMs: 10000}); bridge.advanceTo(14000);
  const o = events.at(-1)!; assert.equal(o.entityRef, null);
  assert.equal(o.kind, 'order_view'); if (o.kind === 'order_view') assert.equal(o.facts.customerRef, null);
});
test('doc-7 provenance permits only workspace input and vision visual facts', () => {
  const [order, input, email] = fixture().observations;
  assert.equal(order?.source, 'vision'); assert.equal(email?.sourceRevision, 'email-r1');
  assert.equal(input?.source, 'workspace'); assert.equal(input?.frameId, null);
  assert.throws(() => parseScreenObservation({...order, source: 'workspace', frameId: null, sourceRevision: null}), /provenance/);
  assert.throws(() => parseScreenObservation({...email, frameId: null}), /provenance/);
  assert.throws(() => parseScreenObservation({...input, source: 'vision', frameId: 'frame-input'}), /provenance/);
});
test('mock ordering uses captured session time, not processing time', async () => {
  const bridge = new MockScreenBridge(10000); const events: ScreenObservation[] = [];
  bridge.onObservation((o) => events.push(o)); await bridge.start({sessionId: 'session', sessionEpochMs: 10000}); bridge.advanceTo(15000);
  assert.deepEqual(events.map((o) => o.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((o) => o.timestampMs), [1000, 2000, 3000, 4000, 5000]);
  assert.throws(() => bridge.advanceTo(14999), /backwards/);
});
test('pause drops due work, resume preserves epoch and sequence gaps, stop emits nothing', async () => {
  const bridge = new MockScreenBridge(10000); const events: ScreenObservation[] = []; const states: ScreenStatus['state'][] = [];
  bridge.onObservation((o) => events.push(o)); bridge.onStatus((s) => states.push(s.state));
  await bridge.start({sessionId: 'session', sessionEpochMs: 10000}); bridge.advanceTo(11000);
  await bridge.pause(); bridge.advanceTo(13000); assert.equal(events.length, 1);
  await bridge.resume(); bridge.advanceTo(14000);
  assert.deepEqual(events.map((o) => [o.sequence, o.timestampMs]), [[1, 1000], [4, 4000]]);
  await bridge.stop(); bridge.advanceTo(16000); assert.equal(events.length, 2);
  assert.deepEqual(states, ['capturing', 'paused', 'capturing', 'stopped']);
  await assert.rejects(bridge.resume(), /paused/);
});
test('pause from a subscriber invalidates the remainder of a replay batch', async () => {
  const bridge = new MockScreenBridge(); const events: ScreenObservation[] = [];
  bridge.onObservation((o) => { events.push(o); void bridge.pause(); });
  await bridge.start({sessionId: 'session', sessionEpochMs: 0}); bridge.advanceTo(5000);
  assert.equal(events.length, 1); await bridge.resume(); bridge.advanceTo(6000); assert.equal(events.length, 1);
});
test('pause confirms off-record only after the mock output gate closes', async () => {
  const bridge = new MockScreenBridge(); const statuses: ScreenStatus[] = [];
  bridge.onStatus((status) => statuses.push(status));
  await bridge.start({sessionId: 'session', sessionEpochMs: 0});
  await bridge.pause(); bridge.advanceTo(5000);
  assert.deepEqual(statuses.at(-1), {schemaVersion: 1, sessionId: 'session', state: 'paused', reason: 'off_record'});
});
test('evidence becomes resolvable on publication, survives stop and is reset with session', async () => {
  const bridge = new MockScreenBridge(); await bridge.start({sessionId: 'session', sessionEpochMs: 0});
  await assert.rejects(bridge.resolveEvidence('evidence-1'), EvidenceUnavailableError);
  bridge.advanceTo(1000); const e = await bridge.resolveEvidence('evidence-1');
  assert.deepEqual(e, {assetRef: 'mock://session/evidence-1', startMs: 1000, endMs: 1000});
  await bridge.stop(); assert.deepEqual(await bridge.resolveEvidence('evidence-1'), e);
  await bridge.start({sessionId: 'other', sessionEpochMs: 1000});
  await assert.rejects(bridge.resolveEvidence('evidence-1'), EvidenceUnavailableError);
  bridge.advanceTo(2000); assert.match((await bridge.resolveEvidence('evidence-1')).assetRef, /other/);
});
test('mock rejects an unordered fixture, foreign session and missing evidence', async () => {
  const invalid = [
    {...fixture(), observations: [...fixture().observations].reverse()},
    {...fixture(), observations: fixture().observations.map((o) => ({...o, sessionId: 'other'}))},
    {...fixture(), evidence: []},
  ];
  for (const f of invalid) await assert.rejects(new MockScreenBridge(0, () => f).start({sessionId: 'session', sessionEpochMs: 0}));
});
test('gate drops late vision output after pause/resume, stop and new session', () => {
  const gate = new ObservationGate(); gate.start({sessionId: 'session', sessionEpochMs: 10000});
  const beforePause = gate.capture(11000, 'frame-1'); gate.pause(); gate.resume();
  assert.equal(gate.publish(beforePause, fromToken(beforePause)), null);
  const resumed = gate.capture(13000, 'frame-3'); assert.equal(gate.publish(resumed, fromToken(resumed))!.timestampMs, 3000);
  const beforeStop = gate.capture(14000, 'frame-4'); gate.stop(); assert.equal(gate.publish(beforeStop, fromToken(beforeStop)), null);
  gate.start({sessionId: 'session', sessionEpochMs: 15000}); const old = gate.capture(16000, 'frame-old');
  gate.start({sessionId: 'other', sessionEpochMs: 16000}); assert.equal(gate.publish(old, fromToken(old)), null);
});
test('gate rejects backward clocks, forged/reused tokens and drops out of order results', () => {
  const gate = new ObservationGate(); gate.start({sessionId: 'session', sessionEpochMs: 10000});
  const first = gate.capture(11000, 'frame-1'); const second = gate.capture(12000, 'frame-2');
  assert.equal(gate.publish(second, fromToken(second))!.sequence, 2);
  assert.equal(gate.publish(first, fromToken(first)), null);
  assert.throws(() => gate.publish(second, fromToken(second)), /Unknown/);
  assert.throws(() => gate.publish({...second}, fromToken(second)), /Unknown/);
  assert.throws(() => gate.capture(11500, 'older'), /backwards/);
  gate.pause(); assert.throws(() => gate.capture(13000, 'paused'), /active/);
});
test('gate rejects observations that substitute processing time for capture time', () => {
  const gate = new ObservationGate(); gate.start({sessionId: 'session', sessionEpochMs: 10000});
  const token = gate.capture(11000, 'frame-1');
  assert.throws(() => gate.publish(token, {...fromToken(token), timestampMs: 2000}), /capture token/);
});
test('checkpoint requires current order and email preview before Send', () => {
  const observations = fixture().observations.slice(0, 3);
  assert.deepEqual(assertCurrentCheckpoint(checkpoint, 'session', observations), checkpoint);
  assert.throws(() => assertCurrentCheckpoint({...checkpoint, observationIds: ['email-1']}, 'session', observations), /stale/);
  assert.throws(() => assertCurrentCheckpoint(checkpoint, 'other', observations), /session/);
  assert.throws(() => assertCurrentCheckpoint({...checkpoint, timestampMs: 2999}, 'session', observations), /precedes/);
  assert.throws(() => assertCurrentCheckpoint({...checkpoint, revisions: {order: 'old', email: 'email-r1'}}, 'session', observations), /revision/);
  assert.throws(() => assertCurrentCheckpoint({...checkpoint, observationIds: [...checkpoint.observationIds, 'unseen']}, 'session', observations), /unknown/);
  assert.throws(() => parseActionCheckpoint({...checkpoint, observationIds: ['order-1', 'order-1']}), /duplicates/);
  const email = observations[2]!; assert.equal(email.kind, 'email_draft');
  if (email.kind === 'email_draft') {
    const changed = {...email, id: 'email-2', sequence: 4, timestampMs: 3500, sourceRevision: 'email-r2', facts: {...email.facts, previewState: 'editing' as const}};
    assert.throws(() => assertCurrentCheckpoint(checkpoint, 'session', [...observations, changed]), /preview/);
    assert.throws(() => assertCurrentCheckpoint(checkpoint, 'session', [...observations, {...changed, facts: {...changed.facts, previewState: 'preview'}}]), /stale/);
  }
});
test('check failures cannot be represented as a successful reply', () => {
  const reply = {schemaVersion: 1, checkpointId: 'check-1', status: 'unknown', message: 'Check unavailable', evidenceIds: [], basedOn: {order: 'order-r1', email: 'email-r1'}};
  assert.equal(parseCheckpointReply(reply).status, 'unknown');
  for (const patch of [{status: 'error'}, {status: 'ok'}, {message: ''}, {schemaVersion: 2}]) assert.throws(() => parseCheckpointReply({...reply, ...patch}), ContractValidationError);
});

test('gate enforces unique published IDs within a session and resets them on start', () => {
  const gate = new ObservationGate(); gate.start({sessionId: 'session', sessionEpochMs: 0});
  const first = gate.capture(1000, 'frame-1'); gate.publish(first, fromToken(first));
  const second = gate.capture(2000, 'frame-2');
  assert.throws(() => gate.publish(second, fromToken(second)), /Duplicate observation id/);
  gate.start({sessionId: 'other', sessionEpochMs: 2000});
  const next = gate.capture(3000, 'frame-3'); assert.equal(gate.publish(next, fromToken(next))!.id, 'order-1');
});
