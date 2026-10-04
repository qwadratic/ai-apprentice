import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentApi } from '../api.ts';
import { EventUploader, FLUSH_MS, MAX_BATCH_BYTES, MAX_BATCH_EVENTS, MAX_TEXT_CHARS, PAGEHIDE_BATCH_BYTES, eventBytes } from '../log/uploader.ts';
import type { RecordedRequest, Responder } from './helpers.ts';
import { FakeTimers, SIGNED_URL, TOKEN, json, legacyApi, modernApi, must, recordingFetch, settle } from './helpers.ts';

async function rig(...responders: Responder[]) {
  const timers = new FakeTimers();
  const { fetch, calls } = recordingFetch(...responders);
  const api = createAgentApi({ base: 'https://api.example.invalid', fetch, now: () => 1, newId: () => 'legacy-1' });
  const session = await api.createSession();
  const problems: string[] = [];
  const uploader = new EventUploader({ session, fetch, timers, now: () => 42, onProblem: (t) => problems.push(t) });
  const eventCalls = (): RecordedRequest[] => calls.filter((c) => c.url.endsWith('/events'));
  return { uploader, timers, calls, eventCalls, problems };
}

test('queued lines are posted every 2 s with the token and the conversation id', async () => {
  const r = await rig(modernApi());
  r.uploader.setConversationId('conv_1');
  r.uploader.enqueue('sys', 'SYS', 'hello');
  r.uploader.enqueue('sent', 'CONTEXT', 'ctx');
  assert.equal(r.eventCalls().length, 0);
  r.timers.advance(FLUSH_MS);
  await settle();
  assert.equal(r.eventCalls().length, 1);
  const call = must(r.eventCalls()[0]);
  assert.equal(call.headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(call.headers['content-type'], 'application/json');
  const body = call.body as { conversationId: string; events: Array<{ t: number; dir: string; type: string; text: string }> };
  assert.equal(body.conversationId, 'conv_1');
  assert.deepEqual(body.events.map((e) => [e.dir, e.type, e.text, e.t]), [['sys', 'SYS', 'hello', 42], ['sent', 'CONTEXT', 'ctx', 42]]);
  assert.equal(r.uploader.pending(), 0);
});

test('a legacy session posts without a token', async () => {
  const r = await rig(legacyApi());
  r.uploader.enqueue('sys', 'SYS', 'x');
  await r.uploader.flush();
  assert.equal(must(r.eventCalls()[0]).headers['authorization'], undefined);
  assert.equal(must(r.eventCalls()[0]).url, 'https://api.example.invalid/agent/sessions/legacy-1/events');
});

test('lines are scrubbed and long lines truncated before they are queued', async () => {
  const r = await rig(modernApi());
  r.uploader.enqueue('err', 'ERR', `failed ${SIGNED_URL}`);
  r.uploader.enqueue('sys', 'SYS', 'x'.repeat(MAX_TEXT_CHARS + 100));
  await r.uploader.flush();
  const body = must(r.eventCalls()[0]).body as { events: Array<{ text: string }> };
  assert.equal(body.events[0]?.text, 'failed [url removed]');
  assert.ok(must(body.events[1]).text.endsWith('...[truncated]'));
});

test('batches are limited to 200 lines', async () => {
  const r = await rig(modernApi());
  for (let i = 0; i < MAX_BATCH_EVENTS + 20; i += 1) r.uploader.enqueue('sys', 'SYS', `l${i}`);
  await r.uploader.flush();
  assert.deepEqual(r.eventCalls().map((c) => (c.body as { events: unknown[] }).events.length), [200, 20]);
});

const bodyBytes = (body: unknown): number => new TextEncoder().encode(JSON.stringify(body)).length;

test('batches are limited by UTF-8 bytes, not characters', async () => {
  const r = await rig(modernApi());
  // 2000 characters of a 3-byte character is 6000 bytes a line: 120 lines are 250 KB by characters but 720 KB by bytes.
  const text = '€'.repeat(2000);
  for (let i = 0; i < 120; i += 1) r.uploader.enqueue('recv', 'USER', text);
  await r.uploader.flush();
  const sizes = r.eventCalls().map((c) => bodyBytes(c.body));
  assert.ok(r.eventCalls().length >= 4, `split into several requests, got ${r.eventCalls().length}`);
  for (const size of sizes) assert.ok(size <= MAX_BATCH_BYTES + 200, `a request body of ${size} bytes is over the cap`);
  assert.ok(sizes.every((n) => n < 256 * 1024), 'every body is under the 256 KB server limit');
  const sent = r.eventCalls().reduce((n, c) => n + (c.body as { events: unknown[] }).events.length, 0);
  assert.equal(sent, 120, 'every line is still sent');
});

test('eventBytes counts JSON escapes and multi-byte characters', () => {
  const plain = eventBytes({ t: 1, dir: 'sys', type: 'SYS', text: 'abc' });
  assert.equal(eventBytes({ t: 1, dir: 'sys', type: 'SYS', text: '€€€' }), plain + 6);
  assert.equal(eventBytes({ t: 1, dir: 'sys', type: 'SYS', text: '"""' }), plain + 3);
});

test('page hide stays under the 64 KB keepalive limit', async () => {
  const r = await rig(modernApi());
  r.uploader.setConversationId('conv_1');
  for (let i = 0; i < 40; i += 1) r.uploader.enqueue('recv', 'USER', '€'.repeat(3000));
  r.uploader.sendOnPageHide();
  const hide = r.eventCalls();
  assert.equal(hide.length, 1);
  const size = bodyBytes(must(hide[0]).body);
  assert.ok(size < 64 * 1024, `body of ${size} bytes`);
  assert.ok(PAGEHIDE_BATCH_BYTES < 64 * 1024);
});

test('a transient failure keeps the lines and retries; it is reported once', async () => {
  let fail = true;
  const r = await rig((req) => (req.url.endsWith('/events') && fail ? json(500, {}) : null), modernApi());
  r.uploader.enqueue('sys', 'SYS', 'a');
  assert.equal(await r.uploader.flush(), false);
  assert.equal(await r.uploader.flush(), false);
  assert.equal(r.problems.length, 1);
  assert.equal(r.uploader.pending(), 1);
  fail = false;
  assert.equal(await r.uploader.flush(), true);
  assert.equal(r.uploader.pending(), 0);
});

test('a permanent refusal stops the upload for good', async () => {
  for (const status of [401, 403, 404, 413, 507]) {
    const r = await rig((req) => (req.url.endsWith('/events') ? json(status, {}) : null), modernApi());
    r.uploader.enqueue('sys', 'SYS', 'a');
    assert.equal(await r.uploader.flush(), false);
    assert.equal(r.uploader.hasGivenUp(), true, `status ${status}`);
    assert.match(must(r.problems[0]), new RegExp(`${status}`));
    const before = r.eventCalls().length;
    r.timers.advance(FLUSH_MS * 3);
    await settle();
    assert.equal(r.eventCalls().length, before, 'no retry after a permanent refusal');
  }
});

test('off the record: after stopRecording nothing more is queued, what was queued is still sent', async () => {
  const r = await rig(modernApi());
  r.uploader.enqueue('sys', 'SYS', 'Off the record: capture and upload stopped.');
  r.uploader.stopRecording();
  r.uploader.enqueue('recv', 'USER', 'this must not be uploaded');
  assert.equal(r.uploader.isRecording(), false);
  await r.uploader.flush();
  const lines = r.eventCalls().flatMap((c) => (c.body as { events: Array<{ text: string }> }).events.map((e) => e.text));
  assert.deepEqual(lines, ['Off the record: capture and upload stopped.']);
});

test('finish flushes, then asks the server to store the conversation', async () => {
  const r = await rig(modernApi());
  r.uploader.setConversationId('conv_9');
  r.uploader.enqueue('sys', 'SYS', 'bye');
  const result = await r.uploader.finish();
  assert.deepEqual(result, { kind: 'stored', transcriptStored: true });
  const order = r.calls.map((c) => c.url.split('/').pop());
  assert.deepEqual(order.slice(-2), ['events', 'finish']);
  assert.deepEqual(must(r.calls.at(-1)).body, { conversationId: 'conv_9' });
  assert.equal(must(r.calls.at(-1)).headers['authorization'], `Bearer ${TOKEN}`);
  assert.deepEqual(await r.uploader.finish(), { kind: 'no-conversation' }, 'finish is idempotent');
});

test('finish without a conversation sends no finish request; a failing finish reports unsent lines', async () => {
  const none = await rig(modernApi());
  none.uploader.enqueue('sys', 'SYS', 'x');
  assert.deepEqual(await none.uploader.finish(), { kind: 'no-conversation' });
  assert.equal(none.calls.some((c) => c.url.endsWith('/finish')), false);

  const bad = await rig((req) => (req.url.endsWith('/finish') ? json(502, {}) : null), modernApi());
  bad.uploader.setConversationId('conv_1');
  const result = await bad.uploader.finish();
  assert.equal(result.kind, 'failed');
});
