import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, MapRegistry, RULES } from '../agent/conductor/engine.ts';
import { affirmSaid, confirmPrior } from '../agent/conductor/lines.ts';
import type { ConductorMap } from '../agent/conductor/map-edits.ts';
import { parseBatch } from '../agent/conductor/protocol.ts';
import type { ClientEvent, CueEnvelope } from '../agent/conductor/protocol.ts';
import type { TaskResult } from '../agent/llm.ts';
import type { EnrichInput, EnrichOutput, EnrichResult } from '../agent/map-enrich.ts';

// ---- a conductor on a fake clock with scripted tasks and a scripted enrichment job ---------------------------------------
interface Rig {
  c: Conductor; cues: CueEnvelope[]; calls: Array<{ task: string; body: Record<string, unknown> }>; maps: MapRegistry;
  enrichCalls: Array<{ input: EnrichInput; signal: AbortSignal }>;
  advance(ms: number): Promise<void>; send(...events: ClientEvent[]): Promise<void>;
}
type Enrich = (input: EnrichInput, signal: AbortSignal) => Promise<EnrichResult>;
function rig(answers: Record<string, (body: Record<string, unknown>) => TaskResult>, enrich: Enrich | undefined, maps = new MapRegistry(), id = 'sess-1'): Rig {
  let now = 1_000_000;
  let seq = 0;
  const calls: Rig['calls'] = [];
  const enrichCalls: Rig['enrichCalls'] = [];
  const c = new Conductor(id, {
    now: () => now,
    newId: () => 'abcdef0123456789',
    maps,
    llm: async (task, body) => {
      calls.push({ task, body: body as Record<string, unknown> });
      const answer = answers[task];
      return answer ? answer(body as Record<string, unknown>) : { ok: false, error: 'runner_error' };
    },
    ...(enrich ? { enrich: (input: EnrichInput, signal: AbortSignal) => { enrichCalls.push({ input, signal }); return enrich(input, signal); } } : {}),
  });
  const cues: CueEnvelope[] = [];
  c.subscribe((cue) => cues.push(cue));
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return {
    c, cues, calls, maps, enrichCalls,
    async advance(ms) { now += ms; c.tick(); await settle(); },
    async send(...events) {
      c.handle(events.map((event) => ({ seq: ++seq, atMs: now - 1_000_000, event })), id);
      await settle();
    },
  };
}
const ok = (output: unknown): TaskResult => ({ ok: true, output });
const of = (cues: CueEnvelope[], type: string) => cues.filter((c) => c.cue.type === type);
const cueOf = <T extends CueEnvelope['cue']['type']>(cues: CueEnvelope[], type: T) => cues.filter((c) => c.cue.type === type).map((c) => c.cue as Extract<CueEnvelope['cue'], { type: T }>);
const obs = (id: string, change: string | null): ClientEvent => {
  const parsed = parseBatch({ events: [{ seq: 0, atMs: 0, event: { type: 'observation', observation: {
    id, kind: 'screen_activity', timestampMs: 1000, evidenceIds: [`ev-${id}`],
    facts: { app: 'Sheets', surface: 'budget sheet', summary: `Summary ${id}`, change, pendingAction: null, regions: [] },
  } } }] });
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
};
const hello: ClientEvent = { type: 'hello', client: 'web', version: '1', persona: 'expert', language: null, mapFrom: null };
const learn = (live: boolean): ClientEvent => ({ type: 'session', mode: 'learn', live, reason: live ? null : 'user' });
const review: ClientEvent = { type: 'session', mode: 'review', live: true, reason: null };
const said = (text: string): ClientEvent => ({ type: 'transcript', role: 'expert', text });

