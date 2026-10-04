import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, MapRegistry, RULES } from '../agent/conductor/engine.ts';
import { detectLanguage } from '../agent/conductor/lines.ts';
import { applyEdits } from '../agent/conductor/map-edits.ts';
import type { ConductorMap } from '../agent/conductor/map-edits.ts';
import { parseBatch } from '../agent/conductor/protocol.ts';
import type { ClientEvent, CueEnvelope } from '../agent/conductor/protocol.ts';
import type { TaskResult } from '../agent/llm.ts';
import { ORIGIN, bearer, issue, start } from './agent-helpers.ts';

// ---- a conductor on a fake clock with scripted tasks --------------------------------------------------------------
interface Rig {
  c: Conductor; cues: CueEnvelope[]; calls: Array<{ task: string; body: Record<string, unknown> }>; maps: MapRegistry;
  advance(ms: number): Promise<void>; send(...events: ClientEvent[]): Promise<void>; sendFrom(source: string, ...events: ClientEvent[]): Promise<void>;
}
function rig(answers: Record<string, (body: Record<string, unknown>) => TaskResult>, maps = new MapRegistry(), id = 'sess-1'): Rig {
  let now = 1_000_000;
  const seqs = new Map<string, number>();
  const calls: Rig['calls'] = [];
  const c = new Conductor(id, {
    now: () => now,
    newId: () => 'abcdef0123456789',
    maps,
    webLink: (page) => `https://web.example/clipa/?join=CODE1234&page=${page}`,
    llm: async (task, body) => {
      calls.push({ task, body: body as Record<string, unknown> });
      const answer = answers[task];
      return answer ? answer(body as Record<string, unknown>) : { ok: false, error: 'runner_error' };
    },
  });
  const cues: CueEnvelope[] = [];
  c.subscribe((cue) => cues.push(cue));
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const sendFrom = async (source: string, ...events: ClientEvent[]): Promise<void> => {
    c.handle(events.map((event) => { const s = (seqs.get(source) ?? 0) + 1; seqs.set(source, s); return { seq: s, atMs: now - 1_000_000, event }; }), source);
    await settle();
  };
  return {
    c, cues, calls, maps,
    async advance(ms) { now += ms; c.tick(); await settle(); },
    send: (...events) => sendFrom(id, ...events),
    sendFrom,
  };
}
const ok = (output: unknown): TaskResult => ({ ok: true, output });
const of = (cues: CueEnvelope[], type: string) => cues.filter((c) => c.cue.type === type);
const cueOf = <T extends CueEnvelope['cue']['type']>(cues: CueEnvelope[], type: T) => cues.filter((c) => c.cue.type === type).map((c) => c.cue as Extract<CueEnvelope['cue'], { type: T }>);
const obs = (id: string, change: string | null, extra: Record<string, unknown> = {}): ClientEvent => {
  const parsed = parseBatch({ events: [{ seq: 0, atMs: 0, event: { type: 'observation', observation: {
    id, kind: 'screen_activity', timestampMs: 1000, evidenceIds: [`ev-${id}`],
    facts: { app: 'Mail', surface: 'compose window', summary: `Summary ${id}`, change, pendingAction: null, regions: [{ id: 'r-to', label: 'recipient field', box: [0.1, 0.1, 0.3, 0.05] }], ...extra },
  } } }] });
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
};
const hello = (client: 'web' | 'macos', persona: 'expert' | 'new_hire' = 'expert', mapFrom: string | null = null): ClientEvent =>
  ({ type: 'hello', client, version: '1', persona, language: null, mapFrom });
const QUESTION = { question: 'You changed the recipient field. Who is it for?', topic: 'scope', observationIds: ['o2'], regionIds: ['r-to'] };

test('web: hello points at Start; once a stage runs without a shared screen, Clipa asks to share it', async () => {
  const r = rig({});
  await r.send(hello('web'));
  assert.deepEqual(cueOf(r.cues, 'guide').map((g) => g.step), ['welcome']);
  const welcome = cueOf(r.cues, 'guide')[0];
  assert.ok(welcome?.target?.kind === 'ui' && welcome.target.name === 'start');
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null });
  assert.equal(cueOf(r.cues, 'guide').at(-1)?.step, 'share_now');
  await r.send({ type: 'share', state: 'capturing', reason: null });
  assert.equal(cueOf(r.cues, 'guide').at(-1)?.step, 'work');
});

