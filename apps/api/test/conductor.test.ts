import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, MapRegistry, RULES } from '../agent/conductor/engine.ts';
import { detectLanguage } from '../agent/conductor/lines.ts';
import { parseBatch } from '../agent/conductor/protocol.ts';
import type { ClientEvent, CueEnvelope } from '../agent/conductor/protocol.ts';
import type { TaskResult } from '../agent/llm.ts';
import { ORIGIN, bearer, issue, start } from './agent-helpers.ts';

// ---- a conductor on a fake clock with scripted tasks --------------------------------------------------------------
interface Rig { c: Conductor; cues: CueEnvelope[]; calls: Array<{ task: string; body: Record<string, unknown> }>; advance(ms: number): Promise<void>; send(...events: ClientEvent[]): Promise<void>; maps: MapRegistry }
function rig(answers: Record<string, (body: Record<string, unknown>) => TaskResult>, maps = new MapRegistry(), id = 'sess-1'): Rig {
  let now = 1_000_000;
  let seq = 0;
  const calls: Rig['calls'] = [];
  const c = new Conductor(id, {
    now: () => now,
    newId: () => 'abcdef0123456789',
    maps,
    llm: async (task, body) => {
      calls.push({ task, body: body as Record<string, unknown> });
      const answer = answers[task];
      return answer ? answer(body as Record<string, unknown>) : { ok: false, error: 'runner_error' };
    },
  });
  const cues: CueEnvelope[] = [];
  c.subscribe((cue) => cues.push(cue));
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return {
    c, cues, calls, maps,
    async advance(ms) { now += ms; c.tick(); await settle(); },
    async send(...events) { c.handle(events.map((event) => ({ seq: ++seq, atMs: now - 1_000_000, event }))); await settle(); },
  };
}
const ok = (output: unknown): TaskResult => ({ ok: true, output });
const of = (cues: CueEnvelope[], type: string) => cues.filter((c) => c.cue.type === type);
const obs = (id: string, change: string | null, extra: Record<string, unknown> = {}): ClientEvent => {
  const parsed = parseBatch({ events: [{ seq: 0, atMs: 0, event: { type: 'observation', observation: {
    id, kind: 'screen_activity', timestampMs: 1000, evidenceIds: [`ev-${id}`],
    facts: { app: 'Mail', surface: 'compose window', summary: `Summary ${id}`, change, pendingAction: null, regions: [{ id: 'r-to', label: 'recipient field', box: [0.1, 0.1, 0.3, 0.05] }], ...extra },
  } } }] });
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
};
const QUESTION = { question: 'You changed the recipient field. Who is it for?', topic: 'scope', observationIds: ['o2'], regionIds: ['r-to'] };

test('hello guides the persona to share; capturing points at Start', async () => {
  const r = rig({});
  await r.send({ type: 'hello', client: 'macos', version: '1', persona: 'expert', language: null, mapFrom: null });
  const first = of(r.cues, 'guide')[0]?.cue;
  assert.ok(first?.type === 'guide' && first.step === 'welcome');
  await r.send({ type: 'share', state: 'capturing', reason: null });
  const guide = of(r.cues, 'guide').at(-1)?.cue;
  assert.ok(guide?.type === 'guide' && guide.step === 'start_learn' && guide.target?.kind === 'ui' && guide.target.name === 'start');
});

test('Learn asks only at a pause after a change, points at the region, and keeps to the budget', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send({ type: 'hello', client: 'web', version: '1', persona: 'expert', language: null, mapFrom: null }, { type: 'session', mode: 'learn', live: true, reason: null });
  await r.send(obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.send({ type: 'activity', state: 'typing' });
  await r.advance(1000);
  assert.equal(r.calls.length, 0, 'no question while typing');
  await r.send({ type: 'activity', state: 'pause' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.task, 'generic_question');
  const ask = of(r.cues, 'ask')[0]?.cue;
  assert.ok(ask?.type === 'ask');
  assert.equal(ask.text, QUESTION.question);
  assert.deepEqual(ask.regions.map((x) => [x.regionId, x.box]), [['r-to', [0.1, 0.1, 0.3, 0.05]]]);
  assert.deepEqual(ask.evidenceIds, ['ev-o2']);
  const point = of(r.cues, 'point')[0]?.cue;
  assert.ok(point?.type === 'point' && point.target.kind === 'region' && point.target.regionId === 'r-to');
  // Another change right away: too soon after the last question.
  await r.send({ type: 'cue_done', cueId: of(r.cues, 'ask')[0]!.cueId, outcome: 'spoken' }, obs('o3', 'The subject changed.'));
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls.length, 1);
  await r.advance(RULES.learnMinGapMs);
  assert.equal(r.calls.length, 2, 'after the gap it asks again');
});