const gap = (question: string) => ({ question, targetId: 'g1', evidenceIds: [], regionIds: [] });
const MAP = {
  processes: [{ id: 'p1', title: 'Budget update', summary: 'Keeps the budget in bounds.' }],
  steps: [
    { id: 's1', processId: 'p1', kind: 'action', goal: 'Keep the budget', action: 'Lowered a line to 300', decision: null, evidenceIds: ['o2'] },
  ],
  guardrails: [{ id: 'g1', processId: 'p1', condition: 'a line above 300', requiredAction: 'ask the lead', reason: null, quote: null, quoteAtMs: null, escalateTo: null, exceptions: [], evidenceIds: ['o2'] }],
  gaps: [gap('Who is the lead?'), gap('Is 300 a hard limit?')],
  teachBack: 'You keep lines at 300 and ask the lead above it. Right?',
};
const QUOTE = 'Above 500 the finance lead signs it off';
const output = (over: Partial<EnrichOutput> = {}): EnrichOutput => ({
  map: {
    steps: [{ id: 's1', goal: 'Keep every budget line in bounds', action: null, decision: null, evidenceIds: [] }],
    guardrails: [{ id: 'g1', condition: null, requiredAction: null, reason: 'The finance lead signs above 500.', quote: QUOTE, quoteSessionId: 'sess-old', quoteAtMs: null, escalateTo: 'the finance lead', exceptions: [], evidenceIds: [] }],
    related: [],
  },
  context: [{ fact: 'The finance lead signs off large lines.', quote: QUOTE, sessionId: 'sess-old' }],
  predictions: [{ gapId: 'gap-1', likelyAnswer: 'The finance lead.', quote: QUOTE, sessionId: 'sess-old', confidence: 0.9 }],
  ...over,
});
const done = (out: EnrichOutput): EnrichResult => ({ ok: true, output: out, files: 3, sessions: 1 });
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const mapOf = (cues: CueEnvelope[]): ConductorMap & { context?: unknown; related?: unknown } => cueOf(cues, 'map').at(-1)?.map as ConductorMap;
/** Show with real work, then its end: the background map build runs, and with it the enrichment. */
async function show(r: Rig): Promise<void> {
  await r.send(hello, learn(true), obs('o1', null), obs('o2', 'Changed.'), said('Above 300 the lead signs.'));
  await r.send(learn(false));
}

test('the enrichment starts in the background once the map is built, with this session\'s own material, and Reflect is not held up by it', async () => {
  const pending = deferred<EnrichResult>();
  const r = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok({ intent: 'other', operations: [], reply: '', teachBack: null }), reply_classification: () => ok({ verdict: 'confirm', correction: null }) }, () => pending.promise);
  await show(r);
  assert.equal(r.enrichCalls.length, 1);
  const job = r.enrichCalls[0]!.input;
  assert.equal(job.sessionId, 'sess-1');
  assert.equal(job.persona, 'expert');
  assert.deepEqual(job.map.steps.map((s) => s.id), ['s1']);
  assert.deepEqual(job.observations.map((o) => [o.id, o.app, o.surface]), [['o1', 'Sheets', 'budget sheet'], ['o2', 'Sheets', 'budget sheet']]);
  assert.deepEqual(job.transcript.map((t) => [t.role, t.text]), [['expert', 'Above 300 the lead signs.']]);
  assert.equal(r.c.status().enrichment, 'running');
  // The job never answers; Reflect goes on without it: map, gap, teach-back, confirmation.
  await r.send(review);
  assert.equal(of(r.cues, 'map').length, 1);
  await r.advance(RULES.pauseMs + 10);
  assert.equal(cueOf(r.cues, 'ask').at(-1)?.text, 'Who is the lead?', 'asked as an open question: nothing was predicted');
  assert.equal(r.calls.filter((c) => c.task === 'map_synthesis').length, 1);
  await r.send({ type: 'ui', action: 'finish', targetId: null, text: null });
  assert.equal(of(r.cues, 'teachback').length, 1);
  await r.send(said('Yes, exactly.'));
  assert.ok(cueOf(r.cues, 'map').at(-1) && of(r.cues, 'map').at(-1)?.cue.type === 'map');
  assert.equal(r.c.status().enrichment, 'idle', 'the confirmation ends the job: its result could not be used any more');
  assert.equal(r.enrichCalls[0]!.signal.aborted, true);
});