test('web: sharing before Start points at Start', async () => {
  const r = rig({});
  await r.send(hello('web'));
  assert.equal(of(r.cues, 'presence').length, 0, 'presence is for the macOS face only');
  await r.send({ type: 'share', state: 'capturing', reason: null });
  const guide = cueOf(r.cues, 'guide').at(-1);
  assert.ok(guide?.step === 'start_learn' && guide.target?.kind === 'ui' && guide.target.name === 'start');
});

test('Learn: the question is prepared while the person works and said the moment a pause begins', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null });
  await r.send(obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.send({ type: 'activity', state: 'typing' });
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.length, 1, 'prepared as soon as the screen settled');
  assert.equal(of(r.cues, 'ask').length, 0, 'never said while typing');
  await r.send({ type: 'activity', state: 'pause' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls.length, 1, 'no second call: the prepared question is used');
  const ask = cueOf(r.cues, 'ask')[0];
  assert.equal(ask?.text, QUESTION.question);
  assert.deepEqual(ask?.regions.map((x) => [x.regionId, x.box]), [['r-to', [0.1, 0.1, 0.3, 0.05]]]);
  assert.deepEqual(ask?.evidenceIds, ['ev-o2']);
  const point = cueOf(r.cues, 'point')[0];
  assert.ok(point?.target.kind === 'region' && point.target.regionId === 'r-to');
  // Another change right away: too soon after the last question, so nothing is prepared or said.
  await r.send({ type: 'cue_done', cueId: of(r.cues, 'ask')[0]!.cueId, outcome: 'spoken' }, obs('o3', 'The subject changed.'));
  await r.advance(RULES.pauseMs + 10);
  assert.equal(of(r.cues, 'ask').length, 1);
  await r.advance(RULES.learnMinGapMs);
  assert.equal(of(r.cues, 'ask').length, 2, 'after the gap it asks again');
});

test('Learn: a newer screen makes a prepared question out of date', async () => {
  const r = rig({ generic_question: (body) => ok({ ...QUESTION, question: `About ${String((body.observations as Array<{ id: string }>).at(-1)?.id)}` }) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'First change.'), { type: 'activity', state: 'typing' });
  await r.advance(RULES.settleMs + 10);
  await r.send(obs('o2', 'Second change.'));
  await r.send({ type: 'activity', state: 'pause' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(cueOf(r.cues, 'ask').at(-1)?.text, 'About o2');
});

test('typing cancels a question that has not been said yet; off the record hides Clipa and drops input', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
  await r.advance(RULES.pauseMs + 10);
  const ask = of(r.cues, 'ask')[0]!;
  await r.send({ type: 'activity', state: 'typing' });
  assert.deepEqual(cueOf(r.cues, 'cancel').map((c) => c.cueId), [ask.cueId]);
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
  assert.equal(cueOf(r.cues, 'ask')[0]?.text, 'I saw: The amount changed to 300. What made you do that?');
});

const MAP = {
  steps: [{ id: 's1', kind: 'judgment', goal: 'Keep the budget', action: 'Lowered it to 300', decision: { summary: 'Keep 300', reason: 'sign-off above', quote: 'above 300 the lead signs', quoteAtMs: 5 }, evidenceIds: ['o2'] }],
  guardrails: [{ id: 'g1', condition: 'budget above 300', requiredAction: 'ask the lead', reason: 'sign-off', quote: 'above 300 the lead signs', quoteAtMs: 5, escalateTo: 'the lead', exceptions: [], evidenceIds: ['o2'] }],
  gaps: [{ question: 'Who is the lead?', targetId: 'g1', evidenceIds: ['o2'], regionIds: ['r-to'] }],
  teachBack: 'You keep the budget at 300 and ask the lead above it. Is this right?',
};
const NO_EDIT = { intent: 'other', operations: [], reply: '', teachBack: null };

test('Review: map, the gaps one at a time, the teach-back; a confirmation confirms the map for Teach', async () => {
  const maps = new MapRegistry();
  const r = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok(NO_EDIT), reply_classification: () => ok({ verdict: 'confirm', correction: null }) }, maps);
  await r.send(hello('web'));
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'), { type: 'transcript', role: 'expert', text: 'above 300 the lead signs' });
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  assert.ok(cueOf(r.cues, 'guide').some((g) => g.step === 'review'));
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(r.calls.at(-1)?.task, 'map_synthesis');
  assert.equal(of(r.cues, 'map').length, 1);
  await r.advance(RULES.pauseMs + 10);
  const gapAsk = cueOf(r.cues, 'ask').at(-1);
  assert.ok(gapAsk?.text === 'Who is the lead?' && gapAsk.regions[0]?.regionId === 'r-to');
  await r.send({ type: 'transcript', role: 'expert', text: 'The team lead, Dana.' });
  assert.equal(r.calls.at(-1)?.task, 'map_edit', 'the answer goes into the map by voice editing');
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  const tb = cueOf(r.cues, 'teachback').at(-1);
  assert.equal(tb?.text, MAP.teachBack);
  await r.send({ type: 'transcript', role: 'expert', text: 'Yes, exactly.' });
  assert.equal(r.calls.at(-1)?.task, 'reply_classification');
  assert.ok(cueOf(r.cues, 'map').at(-1)?.confirmed);
  assert.equal(maps.find(null)?.sessionId, 'sess-1');
  assert.ok(cueOf(r.cues, 'guide').some((g) => g.step === 'handoff'));
});