test('typing cancels a question that has not been said yet; off the record hides Clipa and drops input', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
  await r.advance(RULES.pauseMs + 10);
  const ask = of(r.cues, 'ask')[0]!;
  await r.send({ type: 'activity', state: 'typing' });
  assert.deepEqual(of(r.cues, 'cancel').map((c) => c.cue.type === 'cancel' && c.cue.cueId), [ask.cueId]);
  await r.send({ type: 'off_record', on: true });
  const last = r.cues.at(-1)?.cue;
  assert.ok(last?.type === 'state' && last.clipa === 'hidden');
  await r.send(obs('o9', 'Secret change.'), { type: 'transcript', role: 'expert', text: 'private words' }, { type: 'activity', state: 'pause' });
  await r.advance(RULES.learnMinGapMs + RULES.pauseMs);
  assert.equal(r.calls.length, 1, 'nothing asked off the record');
  assert.equal((r.c.status() as { observations: number }).observations, 2);
  assert.equal((r.c.status() as { turns: number }).turns, 0);
});

test('a failed question route falls back to a plain question about the latest change', async () => {
  const r = rig({});
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'The amount changed to 300.'));
  await r.advance(RULES.pauseMs + 10);
  const ask = of(r.cues, 'ask')[0]?.cue;
  assert.ok(ask?.type === 'ask' && ask.text === 'I saw: The amount changed to 300. What made you do that?');
});

const MAP = {
  steps: [{ id: 's1', kind: 'judgment', goal: 'Keep the budget', action: 'Lowered it to 300', decision: { summary: 'Keep 300', reason: 'sign-off above', quote: 'above 300 the lead signs', quoteAtMs: 5 }, evidenceIds: ['o2'] }],
  guardrails: [{ id: 'g1', condition: 'budget above 300', requiredAction: 'ask the lead', reason: 'sign-off', quote: 'above 300 the lead signs', quoteAtMs: 5, escalateTo: 'the lead', exceptions: [], evidenceIds: ['o2'] }],
  gaps: [{ question: 'Who is the lead?', targetId: 'g1', evidenceIds: ['o2'], regionIds: ['r-to'] }],
  teachBack: 'You keep the budget at 300 and ask the lead above it. Is this right?',
};

test('Review: map, then the gaps one at a time, then the teach-back; a confirmation confirms the map for Teach', async () => {
  const maps = new MapRegistry();
  const r = rig({ map_synthesis: () => ok(MAP), reply_classification: () => ok({ verdict: 'confirm', correction: null }) }, maps);
  await r.send({ type: 'hello', client: 'web', version: '1', persona: 'expert', language: null, mapFrom: null });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'), { type: 'transcript', role: 'expert', text: 'above 300 the lead signs' });
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  assert.ok(of(r.cues, 'guide').some((g) => g.cue.type === 'guide' && g.cue.step === 'review'));
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(r.calls.at(-1)?.task, 'map_synthesis');
  assert.equal(of(r.cues, 'map').length, 1);
  await r.advance(RULES.pauseMs + 10);
  const gapAsk = of(r.cues, 'ask').at(-1)?.cue;
  assert.ok(gapAsk?.type === 'ask' && gapAsk.text === 'Who is the lead?' && gapAsk.regions[0]?.regionId === 'r-to');
  await r.send({ type: 'transcript', role: 'expert', text: 'The team lead, Dana.' });
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  assert.equal(r.calls.filter((c) => c.task === 'map_synthesis').length, 2, 'resynthesised after the last gap');
  const tb = of(r.cues, 'teachback').at(-1)?.cue;
  assert.ok(tb?.type === 'teachback' && tb.text === MAP.teachBack);
  await r.send({ type: 'transcript', role: 'expert', text: 'Yes, exactly.' });
  assert.equal(r.calls.at(-1)?.task, 'reply_classification');
  const last = of(r.cues, 'map').at(-1)?.cue;
  assert.ok(last?.type === 'map' && last.confirmed);
  assert.equal(maps.find(null)?.sessionId, 'sess-1');
  assert.ok(of(r.cues, 'guide').some((g) => g.cue.type === 'guide' && g.cue.step === 'handoff'));
});

test('Review: a correction resynthesises with the correction and reads the teach-back again', async () => {
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }), reply_classification: () => ok({ verdict: 'correct', correction: 'The limit is 500.' }) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(of(r.cues, 'teachback').length, 1, 'no gaps: straight to the teach-back');
  await r.send({ type: 'transcript', role: 'expert', text: 'No, the limit is 500.' });
  const second = r.calls.filter((c) => c.task === 'map_synthesis')[1];
  assert.equal(second?.body.correction, 'The limit is 500.');
  assert.equal(second?.body.previousTeachBack, MAP.teachBack);
  assert.equal(of(r.cues, 'teachback').length, 2);
});