test('a result that arrives before Reflect opens is in the first map; one that arrives while Reflect runs publishes a new version with the origin unchanged', async () => {
  // Before Reflect: the map is updated silently, and Reflect publishes it.
  const early = rig({ map_synthesis: () => ok(MAP) }, async () => done(output()));
  await show(early);
  assert.equal(of(early.cues, 'map').length, 0, 'nothing is shown before Reflect');
  await early.send(review);
  assert.equal(of(early.cues, 'map').length, 1);
  const first = mapOf(early.cues);
  assert.equal(first.steps[0]?.goal, 'Keep every budget line in bounds');
  assert.equal(first.guardrails[0]?.reason, 'The finance lead signs above 500.');
  assert.equal(first.guardrails[0]?.quote, QUOTE);
  assert.equal(first.guardrails[0]?.quoteSessionId, 'sess-old');
  assert.equal(first.guardrails[0]?.escalateTo, 'the finance lead');
  assert.deepEqual(first.context, output().context);
  assert.equal(early.maps.lastBuilt()?.map.steps[0]?.goal, 'Keep every budget line in bounds', 'the stored last-built map is the deeper one');

  // While Reflect runs: a new version.
  const pending = deferred<EnrichResult>();
  const late = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok({ intent: 'other', operations: [], reply: '', teachBack: null }) }, () => pending.promise);
  await show(late);
  await late.send(review);
  const before = cueOf(late.cues, 'map').at(-1)!;
  assert.equal(before.version, 1);
  assert.equal((before.map as ConductorMap).steps[0]?.goal, 'Keep the budget');
  pending.resolve(done(output()));
  await late.advance(0);
  const maps = cueOf(late.cues, 'map');
  assert.equal(maps.length, 2);
  const after = maps.at(-1)!;
  assert.equal(after.version, 2);
  assert.equal(after.confirmed, false);
  assert.equal(after.origin, 'session');
  assert.equal((after.map as ConductorMap).steps[0]?.goal, 'Keep every budget line in bounds');
  assert.equal(late.c.status().enrichment, 'idle');
});

test('what the expert changed by voice while the job ran stays theirs; untouched fields take the more precise wording', async () => {
  const pending = deferred<EnrichResult>();
  const edit = { intent: 'edit', operations: [{ op: 'set', targetId: 's1', field: 'goal', value: 'Keep the budget under the cap', value2: null, quote: null }], reply: 'Changed the goal.', teachBack: null };
  const r = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok(edit) }, () => pending.promise);
  await show(r);
  await r.send(review);
  await r.advance(RULES.pauseMs + 10);
  await r.send(said('Call the goal: keep the budget under the cap.'));
  assert.equal(mapOf(r.cues).steps[0]?.goal, 'Keep the budget under the cap');
  pending.resolve(done(output()));
  await r.advance(0);
  const map = mapOf(r.cues);
  assert.equal(map.steps[0]?.goal, 'Keep the budget under the cap', 'the expert\'s own edit is not overwritten');
  assert.equal(map.guardrails[0]?.reason, 'The finance lead signs above 500.', 'a rule nobody touched takes the detail');
});

test('a confirmed map is the expert\'s: a result that arrives after the confirmation changes nothing', async () => {
  const pending = deferred<EnrichResult>();
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) }, () => pending.promise);
  await show(r);
  await r.send(review);
  assert.equal(of(r.cues, 'teachback').length, 1, 'no open points: straight to the teach-back');
  const mapsBefore = of(r.cues, 'map').length;
  await r.send({ type: 'ui', action: 'confirm', targetId: null, text: null });
  assert.ok(cueOf(r.cues, 'map').at(-1)?.confirmed);
  const confirmedGoal = r.maps.find(null)?.map.steps[0]?.goal;
  assert.equal(confirmedGoal, 'Keep the budget');
  pending.resolve(done(output()));
  await r.advance(0);
  assert.equal(of(r.cues, 'map').length, mapsBefore + 1, 'only the confirmation itself');
  assert.equal(r.maps.find(null)?.map.steps[0]?.goal, 'Keep the budget');
  assert.equal(r.maps.find(null)?.map.context, undefined);
});