test('Review: the expert only talks; Clipa edits the map, says what changed and reads the teach-back again', async () => {
  const edit = {
    intent: 'edit',
    operations: [{ op: 'set', targetId: 'g1', field: 'condition', value: 'budget above 500', value2: null, quote: null },
      { op: 'set', targetId: 'g1', field: 'reason', value: 'the lead signs above 500', value2: null, quote: 'the lead signs above 500' }],
    reply: 'Changed the limit to 500.',
    teachBack: 'You ask the lead above 500. Is this right?',
  };
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }), reply_classification: () => ok({ verdict: 'correct', correction: 'The limit is 500.' }), map_edit: () => ok(edit) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(of(r.cues, 'teachback').length, 1, 'no gaps: straight to the teach-back');
  await r.send({ type: 'transcript', role: 'expert', text: 'No, the lead signs above 500.' });
  assert.deepEqual(r.calls.map((c) => c.task), ['map_synthesis', 'reply_classification', 'map_edit']);
  const map = cueOf(r.cues, 'map').at(-1)?.map as ConductorMap;
  assert.equal(map.guardrails[0]?.condition, 'budget above 500');
  assert.equal(map.guardrails[0]?.quote, 'the lead signs above 500');
  assert.equal(cueOf(r.cues, 'say').at(-1)?.text, 'Changed the limit to 500.');
  assert.equal(cueOf(r.cues, 'teachback').at(-1)?.text, 'You ask the lead above 500. Is this right?');
});

test('map edits: reasons keep the expert\'s words; unknown targets change nothing', () => {
  const base: ConductorMap = { ...(structuredClone(MAP) as never as ConductorMap), comments: [] };
  const { map, applied } = applyEdits(base, [
    { op: 'add_rule', targetId: null, field: null, value: 'a new supplier', value2: 'check the contract first', quote: null },
    { op: 'comment', targetId: 's1', field: null, value: 'only in December', value2: null, quote: null },
    { op: 'set', targetId: 's9', field: 'goal', value: 'nope', value2: null, quote: null },
    { op: 'resolve_gap', targetId: 'gap-1', field: null, value: null, value2: null, quote: null },
    { op: 'add_step', targetId: 's1', field: null, value: 'Filed the note', value2: null, quote: null },
  ], 'Always check the contract of a new supplier first.', 1234);
  assert.equal(applied, 4);
  assert.deepEqual(map.guardrails.map((g) => g.id), ['g1', 'g2']);
  assert.equal(map.guardrails[1]?.quote, 'Always check the contract of a new supplier first.');
  assert.deepEqual(map.comments, [{ targetId: 's1', text: 'only in December', atMs: 1234 }]);
  assert.equal(map.gaps.length, 0);
  assert.deepEqual(map.steps.map((s) => s.id), ['s1', 's2']);
  assert.equal(base.guardrails.length, 1, 'the input map is not changed');
});

