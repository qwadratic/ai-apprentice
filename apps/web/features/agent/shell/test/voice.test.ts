import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenObservation } from '@apprentice/contracts';
import { askMessage, observationToContext, summarizeObservation } from '../voice/context.ts';
import { scrub } from '../voice/scrub.ts';
import { VoiceSession } from '../voice/voice-session.ts';
import type { VoiceEvents } from '../voice/types.ts';
import { FakeVoice, SIGNED_URL, TOKEN, must } from './helpers.ts';

const noEvents = (): VoiceEvents => ({
  onConnect() {}, onDisconnect() {}, onStatus() {}, onMode() {}, onMessage() {}, onError() {},
});

const base = { schemaVersion: 1 as const, sessionId: 's', sequence: 1, timestampMs: 100, source: 'vision' as const, frameId: 'f', sourceRevision: 'r', evidenceIds: ['e'] };
const order: ScreenObservation = { ...base, id: 'o1', kind: 'order_view', entityRef: 'customer_07', facts: { customerRef: 'customer_07', orderId: 'ORD-1', deliveryAddress: '14 Sample Lane', deliveryWindow: '14:00-16:00' } };
const email: ScreenObservation = {
  ...base, id: 'e1', kind: 'email_draft', entityRef: 'customer_07',
  facts: { recipientRef: 'customer_07', subject: 's', bodyText: '14 Sample Lane', attachments: [{ kind: 'image' }], previewState: 'editing' },
};

test('askMessage prefixes [ASK], keeps the text verbatim and adds no audio tags', () => {
  assert.equal(askMessage('Why did you type the address?'), '[ASK] Why did you type the address?');
  assert.equal(askMessage('  Why\n  now? '), '[ASK] Why now?');
  assert.equal(askMessage('[ASK] Already prefixed?'), '[ASK] Already prefixed?');
  assert.ok(!/\[(curious|warmly|thoughtful|matter-of-fact)\]/.test(askMessage('Any limit?')));
  assert.ok(askMessage('x'.repeat(1000)).length <= 406);
});

test('observationToContext: one sentence per kind, no heartbeats', () => {
  assert.match(must(observationToContext(order)), /^\[screen\] Order ORD-1 for customer_07 is open\./);
  assert.match(must(observationToContext(email)), /1 attachment \(image\); the body has 14 characters of text\./);
  const heartbeat: ScreenObservation = {
    ...base, id: 'h', kind: 'input_activity', source: 'workspace', frameId: null, sourceRevision: null, entityRef: null, evidenceIds: [],
    facts: { surface: 'email', typing: true, idleMs: 0, lastInputAtMs: 100 },
  };
  assert.equal(observationToContext(heartbeat), null);
  const unknown: ScreenObservation = { ...order, entityRef: null, facts: { customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null } };
  assert.match(must(observationToContext(unknown)), /unknown for an unknown customer/);
  assert.match(summarizeObservation(email), /Email to customer_07 · editing/);
});

test('scrub removes signed URLs, keys and bearer tokens', () => {
  assert.equal(scrub(`connect ${SIGNED_URL} now`), 'connect [url removed] now');
  assert.equal(scrub('xi-api-key: abc'), '[key removed]');
  assert.equal(scrub('key sk_0123456789abcdefghij'), 'key [key removed]');
  assert.ok(!scrub(`Authorization: Bearer ${TOKEN}`).includes(TOKEN));
});

test('VoiceSession sends context and [ASK] only while connected', async () => {
  const fake = new FakeVoice();
  fake.autoConnect = false;
  const session = new VoiceSession(fake.connector);
  assert.equal(session.ask('Too early?'), null);
  await session.start(SIGNED_URL, noEvents());
  assert.equal(fake.url, SIGNED_URL);
  assert.equal(session.sendContext('[screen] x'), false, 'not connected yet');
  must(fake.events).onConnect('conv_1');
  assert.equal(session.isConnected(), true);
  assert.equal(session.sendContext('[screen] x'), true);
  assert.equal(session.ask('Why for this client?'), '[ASK] Why for this client?');
  assert.deepEqual(fake.contexts, ['[screen] x']);
  assert.deepEqual(fake.userMessages, ['[ASK] Why for this client?']);
  assert.equal(session.conversationId(), 'conv_test_1');
});

test('VoiceSession.end closes the conversation once and refuses later sends', async () => {
  const fake = new FakeVoice();
  const session = new VoiceSession(fake.connector);
  await session.start(SIGNED_URL, noEvents());
  await session.end();
  await session.end();
  assert.equal(fake.ended, true);
  assert.equal(fake.order.filter((o) => o === 'voice.end').length, 1);
  assert.equal(session.isConnected(), false);
  assert.equal(session.ask('late'), null);
  await assert.rejects(() => session.start(SIGNED_URL, noEvents()), /already used/);
});

test('VoiceSession.end does not wait forever for a stuck conversation', async () => {
  const stuck = new VoiceSession(async () => ({
    conversationId: () => 'c', sendContextualUpdate() {}, sendUserMessage() {}, end: () => new Promise<void>(() => {}),
  }));
  await stuck.start(SIGNED_URL, noEvents());
  const started = Date.now();
  await stuck.end(30);
  assert.ok(Date.now() - started < 1000);
});

test('ending while the connection is still being made aborts the connector and closes it as soon as it opens', async () => {
  const fake = new FakeVoice();
  let release: () => void = () => {};
  fake.gate = new Promise<void>((resolve) => { release = resolve; });
  const session = new VoiceSession(fake.connector);
  const starting = session.start(SIGNED_URL, noEvents());
  assert.equal(must(fake.signal).aborted, false);
  await session.end();
  assert.equal(must(fake.signal).aborted, true, 'the connector is told to abort');
  assert.equal(fake.ended, false, 'nothing to close before the handshake finishes');
  release();
  await starting;
  assert.equal(fake.ended, true, 'the conversation is closed the moment it exists');
  assert.equal(session.isConnected(), false);
  assert.equal(session.isOpening(), false);
});

test('the SDK fires its connected events before it returns: the session is not writable until it has the handle', async () => {
  const fake = new FakeVoice();
  let connectedEvents = 0;
  let writableInsideEvent: boolean | null = null;
  const session = new VoiceSession(fake.connector);
  await session.start(SIGNED_URL, {
    ...noEvents(),
    onStatus: (s) => { if (s === 'connected') connectedEvents += 1; },
    onConnect: () => { writableInsideEvent = session.isConnected(); },
  });
  assert.equal(connectedEvents, 1);
  assert.equal(writableInsideEvent, false, 'inside the connected event there is no handle yet');
  assert.equal(session.isConnected(), true, 'after start() it is writable');
  assert.equal(session.isOpening(), false);
});

test('isOpening is true while connecting and false once ended', async () => {
  const fake = new FakeVoice();
  fake.autoConnect = false;
  const session = new VoiceSession(fake.connector);
  assert.equal(session.isOpening(), true);
  await session.start(SIGNED_URL, noEvents());
  assert.equal(session.isOpening(), true, 'handle set but not connected yet');
  must(fake.events).onConnect('c');
  assert.equal(session.isOpening(), false);
  await session.end();
  assert.equal(session.isOpening(), false);
});

test('a failing connector rejects start without leaking the URL', async () => {
  const fake = new FakeVoice();
  fake.failWith = 'Microphone permission denied';
  const session = new VoiceSession(fake.connector);
  await assert.rejects(() => session.start(SIGNED_URL, noEvents()), (e: unknown) => e instanceof Error && !e.message.includes('wss://'));
});