test('a strong prediction with the expert\'s earlier words turns the open point into a confirmation; weak ones and ones without words keep the open question', async () => {
  const gaps = ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?'].map(gap);
  const predictions = [
    { gapId: 'gap-1', likelyAnswer: 'The finance lead.', quote: QUOTE, sessionId: 'sess-old', confidence: 0.9 },
    { gapId: 'gap-2', likelyAnswer: 'Yes, hard.', quote: 'The limit is hard, no exceptions here', sessionId: 'sess-old', confidence: 0.6 },
    { gapId: 'gap-3', likelyAnswer: 'The director.', quote: null, sessionId: null, confidence: 0.5 },
  ];
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps }), map_edit: () => ok({ intent: 'other', operations: [], reply: '', teachBack: null }) }, async () => done(output({ predictions })));
  await show(r);
  await r.send(review);
  for (const answer of ['The finance lead, yes.', 'Hard, yes.']) {
    await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
    await r.send(said(answer));
  }
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  const asks = cueOf(r.cues, 'ask');
  assert.deepEqual(asks.map((a) => a.text), [confirmPrior(QUOTE), 'Is 300 a hard limit?', 'Who decides above it?']);
  assert.equal(asks[0]?.text, `Last time you said: "${QUOTE}". Still true?`);
  assert.deepEqual(asks.map((a) => [a.questionId, a.topic]), [['gap-1', 'gap'], ['gap-2', 'gap'], ['gap-3', 'gap']], 'the same open points, in the same order');
  // The threshold is the rule's, and the words come from another session than this one.
  assert.equal(RULES.predictConfidence, 0.75);

  const own = rig({ map_synthesis: () => ok(MAP) }, async () => done(output({ predictions: [{ gapId: 'gap-1', likelyAnswer: 'x', quote: QUOTE, sessionId: 'sess-1', confidence: 0.99 }] })));
  await show(own);
  await own.send(review);
  await own.advance(RULES.pauseMs + 10);
  assert.equal(cueOf(own.cues, 'ask').at(-1)?.text, 'Who is the lead?', 'words from this very session are no "last time"');
});

test('an answer to a confirmation goes through the edit; a bare yes carries the confirmed words in, a correction goes in as said', async () => {
  const run = async (reply: string): Promise<string> => {
    const r = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok({ intent: 'other', operations: [], reply: '', teachBack: null }) }, async () => done(output()));
    await show(r);
    await r.send(review);
    await r.advance(RULES.pauseMs + 10);
    assert.equal(cueOf(r.cues, 'ask').at(-1)?.text, confirmPrior(QUOTE));
    await r.send(said(reply));
    const edit = r.calls.filter((c) => c.task === 'map_edit');
    assert.equal(edit.length, 1, 'the existing edit path, nothing special');
    return String(edit[0]?.body.utterance);
  };
  assert.equal(await run('Yes, still true.'), `Yes, still true. "${QUOTE}"`);
  assert.equal(await run('Exactly.'), `Exactly. "${QUOTE}"`);
  assert.equal(await run('No, the director signs now.'), 'No, the director signs now.');
  assert.equal(await run('Yes, but only in the first half of the year.'), 'Yes, but only in the first half of the year.');
  assert.equal(await run('The finance lead and the director.'), 'The finance lead and the director.');
});

test('an open point asked as it is takes its answer as it was said', async () => {
  const r = rig({ map_synthesis: () => ok(MAP), map_edit: () => ok({ intent: 'other', operations: [], reply: '', teachBack: null }) }, async () => done(output({ predictions: [] })));
  await show(r);
  await r.send(review);
  await r.advance(RULES.pauseMs + 10);
  await r.send(said('Yes, the team lead.'));
  assert.equal(r.calls.find((c) => c.task === 'map_edit')?.body.utterance, 'Yes, the team lead.');
});

test('off the record: the running job is stopped and its result is dropped; a job is not started when the map is built off the record', async () => {
  const pending = deferred<EnrichResult>();
  const r = rig({ map_synthesis: () => ok(MAP) }, () => pending.promise);
  await show(r);
  assert.equal(r.enrichCalls.length, 1);
  await r.send({ type: 'off_record', on: true });
  assert.equal(r.enrichCalls[0]!.signal.aborted, true);
  assert.equal(r.c.status().enrichment, 'idle');
  await r.send({ type: 'off_record', on: false });
  pending.resolve(done(output()));
  await r.advance(0);
  assert.equal(r.maps.lastBuilt()?.map.steps[0]?.goal, 'Keep the budget', 'the stale result was not used');
  await r.send(review);
  assert.equal(mapOf(r.cues).steps[0]?.goal, 'Keep the budget');
  assert.equal(r.enrichCalls.length, 1, 'no second job for the same map');

  // The map is built while the person goes off the record: nothing is started.
  const slow = deferred<TaskResult>();
  const calls: string[] = [];
  const late = new Conductor('sess-2', {
    now: () => 1_000_000, newId: () => 'abcdef0123456789', maps: new MapRegistry(),
    llm: async (task) => (task === 'map_synthesis' ? slow.promise : { ok: false, error: 'runner_error' }),
    enrich: async () => { calls.push('enrich'); return done(output()); },
  });
  let seq = 0;
  const feed = (...events: ClientEvent[]): void => late.handle(events.map((event) => ({ seq: ++seq, atMs: 0, event })), 'sess-2');
  feed(hello, learn(true), obs('o1', 'Changed.'));
  feed(learn(false));
  feed({ type: 'off_record', on: true });
  slow.resolve(ok(MAP));
  for (let i = 0; i < 8; i++) await new Promise((res) => setImmediate(res));
  assert.deepEqual(calls, [], 'built off the record: not enriched');
});