test('Teach: a pending action is checked fast, and the warning names the expert\'s rule and moment, once', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const r = rig({ guardrail_check: () => ok({ status: 'warn', guardrailId: 'g1', message: 'Your lead would stop here. Why?', regionIds: ['r-to'] }) }, maps, 'hire-1');
  await r.send(hello('web', 'new_hire', 'expert-session'));
  await r.send({ type: 'session', mode: 'teach', live: true, reason: null });
  assert.ok(cueOf(r.cues, 'context').some((c) => c.text.includes('budget above 300')));
  await r.send(obs('n1', 'Budget set to 450.', { pendingAction: 'Submit' }));
  await r.advance(RULES.urgentSettleMs + 10);
  const warn = cueOf(r.cues, 'warn')[0];
  assert.ok(warn, 'warned well before a full pause');
  assert.ok(warn.guardrailId === 'g1' && warn.regions[0]?.regionId === 'r-to');
  assert.deepEqual(warn.evidenceIds, ['o2'], 'the expert\'s moment');
  await r.send({ type: 'cue_done', cueId: of(r.cues, 'warn')[0]!.cueId, outcome: 'spoken' });
  await r.advance(RULES.teachCheckGapMs + RULES.pauseMs);
  assert.equal(of(r.cues, 'warn').length, 1, 'no repeat on the same screen');
});

test('Teach without a confirmed map says so', async () => {
  const r = rig({});
  await r.send(hello('web', 'new_hire'), { type: 'session', mode: 'teach', live: true, reason: null });
  assert.ok(cueOf(r.cues, 'guide').some((g) => g.step === 'no_map'));
});

test('macOS: Clipa waits in the corner, comes out to ask, and hands over to the web for Review', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('macos'));
  assert.deepEqual(cueOf(r.cues, 'presence').map((p) => p.size), ['peek']);
  assert.ok(of(r.cues, 'guide').every((g) => g.for === 'macos'), 'macOS gets its own lines');
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.advance(RULES.pauseMs + 10);
  assert.deepEqual(cueOf(r.cues, 'presence').map((p) => [p.size, p.anchor]), [['peek', 'corner'], ['dot', 'corner'], ['full', 'target']]);
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  const open = cueOf(r.cues, 'open_web')[0];
  assert.ok(open?.page === 'review' && open.url.includes('join=') && open.url.includes('page=review'));
  assert.equal(of(r.cues, 'open_web')[0]?.for, 'macos');
});

