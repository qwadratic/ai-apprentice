// The conductor client: SSE parsing, the cue stream (auth header, replay after reconnect, refusal) and event batching.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATCH_MS, ConductorClient, RECONNECT_MIN_MS, RETRY_MIN_MS } from '../conductor/client.ts';
import type { ConductorStatus } from '../conductor/client.ts';
import { parseCueEnvelope, sanitizeEvent } from '../conductor/protocol.ts';
import type { CueEnvelope } from '../conductor/protocol.ts';
import { SseParser } from '../conductor/sse.ts';
import type { SseMessage } from '../conductor/sse.ts';
import { readJoinParams, withoutJoinParams } from '../conductor/join.ts';
import { conductorFetch, cue, sseCue, sseHello } from './conductor-fakes.ts';
import { FakeTimers, settle } from './helpers.ts';

const TOKEN = 'tok_secret_0123456789';
const AUTH = `Bearer ${TOKEN}`;

function makeClient(fetch: (url: string, init?: RequestInit) => Promise<Response>, timers: FakeTimers) {
  const cues: CueEnvelope[] = [];
  const statuses: ConductorStatus[] = [];
  const hellos: Array<{ lastCueSeq: number; first: boolean; reset: boolean }> = [];
  const logs: string[] = [];
  const client = new ConductorClient({
    base: 'https://api.example.invalid', sessionId: 'sess-1', authorization: () => AUTH, fetch, timers,
    clock: () => timers.now, onCue: (c) => cues.push(c), onHello: (h, first, reset) => hellos.push({ lastCueSeq: h.lastCueSeq, first, reset }),
    onStatus: (s) => statuses.push(s), log: (l) => logs.push(l),
  });
  return { client, cues, statuses, hellos, logs };
}

test('the SSE parser joins chunks, handles CRLF split across chunks, multi-line data and ignores comments', () => {
  const out: SseMessage[] = [];
  const p = new SseParser((m) => out.push(m));
  p.push(': ping\r');
  p.push('\n\r\nevent: cue\r\nid: 3\r\ndata: {"a":');
  p.push('1}\r\n\r\n');
  p.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(out, [
    { event: 'cue', data: '{"a":1}', id: '3' },
    { event: 'message', data: 'line1\nline2', id: '3' },
  ]);
});

test('cue envelopes are parsed leniently: unknown cue types and bad boxes do not throw', () => {
  assert.equal(parseCueEnvelope({ seq: 1, cueId: 'c1', cue: { type: 'dance' } }), null);
  const env = parseCueEnvelope(cue(2, { type: 'ask', questionId: 'q1', text: 'Why?', topic: 'reason', regions: [{ regionId: 'r1', label: 'Total', box: [0.1, 0.2, 0.3, 0.4], evidenceId: 'e1' }, { regionId: 'r2', label: 'bad', box: [2, 0, 1, 1], evidenceId: null }], evidenceIds: ['e1'] }));
  assert.ok(env);
  assert.equal(env.cue.type, 'ask');
  if (env.cue.type === 'ask') {
    assert.deepEqual(env.cue.regions[0]?.box, [0.1, 0.2, 0.3, 0.4]);
    assert.equal(env.cue.regions[1]?.box, null);
  }
});

test('the cue stream sends the token only in the Authorization header and dispatches cues in order', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch();
  const { client, cues, statuses, hellos } = makeClient(f.fetch, timers);
  client.open();
  await settle();
  const get = f.calls.find((c) => c.url.includes('/cues'));
  assert.ok(get);
  assert.equal(get.url, 'https://api.example.invalid/api/agent/conductor/sess-1/cues?after=-1&client=web');
  assert.equal(get.headers['authorization'], AUTH);
  assert.ok(!get.url.includes(TOKEN));
  f.streams[0]?.push(sseHello(-1));
  f.streams[0]?.push(sseCue(cue(1, { type: 'state', clipa: 'listen' })));
  f.streams[0]?.push(sseCue(cue(2, { type: 'say', text: 'Hello' })).slice(0, 20));
  await settle();
  assert.deepEqual(hellos, [{ lastCueSeq: -1, first: true, reset: false }]);
  assert.equal(cues.length, 1);
  f.streams[0]?.push(sseCue(cue(2, { type: 'say', text: 'Hello' })).slice(20));
  await settle();
  assert.deepEqual(cues.map((c) => c.seq), [1, 2]);
  assert.equal(client.lastSeq, 2);
  assert.ok(statuses.includes('live'));
  client.close();
});

test('a broken stream reconnects with after=<last seq> and a replayed cue is not applied twice', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch();
  const { client, cues, hellos } = makeClient(f.fetch, timers);
  client.open();
  await settle();
  f.streams[0]?.push(sseHello() + sseCue(cue(1, { type: 'say', text: 'one' })) + sseCue(cue(2, { type: 'say', text: 'two' })));
  await settle();
  f.streams[0]?.end();
  await settle();
  assert.equal(f.calls.filter((c) => c.url.includes('/cues')).length, 1, 'waits for the backoff');
  timers.advance(RECONNECT_MIN_MS);
  await settle();
  const gets = f.calls.filter((c) => c.url.includes('/cues'));
  assert.equal(gets.length, 2);
  assert.ok(gets[1]?.url.includes('after=2&client=web'));
  f.streams[1]?.push(sseHello(3) + sseCue(cue(2, { type: 'say', text: 'two' })) + sseCue(cue(3, { type: 'say', text: 'three' })));
  await settle();
  assert.deepEqual(cues.map((c) => c.seq), [1, 2, 3]);
  assert.deepEqual(hellos.map((h) => h.first), [true, false]);
  client.close();
});