test('the session moved on: a new Show, or a map built anew, drops the running job and what it predicted', async () => {
  const pending = deferred<EnrichResult>();
  const r = rig({ map_synthesis: () => ok(MAP) }, () => pending.promise);
  await show(r);
  assert.equal(r.c.status().enrichment, 'running');
  await r.send(learn(true));
  assert.equal(r.enrichCalls[0]!.signal.aborted, true, 'a new Show supersedes the map the job was deepening');
  pending.resolve(done(output()));
  await r.advance(0);
  assert.equal(r.maps.lastBuilt()?.map.steps[0]?.goal, 'Keep the budget');
  assert.equal(r.c.status().predictions, 0);
});

test('the switch: with RULES.enrichMap off nothing is started and nothing changes; with no job dependency there is none either', async () => {
  const rules = RULES as { enrichMap: boolean };
  rules.enrichMap = false;
  try {
    const r = rig({ map_synthesis: () => ok(MAP) }, async () => done(output()));
    await show(r);
    await r.send(review);
    assert.equal(r.enrichCalls.length, 0);
    assert.equal(mapOf(r.cues).steps[0]?.goal, 'Keep the budget');
  } finally {
    rules.enrichMap = true;
  }
  assert.equal(RULES.enrichMap, true, 'on by default');
  const none = rig({ map_synthesis: () => ok(MAP) }, undefined);
  await show(none);
  await none.send(review);
  assert.equal(none.enrichCalls.length, 0);
  assert.equal(none.c.status().enrichment, 'idle');
});

test('a failed, invalid or throwing job leaves the map and the open points as they are', async () => {
  for (const enrich of [
    async (): Promise<EnrichResult> => ({ ok: false, error: 'runner_error' }),
    async (): Promise<EnrichResult> => { throw new Error('boom'); },
  ] as Enrich[]) {
    const r = rig({ map_synthesis: () => ok(MAP) }, enrich);
    await show(r);
    await r.send(review);
    await r.advance(RULES.pauseMs + 10);
    assert.equal(mapOf(r.cues).steps[0]?.goal, 'Keep the budget');
    assert.equal(cueOf(r.cues, 'ask').at(-1)?.text, 'Who is the lead?');
    assert.equal(r.c.status().enrichment, 'idle');
  }
});

test('an earlier or demo map is not deepened: it is not this session\'s own', async () => {
  const r = rig({}, async () => done(output()));
  await r.send(hello, review);
  assert.equal(r.enrichCalls.length, 0);
  assert.ok(of(r.cues, 'map').length >= 1);
});

test('confirmPrior reads the expert\'s earlier words back, short and without doubled punctuation; affirmSaid is a short reply that agrees and changes nothing', () => {
  assert.equal(confirmPrior('Only the lead releases it.'), 'Last time you said: "Only the lead releases it". Still true?');
  assert.equal(confirmPrior('  spaced \n out  words '), 'Last time you said: "spaced out words". Still true?');
  const long = `${'word '.repeat(60)}end`;
  const line = confirmPrior(long);
  assert.ok(line.length < 200 && line.includes('…"'), line);
  for (const yes of ['Yes.', 'Yes, still true.', 'Exactly.', 'Right, that is still so', 'ja genau', 'Да, верно', 'Sure, always.']) assert.equal(affirmSaid(yes), true, yes);
  for (const no of ['No.', 'Yes, but only in winter.', 'Not any more.', 'It changed.', 'Is it?', 'Yes, still true?', 'The finance lead decides everything these days now', '', 'Yes if the amount is small', "Yes, it isn't"]) assert.equal(affirmSaid(no), false, no);
});