test('one conductor, two faces: a linked web app gets web cues, the Mac gets Mac cues', async () => {
  const r = rig({ map_synthesis: () => ok(MAP) });
  await r.send(hello('macos'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.sendFrom('web-session', hello('web'));
  await r.sendFrom('web-session', { type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(r.c.clientOf('web-session'), 'web');
  assert.ok(of(r.cues, 'map').length === 1 && of(r.cues, 'map')[0]?.for === 'all');
  const web = r.c.cuesAfter(0, 'web');
  const mac = r.c.cuesAfter(0, 'macos');
  assert.ok(web.some((c) => c.cue.type === 'guide' && c.cue.step === 'gaps'));
  assert.ok(!mac.some((c) => c.cue.type === 'guide' && c.cue.step === 'gaps'), 'the Mac does not get the web\'s Review lines');
  assert.ok(!web.some((c) => c.cue.type === 'presence'), 'presence is not sent to the web');
});

test('the language follows the expert and goes into the question task', async () => {
  const r = rig({ generic_question: () => ok({ ...QUESTION, question: null }) });
  await r.send({ type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'), { type: 'transcript', role: 'expert', text: 'Я просто проверил получателя, ничего не менял.' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls[0]?.body.language, 'ru');
  assert.equal(detectLanguage(['Ich prüfe das, weil der Kunde es so will.']), 'de');
  assert.equal(detectLanguage(['I just checked who I was replying to.']), null);
});

test('events are typed; a retried batch is applied once per face', () => {
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
  r.c.handle([{ seq: 1, atMs: 0, event: { type: 'mode', mode: 'teach' } }], 'other-face');
  assert.equal((r.c.status() as { selectedMode: string }).selectedMode, 'teach', 'another face has its own sequence');
});

// ---- HTTP ---------------------------------------------------------------------------------------------------------
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, state: { text: string }, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pattern.test(state.text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    state.text += new TextDecoder().decode(value);
  }
}

test('routes: token and origin are required; events go in, cues stream out and replay after a seq', async (t) => {
  const h = await start(t);
  const s = await issue(h.base);
  const url = `${h.base}/api/agent/conductor/${s.sessionId}`;
  const post = (body: unknown, headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json', ...bearer(s.token) }) =>
    fetch(`${url}/events`, { method: 'POST', headers, body: JSON.stringify(body) });
  const helloBatch = { events: [{ seq: 1, atMs: 10, event: { type: 'hello', client: 'web', version: '1', persona: 'expert' } }] };
  assert.equal((await post(helloBatch, { Origin: ORIGIN, 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(helloBatch, { Origin: 'https://evil.example', 'Content-Type': 'application/json', ...bearer(s.token) })).status, 403);
  assert.equal((await post({ events: [{ seq: 1, atMs: 0, event: { type: 'nope' } }] })).status, 400);
  const r = await post(helloBatch);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, lastEventSeq: 1, lastCueSeq: 2 });

  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(`${url}/cues?after=0`, { headers: { Origin: ORIGIN, ...bearer(s.token) }, signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  const state = { text: '' };
  await readUntil(reader, state, /"step":"welcome"/);
  assert.match(state.text, /event: hello/);
  assert.match(state.text, /id: 2\nevent: cue/);
  await post({ events: [{ seq: 2, atMs: 20, event: { type: 'share', state: 'capturing' } }] });
  await readUntil(reader, state, /"step":"start_learn"/);
  assert.match(state.text, /"step":"start_learn"/);
  assert.equal((await fetch(`${url}/cues`, { headers: { Origin: ORIGIN } })).status, 401);
  ac.abort();
});

test('routes: the Mac hands over with a single-use code; the web joins the same conductor', async (t) => {
  const h = await start(t, { publicWebUrl: 'https://web.example/clipa/' });
  const mac = await issue(h.base);
  const web = await issue(h.base);
  const events = (id: string, token: string, body: unknown) => fetch(`${h.base}/api/agent/conductor/${id}/events`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...bearer(token) }, body: JSON.stringify(body) });
  await events(mac.sessionId, mac.token, { events: [
    { seq: 1, atMs: 0, event: { type: 'hello', client: 'macos', version: '1', persona: 'expert' } },
    { seq: 2, atMs: 5, event: { type: 'session', mode: 'learn', live: true } },
    { seq: 3, atMs: 50, event: { type: 'session', mode: 'learn', live: false, reason: 'user' } },
  ] });
  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(`${h.base}/api/agent/conductor/${mac.sessionId}/cues?after=0&client=macos`, { headers: { Origin: ORIGIN, ...bearer(mac.token) }, signal: ac.signal });
  const state = { text: '' };
  await readUntil(stream.body!.getReader(), state, /"type":"open_web"/);
  const url = /"url":"([^"]+)"/.exec(state.text)?.[1] ?? '';
  assert.match(url, /^https:\/\/web\.example\/clipa\/\?join=[A-Z0-9]{8}&page=review$/);
  const code = new URL(url).searchParams.get('join')!;
  const link = (body: unknown) => fetch(`${h.base}/api/agent/conductor/${web.sessionId}/link`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...bearer(web.token) }, body: JSON.stringify(body) });
  assert.equal((await link({ code })).status, 200);
  assert.equal((await link({ code })).status, 404, 'single use');
  const r = await events(web.sessionId, web.token, { events: [{ seq: 1, atMs: 0, event: { type: 'hello', client: 'web', version: '1', persona: 'expert' } }] });
  const body = await r.json() as { lastCueSeq: number };
  assert.ok(body.lastCueSeq > 5, 'the web joined the Mac\'s conductor, not a new one');
  ac.abort();
});