test('Teach: warns before a pending action that a confirmed guardrail covers, once per rule and screen', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const r = rig({ guardrail_check: () => ok({ status: 'warn', guardrailId: 'g1', message: 'Your lead would stop here. Why?', regionIds: ['r-to'] }) }, maps, 'hire-1');
  await r.send({ type: 'hello', client: 'macos', version: '1', persona: 'new_hire', language: null, mapFrom: 'expert-session' });
  await r.send({ type: 'session', mode: 'teach', live: true, reason: null });
  assert.ok(of(r.cues, 'context').some((c) => c.cue.type === 'context' && c.cue.text.includes('budget above 300')));
  await r.send(obs('n1', 'Budget set to 450.', { pendingAction: 'Submit' }));
  await r.advance(RULES.pauseMs + 10);
  const warn = of(r.cues, 'warn')[0]?.cue;
  assert.ok(warn?.type === 'warn' && warn.guardrailId === 'g1' && warn.regions[0]?.regionId === 'r-to');
  assert.deepEqual(warn.evidenceIds, ['o2'], 'the expert\'s moment');
  await r.send({ type: 'cue_done', cueId: of(r.cues, 'warn')[0]!.cueId, outcome: 'spoken' });
  await r.advance(RULES.teachCheckGapMs + RULES.pauseMs);
  assert.equal(of(r.cues, 'warn').length, 1, 'no repeat on the same screen');
});

test('Teach without a confirmed map says so', async () => {
  const r = rig({});
  await r.send({ type: 'hello', client: 'web', version: '1', persona: 'new_hire', language: null, mapFrom: null }, { type: 'session', mode: 'teach', live: true, reason: null });
  assert.ok(of(r.cues, 'guide').some((g) => g.cue.type === 'guide' && g.cue.step === 'no_map'));
});

test('the language follows the expert and goes into the question task', async () => {
  const r = rig({ generic_question: () => ok({ ...QUESTION, question: null }) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'), { type: 'transcript', role: 'expert', text: 'Я просто проверил получателя, ничего не менял.' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls[0]?.body.language, 'ru');
  assert.equal(detectLanguage(['Ich prüfe das, weil der Kunde es so will.']), 'de');
  assert.equal(detectLanguage(['I just checked who I was replying to.']), null);
});

test('events are typed; a retried batch is applied once', () => {
  assert.equal(parseBatch({ events: [] }).ok, false);
  const bad = parseBatch({ events: [{ seq: 1, atMs: 0, event: { type: 'activity', state: 'dancing' } }] });
  assert.ok(!bad.ok && bad.field === 'events.0.event.state');
  assert.equal(parseBatch({ events: [{ seq: 2, atMs: 0, event: { type: 'mode', mode: 'learn' } }, { seq: 2, atMs: 0, event: { type: 'mode', mode: 'learn' } }] }).ok, false);
  const box = parseBatch({ events: [{ seq: 1, atMs: 0, event: { type: 'observation', observation: { id: 'x', kind: 'screen_activity', timestampMs: 0, facts: { surface: 's', summary: 'y', regions: [{ id: 'r', label: 'l', box: [0.9, 0, 0.5, 0.1] }] } } } }] });
  assert.ok(box.ok && box.value[0]?.event.type === 'observation' && box.value[0].event.observation.regions.length === 0, 'a box outside the frame is dropped');
  const r = rig({});
  r.c.handle([{ seq: 5, atMs: 0, event: { type: 'mode', mode: 'review' } }]);
  r.c.handle([{ seq: 5, atMs: 0, event: { type: 'mode', mode: 'teach' } }]);
  assert.equal((r.c.status() as { selectedMode: string }).selectedMode, 'review');
});

// ---- HTTP ---------------------------------------------------------------------------------------------------------
test('routes: token and origin are required; events go in, cues stream out and replay after a seq', async (t) => {
  const h = await start(t);
  const s = await issue(h.base);
  const url = `${h.base}/api/agent/conductor/${s.sessionId}`;
  const post = (body: unknown, headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json', ...bearer(s.token) }) =>
    fetch(`${url}/events`, { method: 'POST', headers, body: JSON.stringify(body) });
  const hello = { events: [{ seq: 1, atMs: 10, event: { type: 'hello', client: 'macos', version: '1', persona: 'expert' } }] };
  assert.equal((await post(hello, { Origin: ORIGIN, 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(hello, { Origin: 'https://evil.example', 'Content-Type': 'application/json', ...bearer(s.token) })).status, 403);
  assert.equal((await post({ events: [{ seq: 1, atMs: 0, event: { type: 'nope' } }] })).status, 400);
  const r = await post(hello);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, lastEventSeq: 1, lastCueSeq: 2 });

  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(`${url}/cues?after=0`, { headers: { Origin: ORIGIN, ...bearer(s.token) }, signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  let text = '';
  const until = async (pattern: RegExp): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!pattern.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  };
  await until(/"step":"welcome"/);
  assert.match(text, /event: hello/);
  assert.match(text, /id: 2\nevent: cue/);
  await post({ events: [{ seq: 2, atMs: 20, event: { type: 'share', state: 'capturing' } }] });
  await until(/"step":"start_learn"/);
  assert.match(text, /"step":"start_learn"/);
  const noToken = await fetch(`${url}/cues`, { headers: { Origin: ORIGIN } });
  assert.equal(noToken.status, 401);
  ac.abort();
});