test('a restarted conductor (its last cue behind ours) is followed from its own seq again', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch();
  const { client, cues, hellos } = makeClient(f.fetch, timers);
  client.open();
  await settle();
  f.streams[0]?.push(sseHello() + sseCue(cue(5, { type: 'say', text: 'five' })));
  await settle();
  f.streams[0]?.end();
  await settle();
  timers.advance(RECONNECT_MIN_MS);
  await settle();
  f.streams[1]?.push(sseHello(0) + sseCue(cue(1, { type: 'say', text: 'new one' })));
  await settle();
  assert.deepEqual(cues.map((c) => c.seq), [5, 1]);
  assert.deepEqual(hellos.map((h) => h.reset), [false, true]);
  client.close();
});

test('a refused stream (401) is not retried: the status is failed', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch({ cueStatus: [401] });
  const { client, statuses } = makeClient(f.fetch, timers);
  client.open();
  await settle();
  timers.advance(60_000);
  await settle();
  assert.equal(f.calls.filter((c) => c.url.includes('/cues')).length, 1);
  assert.equal(statuses[statuses.length - 1], 'failed');
  client.close();
});

test('events are batched with increasing seq; activity goes out at once', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch();
  const { client } = makeClient(f.fetch, timers);
  client.send({ type: 'hello', client: 'web', version: 'web-1.1', persona: 'expert', language: null, mapFrom: null });
  client.send({ type: 'mode', mode: 'learn' });
  await settle();
  assert.equal(f.calls.length, 0, 'non-urgent events wait for the batch window');
  timers.advance(BATCH_MS);
  await settle();
  const first = f.calls[0];
  assert.ok(first);
  assert.equal(first.url, 'https://api.example.invalid/api/agent/conductor/sess-1/events');
  assert.equal(first.headers['authorization'], AUTH);
  const events = (first.body as { events: Array<{ seq: number; event: { type: string } }> }).events;
  assert.deepEqual(events.map((e) => [e.seq, e.event.type]), [[1, 'hello'], [2, 'mode']]);
  client.send({ type: 'activity', state: 'typing' });
  await settle();
  assert.equal(f.calls.length, 2, 'activity is sent without waiting');
  assert.deepEqual((f.calls[1]?.body as { events: Array<{ seq: number }> }).events.map((e) => e.seq), [3]);
  client.close();
});

test('a failed POST is retried with the same seqs; a 400 batch is dropped', async () => {
  const timers = new FakeTimers();
  const f = conductorFetch({ eventStatus: ['network', 503, 200, 400, 200] });
  const { client, logs } = makeClient(f.fetch, timers);
  client.send({ type: 'talking', by: 'person', active: true });
  await settle();
  timers.advance(RETRY_MIN_MS);
  await settle();
  timers.advance(RETRY_MIN_MS * 2);
  await settle();
  const posts = f.calls.filter((c) => c.url.endsWith('/events'));
  assert.equal(posts.length, 3);
  for (const p of posts) assert.deepEqual((p.body as { events: Array<{ seq: number }> }).events.map((e) => e.seq), [1]);
  client.send({ type: 'activity', state: 'idle' });
  await settle();
  client.send({ type: 'activity', state: 'typing' });
  await settle();
  const after = f.calls.filter((c) => c.url.endsWith('/events'));
  assert.equal(after.length, 5);
  assert.deepEqual((after[4]?.body as { events: Array<{ seq: number }> }).events.map((e) => e.seq), [3]);
  assert.ok(logs.some((l) => l.includes('(400)')));
  client.close();
});

test('events are made safe for the server: long reasons are clipped, an empty transcript is not sent', () => {
  const s = sanitizeEvent({ type: 'session', mode: 'learn', live: false, reason: 'x'.repeat(100) });
  assert.ok(s && s.type === 'session' && s.reason?.length === 40);
  assert.equal(sanitizeEvent({ type: 'transcript', role: 'expert', text: '   ' }), null);
  const ui = sanitizeEvent({ type: 'ui', action: 'ask_about', targetId: 'bad id with spaces', text: 'ok\u0001' });
  assert.ok(ui && ui.type === 'ui' && ui.targetId === null && ui.text === 'ok');
});

test('the join link is read from the address and removed from it', () => {
  assert.deepEqual(readJoinParams('?join=abcd2345&page=review'), { join: 'ABCD2345', page: 'review' });
  assert.deepEqual(readJoinParams('?join=nope'), { join: null, page: null });
  assert.deepEqual(readJoinParams('?page=summary'), { join: null, page: 'teach' });
  assert.equal(withoutJoinParams('https://x.example/clipa/?join=ABCD2345&page=review&debug=1#top'), '/clipa/?debug=1#top');
});
