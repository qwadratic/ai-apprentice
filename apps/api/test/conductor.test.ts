import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, MapRegistry, RULES } from '../agent/conductor/engine.ts';
import { GUIDE, MAC_DONE_LINE, NUDGES, OFF_LINE, OPEN_WEB, PROPOSE, RESOLVED, SHOW_LOOKS_DONE, STAGE_ABOUT, STAGE_CONFIRM, STAGE_START, detectLanguage, doneSaid, offSaid, stageAsked, stageCommand, yesSaid } from '../agent/conductor/lines.ts';
import { demoMap } from '../agent/conductor/demo-map.ts';
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
  await r.send(obs('o2', 'Second change.', { surface: 'inbox' }));
  await r.send({ type: 'activity', state: 'pause' });
  await r.advance(RULES.pauseMs + 10);
  assert.equal(cueOf(r.cues, 'ask').at(-1)?.text, 'About o2');
});

test('Learn: a reworded frame of the same generic screen neither restarts the pause nor drops the prepared question', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.length, 1, 'prepared as soon as the screen settled');
  // The vision model rewords the same compose window on every frame, and the frames come faster than the pause.
  for (let i = 3; i < 8; i++) {
    await r.send(obs(`o${i}`, `Reworded ${i}.`));
    await r.advance(1200);
  }
  assert.equal(cueOf(r.cues, 'ask')[0]?.text, QUESTION.question, 'asked although reworded frames kept coming');
  // Another app is a new screen: it restarts the pause.
  await r.advance(RULES.learnMinGapMs); // the reworded frames after the first question bring a second one
  await r.advance(RULES.learnMinGapMs + RULES.askTtlMs); // its moment passes, and so does the gap
  const asked = of(r.cues, 'ask').length;
  await r.send(obs('o9', 'A sheet opened.', { app: 'Sheets', surface: 'budget sheet' }));
  await r.advance(RULES.pauseMs - 300);
  assert.equal(of(r.cues, 'ask').length, asked, 'not before the pause after a real screen change');
  await r.advance(400);
  assert.equal(of(r.cues, 'ask').length, asked + 1, 'asked once the pause after the new screen began');
});

test('the voice agent knows what Clipa sees: a new screen at once, the same screen at most every few seconds', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  const screen = () => cueOf(r.cues, 'context').filter((c) => c.text.startsWith('[screen]'));
  await r.send(obs('o0', null));
  assert.equal(screen().length, 0, 'nothing before a stage runs');
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null));
  assert.equal(screen().length, 1);
  assert.match(screen()[0]!.text, /^\[screen\] Mail: compose window\. Summary o1/);
  await r.send(obs('o2', null));
  assert.equal(screen().length, 1, 'the same screen reworded right away is not sent again');
  await r.advance(RULES.screenContextMs);
  await r.send(obs('o3', null));
  assert.equal(screen().length, 2, 'the same screen after the interval');
  await r.send(obs('o4', null, { app: 'Sheets', surface: 'budget sheet' }));
  assert.equal(screen().length, 3, 'a new screen at once');
  assert.match(screen()[2]!.text, /^\[screen\] Sheets: budget sheet\./);
  await r.send({ type: 'off_record', on: true }, obs('o5', null, { app: 'Maps', surface: 'map' }));
  assert.equal(screen().length, 3, 'nothing off the record');
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
  processes: [{ id: 'p1', title: 'Budget update', summary: 'Keeps the budget in bounds.' }],
  steps: [{ id: 's1', processId: 'p1', kind: 'judgment', goal: 'Keep the budget', action: 'Lowered it to 300', decision: { summary: 'Keep 300', reason: 'sign-off above', quote: 'above 300 the lead signs', quoteAtMs: 5 }, evidenceIds: ['o2'] }],
  guardrails: [{ id: 'g1', processId: 'p1', condition: 'budget above 300', requiredAction: 'ask the lead', reason: 'sign-off', quote: 'above 300 the lead signs', quoteAtMs: 5, escalateTo: 'the lead', exceptions: [], evidenceIds: ['o2'] }],
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
  assert.equal(cueOf(r.cues, 'context').filter((c) => !c.text.startsWith('[stage]')).length, 0, 'no learned workflow is sent to voice before screen recognition');
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

test('Show ends: the map is built in the background, so Reflect opens with it ready; a failed build is built again on Reflect', async () => {
  const r = rig({ map_synthesis: () => ok(MAP) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  assert.deepEqual(r.calls.map((c) => c.task), ['map_synthesis'], 'built as soon as Show ends');
  assert.equal(of(r.cues, 'map').length, 0, 'not shown before Reflect');
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(r.calls.length, 1, 'Reflect uses the map built in the background');
  assert.equal(of(r.cues, 'map').length, 1);
  assert.equal(cueOf(r.cues, 'guide').at(-1)?.step, 'gaps');

  // The background build throws (a crash on a live server if it went unhandled): Reflect builds the map itself.
  let attempt = 0;
  const f = rig({ map_synthesis: () => { attempt++; if (attempt === 1) throw new Error('runner down'); return ok(MAP); } });
  await f.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await f.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  await f.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.deepEqual(f.calls.map((c) => c.task), ['map_synthesis', 'map_synthesis']);
  assert.equal(of(f.cues, 'map').length, 1);
});

test('Review asks at most three open points, then reads the teach-back', async () => {
  assert.equal(RULES.reviewMaxGaps, 3, 'the brief asks for at least three follow-ups in the debrief');
  const gaps = ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?', 'What if the lead is away?'].map((question) => ({ question, targetId: null, evidenceIds: [], regionIds: [] }));
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps }), map_edit: () => ok(NO_EDIT) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  for (const answer of ['The team lead.', 'Yes, hard.', 'The finance director.']) {
    await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
    await r.send({ type: 'transcript', role: 'expert', text: answer });
  }
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  assert.deepEqual(cueOf(r.cues, 'ask').map((a) => a.text), ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?']);
  assert.equal(of(r.cues, 'teachback').length, 1);
});

test('Review: an answer that resolves its open point does not make Clipa skip the next one', async () => {
  const gaps = ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?'].map((question) => ({ question, targetId: null, evidenceIds: [], regionIds: [] }));
  // Each answer resolves the point just asked, which is the first one left: the list gets shorter under Clipa.
  const resolve = { intent: 'edit', operations: [{ op: 'resolve_gap', targetId: 'gap-1', field: null, value: null, value2: null, quote: null }], reply: '', teachBack: null };
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps }), map_edit: () => ok(resolve) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  for (const answer of ['The team lead.', 'Yes, hard.', 'The finance director.']) {
    await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
    await r.send({ type: 'transcript', role: 'expert', text: answer });
  }
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  assert.deepEqual(cueOf(r.cues, 'ask').map((a) => a.text), ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?'], 'all three, in order');
  assert.equal(of(r.cues, 'teachback').length, 1, 'then the teach-back');
  assert.equal((cueOf(r.cues, 'map').at(-1)?.map as ConductorMap).gaps.length, 0, 'every answer resolved its point');
});

test('Review: a point the person picked on the board counts as asked; Clipa asks the others, up to three, then the teach-back', async () => {
  const gaps = ['Who is the lead?', 'Is 300 a hard limit?', 'Who decides above it?', 'What if the lead is away?'].map((question) => ({ question, targetId: null, evidenceIds: [], regionIds: [] }));
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps }), map_edit: () => ok(NO_EDIT) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  await r.send({ type: 'ui', action: 'answer_gap', targetId: 'gap-3', text: null });
  assert.deepEqual(cueOf(r.cues, 'ask').map((a) => a.text), ['Who decides above it?']);
  for (const answer of ['The finance director.', 'The team lead.', 'Yes, hard.']) {
    await r.send({ type: 'transcript', role: 'expert', text: answer });
    await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs);
  }
  assert.deepEqual(cueOf(r.cues, 'ask').map((a) => a.text), ['Who decides above it?', 'Who is the lead?', 'Is 300 a hard limit?']);
  assert.equal(of(r.cues, 'teachback').length, 1);
});

const TWO = {
  processes: [{ id: 'p1', title: 'Budget update', summary: 'Keeps the budget in bounds.' }, { id: 'p2', title: 'Supplier check', summary: 'Checks a new supplier.' }],
  steps: [MAP.steps[0], { id: 's2', processId: 'p2', kind: 'action', goal: 'Check the supplier', action: 'Opened the contract', decision: null, evidenceIds: ['o3'] }],
  guardrails: [MAP.guardrails[0], { id: 'g2', processId: 'p2', condition: 'a new supplier', requiredAction: 'check the contract first', reason: null, quote: null, quoteAtMs: null, escalateTo: null, exceptions: [], evidenceIds: ['o3'] },
    { id: 'g3', processId: null, condition: 'an unclear case', requiredAction: 'ask the expert', reason: null, quote: null, quoteAtMs: null, escalateTo: null, exceptions: [], evidenceIds: [] }],
  gaps: [],
  teachBack: 'Two tasks. Is this right?',
};

test('the library lists every learned process; a rule that names no process is kept with the first one', () => {
  const maps = new MapRegistry();
  maps.confirm('older', MAP as never, 1);
  maps.confirm('expert-session', TWO as never, 2);
  const lib = maps.library('expert-session');
  assert.deepEqual(lib.map((p) => [p.key, p.title, p.steps, p.rules.map((x) => x.id)]), [
    ['m1-p1', 'Budget update', ['Lowered it to 300'], ['g1', 'g3']],
    ['m1-p2', 'Supplier check', ['Opened the contract'], ['g2']],
    ['m2-p1', 'Budget update', ['Lowered it to 300'], ['m2-g1']],
  ]);
  // A map from before processes existed is one process named after its first step.
  const old = new MapRegistry();
  old.confirm('s', { ...MAP, processes: undefined, steps: [{ ...MAP.steps[0], processId: undefined }] } as never, 1);
  assert.deepEqual(old.library().map((p) => [p.title, p.rules.length]), [['Keep the budget', 1]]);
});

test('Pass it on: Clipa recognises the process on screen silently (a thought, no announcement), and checks its rules first', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', TWO as never, 1);
  const r = rig({
    process_match: () => ok({ processId: 'm1-p2', confidence: 0.9 }),
    guardrail_check: () => ok({ status: 'clear', guardrailId: null, message: null, regionIds: [] }),
  }, maps, 'hire-1');
  await r.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null });
  await r.send(obs('n1', 'A contract is open.'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.at(-1)?.task, 'process_match');
  const offered = r.calls.at(-1)?.body.processes as Array<{ id: string; title: string }>;
  assert.deepEqual(offered.map((p) => [p.id, p.title]), [['m1-p1', 'Budget update'], ['m1-p2', 'Supplier check']]);
  assert.equal(of(r.cues, 'say').length, 0, 'never while the person works');
  await r.advance(RULES.pauseMs);
  assert.equal(of(r.cues, 'say').length, 0, 'no "This is X, I will step in" announcement, not even at a pause');
  await r.advance(RULES.teachCheckGapMs);
  const checked = r.calls.filter((c) => c.task === 'guardrail_check').at(-1)?.body.guardrails as Array<{ id: string; condition: string }>;
  assert.deepEqual(checked.map((g) => g.id), ['g2', 'g1', 'g3'], 'the recognised process first');
  assert.equal(checked[0]?.condition, '[Supplier check] a new supplier');
  await r.send(obs('n2', 'The same contract, scrolled.'));
  await r.advance(RULES.pauseMs + 10);
  assert.equal(r.calls.filter((c) => c.task === 'process_match').length, 1, 'the same app and surface is not recognised again');
});

test('process_match failing or unsure is silent; Learn with a known process asks only about what is different', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', TWO as never, 1);
  for (const answer of [(): TaskResult => { throw new Error('runner down'); }, (): TaskResult => ({ ok: false, error: 'runner_timeout' }), (): TaskResult => ok({ processId: 'm1-p1', confidence: 0.4 })]) {
    const r = rig({ process_match: answer }, maps, 'hire-x');
    await r.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, obs('n1', 'Opened.'));
    await r.advance(RULES.settleMs + 10);
    await r.advance(RULES.pauseMs);
    assert.equal(of(r.cues, 'say').length, 0);
    assert.equal(r.calls.filter((c) => c.task === 'process_match').length, 1);
  }
  const l = rig({ process_match: () => ok({ processId: 'm1-p1', confidence: 0.9 }), generic_question: () => ok(QUESTION) }, maps, 'expert-2');
  await l.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'The recipient changed.'));
  await l.advance(RULES.settleMs + 10);
  assert.equal(l.calls.at(-1)?.task, 'process_match');
  await l.advance(RULES.pauseMs);
  assert.equal(of(l.cues, 'say').length, 0, 'no "I know this one" announcement');
  await l.advance(RULES.settleMs + 10);
  const question = l.calls.find((c) => c.task === 'generic_question');
  const transcript = question?.body.transcript as Array<{ role: string; text: string }>;
  assert.match(transcript[0]?.text ?? '', /^\[known process from an earlier session\] Budget update\./);
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


test('routes: status authenticates the session and exposes the current baseline without transcript text', async (t) => {
  const h = await start(t);
  const session = await issue(h.base);
  const other = await issue(h.base);
  const url = `${h.base}/api/agent/conductor/${session.sessionId}/status`;
  const headers = { Origin: ORIGIN, ...bearer(session.token) };
  assert.equal((await fetch(url, { headers: { Origin: ORIGIN } })).status, 401);
  assert.equal((await fetch(url, { headers: { Origin: ORIGIN, ...bearer(other.token) } })).status, 401);
  assert.equal((await fetch(url, { headers: { Origin: 'https://evil.example', ...bearer(session.token) } })).status, 403);
  const initial = await fetch(url, { headers });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const initialBody = await initial.json() as { ok: boolean; status: { baseline: { status: string } } };
  assert.equal(initialBody.ok, true);
  assert.equal(initialBody.status.baseline.status, 'empty');
  for (const id of ['g1', 'g2']) h.agent.observeScreen(session.sessionId, {
    id, kind: 'screen_activity', timestampMs: 1000, evidenceIds: [`ev-${id}`],
    facts: { app: 'Gmail', surface: 'compose', summary: 'Synthetic customer invoice reply', change: null, pendingAction: null, regions: [] },
  });
  const read = async () => {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    return await response.json() as { status: { baseline: { status: string; appId: string | null; profileId: string | null; evidence: { observationIds: string[] } } } };
  };
  const candidate = (await read()).status.baseline;
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.appId, 'gmail');
  assert.equal(candidate.profileId, 'baseline.gmail-ticket-reply');
  assert.deepEqual(candidate.evidence.observationIds, ['g1', 'g2']);
  h.agent.observeScreen(session.sessionId, {
    id: 'unknown', kind: 'screen_activity', timestampMs: 1100, evidenceIds: ['ev-unknown'],
    facts: { app: null, surface: 'unknown', summary: 'Unknown workspace', change: null, pendingAction: null, regions: [] },
  });
  const suspended = (await read()).status.baseline;
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.appId, null);
  assert.equal(suspended.profileId, null);
});

// ---- Clipa feels alive: thoughts, attention, nudges, stages by voice ------------------------------------------------
/** Runs `fn` with some RULES switches changed, then puts them back. */
async function withRules(patch: Partial<Record<keyof typeof RULES, unknown>>, fn: () => Promise<void>): Promise<void> {
  const rules = RULES as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, rules[k]]));
  Object.assign(rules, patch);
  try { await fn(); } finally { Object.assign(rules, saved); }
}
const nudgesOf = (cues: CueEnvelope[]) => cueOf(cues, 'say').map((s) => s.text).filter((t) => NUDGES.includes(t));

test('thoughts: a new screen and a question being prepared show short thoughts, one per gap, to the web only', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null));
  assert.deepEqual(cueOf(r.cues, 'thought').map((t) => t.text), ['Looking at Mail: compose window']);
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.at(-1)?.task, 'generic_question');
  assert.equal(of(r.cues, 'thought').length, 1, 'the thought about the question waits for the gap');
  await r.advance(RULES.thoughtGapMs);
  const thoughts = of(r.cues, 'thought');
  assert.deepEqual(thoughts.map((t) => (t.cue as { text: string }).text), ['Looking at Mail: compose window', 'Hmm… what happens on compose window?']);
  assert.ok(thoughts.every((t) => t.for === 'web'), 'web only for now');
  assert.ok(thoughts[1]!.atMs - thoughts[0]!.atMs >= RULES.thoughtGapMs, 'throttled');
  // A long app name is cut to a short line.
  await r.advance(RULES.thoughtGapMs);
  await r.send(obs('o2', null, { app: 'A very long application name that goes on', surface: 'and an even longer surface title here' }));
  const long = cueOf(r.cues, 'thought').at(-1)!.text;
  assert.ok(long.startsWith('Looking at A very long') && long.length <= RULES.thoughtMaxChars && long.endsWith('…'));
});

test('thoughts: never off the record, none for a Mac-only session, and the switch turns them off', async () => {
  const r = rig({});
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'off_record', on: true }, obs('o1', 'Secret change.'));
  await r.advance(RULES.thoughtGapMs * 2);
  assert.equal(of(r.cues, 'thought').length, 0);
  const mac = rig({}, new MapRegistry(), 'mac-1');
  await mac.send(hello('macos'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null));
  assert.equal(of(mac.cues, 'thought').length, 0, 'the Mac does not render thoughts yet');
  await withRules({ thoughts: false }, async () => {
    const off = rig({});
    await off.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null));
    assert.equal(of(off.cues, 'thought').length, 0);
  });
});

test('thoughts: the map being built, a recognised process and a guardrail check', async () => {
  const r = rig({ map_synthesis: () => ok(MAP) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.advance(RULES.thoughtGapMs);
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  await r.advance(RULES.thoughtGapMs);
  assert.equal(cueOf(r.cues, 'thought').at(-1)?.text, 'Putting your map together…');
  const maps = new MapRegistry();
  maps.confirm('expert-session', TWO as never, 1);
  const t = rig({
    process_match: () => ok({ processId: 'm1-p2', confidence: 0.9 }),
    guardrail_check: () => ok({ status: 'clear', guardrailId: null, message: null, regionIds: [] }),
  }, maps, 'hire-1');
  await t.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, obs('n1', 'A contract is open.'));
  await t.advance(RULES.settleMs + 10);
  await t.advance(RULES.thoughtGapMs);
  assert.ok(cueOf(t.cues, 'thought').some((x) => x.text === 'This looks like Supplier check'), 'recognition keeps its thought');
  // Recognition says nothing, so the rules are checked at the first pause (no announcement takes it any more).
  await t.advance(RULES.thoughtGapMs);
  assert.ok(cueOf(t.cues, 'thought').some((x) => x.text.startsWith('Checking: a new supplier')));
  assert.equal(of(t.cues, 'say').length, 0);
  const poses = cueOf(t.cues, 'state').map((s) => s.clipa);
  assert.ok(poses.includes('think') && poses.at(-1) === 'listen', 'think while a model task works, then listen');
});

test('attention: an ask about a region, a warning and the next stage make Clipa flash and go there (web only)', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.advance(RULES.pauseMs + 10);
  const seq = r.cues.map((c) => c.cue.type).filter((x) => x === 'point' || x === 'attention' || x === 'ask');
  assert.deepEqual(seq, ['point', 'attention', 'ask']);
  const att = cueOf(r.cues, 'attention')[0];
  assert.ok(att?.target?.kind === 'region' && att.target.regionId === 'r-to');
  assert.equal(of(r.cues, 'attention')[0]?.for, 'web');
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' });
  const next = cueOf(r.cues, 'attention').at(-1);
  assert.ok(next?.target?.kind === 'ui' && next.target.name === 'mode_tab' && next.target.mode === 'review', 'the next stage');
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const t = rig({ guardrail_check: () => ok({ status: 'warn', guardrailId: 'g1', message: 'Your lead would stop here. Why?', regionIds: ['r-to'] }) }, maps, 'hire-1');
  await t.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, obs('n1', 'Budget set to 450.', { pendingAction: 'Submit' }));
  await t.advance(RULES.urgentSettleMs + 10);
  const warnAtt = cueOf(t.cues, 'attention').at(-1);
  assert.ok(of(t.cues, 'warn').length === 1 && warnAtt?.target?.kind === 'region' && warnAtt.target.regionId === 'r-to');
  await withRules({ attention: false }, async () => {
    const off = rig({ generic_question: () => ok(QUESTION) });
    await off.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
    await off.advance(RULES.pauseMs + 10);
    assert.ok(of(off.cues, 'ask').length === 1 && of(off.cues, 'attention').length === 0);
  });
});

test('poses: Clipa listens while the person talks and speaks while the voice agent speaks', async () => {
  const r = rig({});
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null });
  await r.send({ type: 'talking', by: 'person', active: true });
  assert.equal(cueOf(r.cues, 'state').at(-1)?.clipa, 'listen');
  await r.send({ type: 'talking', by: 'person', active: false }, { type: 'talking', by: 'agent', active: true });
  assert.equal(cueOf(r.cues, 'state').at(-1)?.clipa, 'speak');
});

test('nudges: after 20 s of silence in Show, a gentle line in turn; at most two in a row, talking resets the count', async () => {
  assert.deepEqual([RULES.nudgeAfterMs, RULES.nudgeMaxInRow, RULES.learnMinGapMs], [20_000, 2, 20_000], 'less nagging');
  const r = rig({});
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null });
  await r.advance(RULES.nudgeAfterMs - 100);
  assert.deepEqual(nudgesOf(r.cues), [], 'not before 20 s');
  await r.advance(200);
  assert.deepEqual(nudgesOf(r.cues), [NUDGES[0]]);
  await r.advance(RULES.nudgeAfterMs - 200);
  assert.equal(nudgesOf(r.cues).length, 1, 'never within 20 s after a say');
  await r.advance(300);
  assert.deepEqual(nudgesOf(r.cues), [NUDGES[0], NUDGES[1]]);
  await r.advance(RULES.nudgeAfterMs * 3);
  assert.equal(nudgesOf(r.cues).length, RULES.nudgeMaxInRow, 'at most two in a row without the person talking');
  await r.send({ type: 'talking', by: 'person', active: true }, { type: 'talking', by: 'person', active: false });
  await r.advance(RULES.nudgeAfterMs + 100);
  assert.deepEqual(nudgesOf(r.cues).at(-1), NUDGES[2], 'talking resets the count');
  // Typing holds the nudge: the 20 s count from the last key press.
  await r.send({ type: 'activity', state: 'typing' });
  await r.advance(RULES.nudgeAfterMs * 2);
  assert.equal(nudgesOf(r.cues).length, 3, 'not while the person types');
  await r.send({ type: 'activity', state: 'idle' });
  await r.advance(RULES.nudgeAfterMs - 500);
  assert.equal(nudgesOf(r.cues).length, 3);
});

test('nudges: never within 10 s after an ask, not in Review, not off the record, not before a stage runs', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.advance(RULES.pauseMs + 10);
  const ask = of(r.cues, 'ask')[0]!;
  await r.send({ type: 'cue_done', cueId: ask.cueId, outcome: 'spoken' });
  await r.advance(RULES.nudgeAfterMs - 300);
  assert.equal(nudgesOf(r.cues).length, 0, 'not within 10 s after the ask');
  await r.advance(400);
  assert.equal(nudgesOf(r.cues).length, 1);
  const idle = rig({});
  await idle.send(hello('web'));
  await idle.advance(RULES.nudgeAfterMs * 3);
  assert.equal(nudgesOf(idle.cues).length, 0, 'not before a stage runs');
  const review = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) });
  await review.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  await review.advance(RULES.nudgeAfterMs * 3);
  assert.equal(nudgesOf(review.cues).length, 0, 'not in Review');
  const off = rig({});
  await off.send(hello('web'), { type: 'session', mode: 'teach', live: true, reason: null }, { type: 'off_record', on: true });
  await off.advance(RULES.nudgeAfterMs * 3);
  assert.equal(nudgesOf(off.cues).length, 0, 'not off the record');
  await withRules({ nudges: false }, async () => {
    const quiet = rig({});
    await quiet.send(hello('web'), { type: 'session', mode: 'teach', live: true, reason: null });
    await quiet.advance(RULES.nudgeAfterMs * 3);
    assert.equal(nudgesOf(quiet.cues).length, 0);
  });
});

test('stage phrases: explicit phrases in English, Russian and German, whole words near the start of the turn', () => {
  const cases: Array<[string, string | null]> = [
    ['Okay, let’s review.', 'review'], ["Let's review what you saw", 'review'], ['LET US REVIEW', 'review'],
    ['Давай проверим', 'review'], ['Gut, lass uns prüfen.', 'review'],
    ['Let me show you how I do it', 'learn'], ["I'll show you", 'learn'], ['Сейчас покажу', 'learn'], ['Ich zeig dir das', 'learn'],
    ['Now teach me', 'teach'], ['Научи меня', 'teach'], ['Bring es mir bei', 'teach'],
    // Normal sentences: no switch.
    ['My boss used to teach me this every December', null], ['We review every email before sending it', null],
    ['I showed you the order table', null], ['Он хочет научиться', null], ['Показываю адрес', null], ['preview the email', null],
  ];
  for (const [text, mode] of cases) assert.equal(stageAsked(text), mode, text);
});

test('stage by voice: a clear request starts that stage on the web after a short spoken line; with no session it only opens it', async () => {
  const r = rig({});
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null });
  await r.send({ type: 'transcript', role: 'expert', text: 'I copy the address into the email body.' });
  assert.equal(of(r.cues, 'stage').length, 0, 'a normal sentence does not switch');
  await r.send({ type: 'transcript', role: 'expert', text: 'Let me show you the next one.' });
  assert.equal(of(r.cues, 'stage').length, 0, 'Show is already live');
  await r.send({ type: 'transcript', role: 'expert', text: 'Okay, let’s review.' });
  assert.equal(of(r.cues, 'stage').length, 0, 'first the short line');
  const line = of(r.cues, 'say').at(-1)!;
  assert.ok(line.cue.type === 'say' && line.cue.text === STAGE_START.review && line.for === 'web');
  await r.send({ type: 'cue_done', cueId: line.cueId, outcome: 'spoken' });
  const stage = of(r.cues, 'stage')[0];
  assert.ok(stage?.cue.type === 'stage' && stage.cue.mode === 'review' && stage.cue.start === true && stage.for === 'web', 'the web starts Reflect');
  // No session runs: the web opens the stage like a click and Clipa says to press Start.
  const idle = rig({});
  await idle.send(hello('web'), { type: 'transcript', role: 'expert', text: 'Teach me' });
  const open = cueOf(idle.cues, 'stage')[0];
  assert.ok(open?.mode === 'teach' && open.start === undefined);
  assert.equal(cueOf(idle.cues, 'say').at(-1)?.text, STAGE_CONFIRM.teach);
  await r.send({ type: 'off_record', on: true }, { type: 'transcript', role: 'expert', text: 'Teach me' });
  assert.equal(of(r.cues, 'stage').length, 1, 'never off the record');
  await withRules({ voiceStages: false }, async () => {
    const off = rig({});
    await off.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'transcript', role: 'expert', text: 'Teach me' });
    assert.equal(of(off.cues, 'stage').length, 0);
  });
  const mac = rig({}, new MapRegistry(), 'mac-1');
  await mac.send(hello('macos'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'transcript', role: 'expert', text: "Let's review" });
  assert.equal(of(mac.cues, 'stage').length, 0, 'the Mac has no stages to open');
});

test('stage by voice in Review: the request is not taken as a map edit', async () => {
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }), map_edit: () => ok(NO_EDIT), reply_classification: () => ok({ verdict: 'unclear', correction: null }) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  const calls = r.calls.length;
  await r.send({ type: 'transcript', role: 'expert', text: 'Научи меня' });
  assert.equal(r.calls.length, calls, 'no reply classification and no map edit');
  await r.advance(RULES.lineBeforeSwitchMs);
  assert.ok(of(r.cues, 'stage').some((s) => s.cue.type === 'stage' && s.cue.mode === 'teach' && s.cue.start === true), 'started once the line had its time');
});

// ---- the flow between stages: voice control and "Lead me through" -------------------------------------------------
const said = (cues: CueEnvelope[]) => cueOf(cues, 'say').map((x) => x.text);
const stages = (cues: CueEnvelope[]) => cueOf(cues, 'stage').map((x) => `${x.mode}${x.start ? ' start' : ''}`);
const lastSay = (cues: CueEnvelope[]) => of(cues, 'say').at(-1)!;
const SHOW = (): ClientEvent[] => [hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'share', state: 'capturing', reason: null }];
const turn = (text: string): ClientEvent => ({ type: 'transcript', role: 'expert', text });

test('done, off and yes phrases: short final turns only, in English, Russian and German', () => {
  const done = ["That's it.", 'Okay, I’m done.', 'done', 'All done!', 'Finished.', "That's all for now", 'So I think that is it', 'Готово.', 'Это всё.', 'Ну всё', 'Вот и все', 'Всё', 'Ну, вот, всё', 'Я закончила', 'Fertig!', "Das war's", 'das ist alles'];
  for (const t of done) assert.equal(doneSaid(t), true, t);
  const notDone = ["I've done the terms for Lumen", "I've done the terms", "That's it for the address", 'Done with the order table, now the email', 'Я скопировал это всё', 'Всё письмо готово к отправке сейчас вот', 'все клиенты', 'We are finished with step one and move on to two', ''];
  for (const t of notDone) assert.equal(doneSaid(t), false, t);
  for (const t of ['Stop.', 'Okay, stop listening', 'Turn off please', 'Goodbye!', 'Стоп', 'Хватит', 'Клипа, выключись', 'Пока', 'Tschüss', 'Hör auf']) assert.equal(offSaid(t), true, t);
  for (const t of ['Stop the timer', 'Bye the way, the address', 'Пока нет', 'I will stop here and explain', 'off']) assert.equal(offSaid(t), false, t);
  for (const t of ['Yes.', 'Yeah, sure', "Okay, let's go", 'Go ahead', 'Да, давай', 'Поехали', 'Ja, gerne', 'Los']) assert.equal(yesSaid(t), true, t);
  for (const t of ['Yes, but the address is wrong', 'Да нет', 'Okay stop']) assert.equal(yesSaid(t), false, t);
});

test('done in Show: a short line, then the web starts Reflect; the end of Show says no extra line and the map is built', async () => {
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) });
  await r.send(...SHOW(), obs('o1', 'Changed.'));
  await r.send(turn("I've done the terms for Lumen"));
  assert.deepEqual(stages(r.cues), [], 'a sentence with "done" in it does not end Show');
  assert.ok(!said(r.cues).includes(STAGE_START.review));
  await r.send(turn("Okay, that's it."));
  assert.equal(lastSay(r.cues).cue.type === 'say' && (lastSay(r.cues).cue as { text: string }).text, STAGE_START.review);
  assert.deepEqual(stages(r.cues), [], 'the line is said first');
  await r.send({ type: 'cue_done', cueId: lastSay(r.cues).cueId, outcome: 'spoken' });
  assert.deepEqual(stages(r.cues), ['review start']);
  assert.equal(of(r.cues, 'stage')[0]?.for, 'web');
  const guides = cueOf(r.cues, 'guide').length;
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' });
  assert.equal(cueOf(r.cues, 'guide').length, guides, 'no "open Reflect" line: Reflect is starting');
  assert.ok(r.calls.some((c) => c.task === 'map_synthesis'), 'the map is built in the background');
  await r.send({ type: 'session', mode: 'review', live: true, reason: null });
  assert.ok(cueOf(r.cues, 'context').some((c) => c.text === `[stage] Now in Reflect: ${STAGE_ABOUT.review}`), 'the voice agent knows the stage');
  assert.ok(cueOf(r.cues, 'context').some((c) => c.text === '[stage] Show has ended.'));
});

test('done in Show on macOS: a short line, no new cue types; the hand-over to the web follows at the Mac\'s End', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) }, new MapRegistry(), 'mac-1');
  await r.send(hello('macos'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send(turn('Fertig.'));
  assert.equal(said(r.cues).at(-1), MAC_DONE_LINE);
  assert.equal(of(r.cues, 'say').at(-1)?.for, 'macos');
  assert.equal(cueOf(r.cues, 'open_web').length, 0, 'the Mac finishes Show on open_web only while it is ending');
  await r.send(obs('o2', 'The recipient changed.'));
  await r.advance(RULES.learnMinGapMs + RULES.pauseMs);
  assert.equal(of(r.cues, 'ask').length, 0, 'no more questions after done');
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' });
  assert.equal(cueOf(r.cues, 'open_web')[0]?.page, 'review', 'End still hands over');
  assert.equal(of(r.cues, 'stage').length + of(r.cues, 'end').length, 0);
  assert.ok(r.cues.every((c) => c.for !== 'web'));
  // A web page that joined the Mac's session does not turn the Mac's turns into web commands.
  const joined = rig({}, new MapRegistry(), 'mac-2');
  await joined.send(hello('macos'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await joined.sendFrom('web-1', hello('web'));
  await joined.send(turn('Stop.'), turn("That's it."));
  assert.ok(!said(joined.cues).includes(OFF_LINE) && of(joined.cues, 'end').length === 0);
  assert.equal(said(joined.cues).at(-1), MAC_DONE_LINE);
});

test('done in Pass it on: the summary is said, then the session ends', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const r = rig({}, maps, 'hire-1');
  await r.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null });
  await r.send(turn('Готово'));
  const summary = of(r.cues, 'guide').at(-1)!;
  assert.ok(summary.cue.type === 'guide' && summary.cue.step === 'summary');
  assert.equal(of(r.cues, 'end').length, 0, 'not before the summary is said');
  await r.send({ type: 'cue_done', cueId: summary.cueId, outcome: 'spoken' });
  assert.deepEqual(cueOf(r.cues, 'end'), [{ type: 'end', reason: 'done' }]);
  const guides = of(r.cues, 'guide').length;
  await r.send({ type: 'session', mode: 'teach', live: false, reason: 'ended' });
  assert.equal(of(r.cues, 'guide').length, guides, 'the summary is not repeated');
});

test('off: "stop" says one short line, then ends the session; nothing else happens to that turn', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(...SHOW());
  const calls = r.calls.length;
  await r.send(turn('Stop.'));
  assert.equal((lastSay(r.cues).cue as { text: string }).text, OFF_LINE);
  await r.advance(RULES.lineBeforeSwitchMs - 100);
  assert.equal(of(r.cues, 'end').length, 0);
  await r.advance(200);
  assert.deepEqual(cueOf(r.cues, 'end'), [{ type: 'end', reason: 'off' }], 'at the latest after the line had its time');
  assert.equal(of(r.cues, 'end')[0]?.for, 'web');
  assert.equal(r.calls.length, calls);
  const guides = cueOf(r.cues, 'guide').length;
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' });
  assert.equal(cueOf(r.cues, 'guide').length, guides, 'no "open Reflect" line after she switched off');
  await r.advance(RULES.nudgeAfterMs * 3);
  assert.equal(nudgesOf(r.cues).length, 0);
});

test('auto on: a long quiet after real work ends Show and starts Reflect; nudges stop once she moves on', async () => {
  const r = rig({});
  await r.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
  await r.advance(RULES.showIdleMs - 1000);
  assert.ok(!said(r.cues).includes(SHOW_LOOKS_DONE), 'not before 30 s of quiet');
  await r.advance(1100);
  assert.equal(said(r.cues).at(-1), SHOW_LOOKS_DONE);
  const nudges = nudgesOf(r.cues).length;
  await r.advance(RULES.lineBeforeSwitchMs);
  assert.deepEqual(stages(r.cues), ['review start']);
  await r.advance(RULES.nudgeAfterMs * 2);
  assert.equal(nudgesOf(r.cues).length, nudges, 'no nudge after Show is complete');
  // Too little to learn from: Show does not end on its own.
  const early = rig({});
  await early.send(...SHOW(), obs('o1', null));
  await early.advance(RULES.showIdleMs * 2);
  assert.ok(!said(early.cues).includes(SHOW_LOOKS_DONE));
  await withRules({ autoAdvance: false }, async () => {
    const off = rig({});
    await off.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
    await off.advance(RULES.showIdleMs * 2);
    assert.ok(!said(off.cues).includes(SHOW_LOOKS_DONE) && stages(off.cues).length === 0, 'the switch turns it off');
  });
});

test('auto on: once the map is confirmed, the handoff line, about 5 s, then the Pass it on tab opens (the new hire starts it)', async () => {
  const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) });
  await r.send(...SHOW(), obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' }, { type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(of(r.cues, 'teachback').length, 1);
  await r.send({ type: 'ui', action: 'confirm', targetId: null, text: null });
  const handoff = of(r.cues, 'guide').at(-1)!;
  assert.ok(handoff.cue.type === 'guide' && handoff.cue.step === 'handoff');
  await r.advance(RULES.afterHandoffMs);
  assert.deepEqual(stages(r.cues), [], 'waits for the handoff line');
  await r.send({ type: 'cue_done', cueId: handoff.cueId, outcome: 'spoken' });
  await r.advance(RULES.afterHandoffMs - 100);
  assert.deepEqual(stages(r.cues), []);
  await r.advance(200);
  assert.deepEqual(stages(r.cues), ['teach'], 'opened, not started: a new person takes over there');
});

test('a waiting switch: End drops it, a new Start replaces it, and the person going on cancels one Clipa decided on herself', async () => {
  // SHOW_LOOKS_DONE, then the person presses End during the line: no session starts by itself.
  const ended = rig({});
  await ended.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
  await ended.advance(RULES.showIdleMs + 100);
  assert.equal(said(ended.cues).at(-1), SHOW_LOOKS_DONE);
  await ended.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' });
  await ended.advance(RULES.lineBeforeSwitchMs + 100);
  assert.deepEqual(stages(ended.cues), []);
  // "That's it", then End: the same.
  const done = rig({});
  await done.send(...SHOW(), obs('o1', 'Changed.'), turn("That's it."));
  await done.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' });
  await done.advance(RULES.lineBeforeSwitchMs + 100);
  assert.deepEqual(stages(done.cues), []);
  // The person talks, types or changes the screen while Clipa says she moves on: she stays.
  for (const goOn of [{ type: 'talking', by: 'person', active: true } as ClientEvent, { type: 'activity', state: 'typing' } as ClientEvent, obs('o4', 'Typed more of the address.')]) {
    const r = rig({});
    await r.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
    await r.advance(RULES.showIdleMs + 100);
    assert.equal(said(r.cues).at(-1), SHOW_LOOKS_DONE);
    await r.send(goOn);
    await r.advance(RULES.lineBeforeSwitchMs + 100);
    assert.deepEqual(stages(r.cues), [], JSON.stringify(goOn));
  }
  // Turning "Lead me through" off while the line plays cancels the switch too.
  const off = rig({});
  await off.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
  await off.advance(RULES.showIdleMs + 100);
  await off.send({ type: 'auto', on: false });
  await off.advance(RULES.lineBeforeSwitchMs + 100);
  assert.deepEqual(stages(off.cues), []);
  // Edits on the same surface keep Show going; a second Show needs real work of its own.
  const edits = rig({});
  await edits.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
  for (let i = 0; i < 8; i++) { await edits.advance(5_000); await edits.send(obs(`e${i}`, 'Typed more of the delivery address.')); }
  assert.ok(!said(edits.cues).includes(SHOW_LOOKS_DONE), 'the person keeps working');
  const again = rig({});
  await again.send(...SHOW(), obs('o1', null), obs('o2', null), obs('o3', null));
  await again.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' }, { type: 'session', mode: 'learn', live: true, reason: null });
  await again.advance(RULES.showIdleMs * 2);
  assert.ok(!said(again.cues).includes(SHOW_LOOKS_DONE), 'nothing shown in this Show yet');
});

test('answers are not commands: "that\'s it" after a question, stage phrases inside sentences, and moves backwards', async () => {
  for (const t of ["Yes, that's it.", 'Exactly, that is it.', 'Right, done.', 'Да, это всё.', 'Ja, das ist alles.', "That's it?", 'Done?', 'Готово?']) assert.equal(doneSaid(t), false, t);
  for (const t of ['Ich bin fertig.', "I'm finished", "We're done."]) assert.equal(doneSaid(t), true, t);
  // An answer to Clipa's question that ends with the phrase does not end Show; the bare phrase does.
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(...SHOW(), obs('o1', null), obs('o2', 'The recipient changed.'));
  await r.advance(RULES.pauseMs + 10);
  const ask = of(r.cues, 'ask')[0]!;
  await r.send({ type: 'cue_done', cueId: ask.cueId, outcome: 'spoken' });
  await r.send(turn("The finance lead, that's it."));
  assert.ok(!said(r.cues).includes(STAGE_START.review), 'an answer, not the end of Show');
  await r.send(turn("That's it."));
  assert.equal(said(r.cues).at(-1), STAGE_START.review);
  // While a session runs, only a whole short command that moves forward starts a stage.
  assert.equal(stageCommand('Let me show you: only customer_07 wants it as text.'), null);
  assert.equal(stageCommand('Давай проверим адрес доставки.'), null);
  assert.equal(stageCommand("Okay, let's review."), 'review');
  const reflect = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }), map_edit: () => ok(NO_EDIT), reply_classification: () => ok({ verdict: 'unclear', correction: null }) });
  await reflect.send(...SHOW(), obs('o1', 'Changed.'));
  await reflect.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' }, { type: 'session', mode: 'review', live: true, reason: null });
  await reflect.send(turn('Let me show you: only customer_07 wants it as text.'), turn('Let me show you.'));
  assert.ok(!said(reflect.cues).includes(STAGE_START.learn), 'no new Show from inside Reflect');
});

test('auto off: Clipa only proposes the next stage and starts it on a yes; a yes with nothing proposed does nothing', async () => {
  const r = rig({});
  await r.send(...SHOW(), { type: 'auto', on: false }, obs('o1', null), obs('o2', null), obs('o3', null));
  await r.send(turn('Yes.'));
  assert.ok(!said(r.cues).includes(STAGE_START.review) && stages(r.cues).length === 0, 'a yes with nothing proposed does nothing');
  await r.advance(RULES.showIdleMs + 100);
  assert.equal(said(r.cues).at(-1), PROPOSE.review);
  const nudges = nudgesOf(r.cues).length;
  await r.advance(RULES.nudgeAfterMs + 100);
  assert.deepEqual(stages(r.cues), [], 'only a proposal');
  assert.equal(nudgesOf(r.cues).length, nudges, 'no nudge while the proposal waits');
  await r.send(turn('Да, давай'));
  assert.equal(said(r.cues).at(-1), STAGE_START.review);
  await r.send({ type: 'cue_done', cueId: lastSay(r.cues).cueId, outcome: 'shown' });
  assert.deepEqual(stages(r.cues), ['review start']);
  // A proposal expires: a late yes is an ordinary turn again, and Clipa proposes once per stage.
  const late = rig({});
  await late.send(...SHOW(), { type: 'auto', on: false }, obs('o1', null), obs('o2', null), obs('o3', null));
  await late.advance(RULES.showIdleMs + 100);
  await late.advance(RULES.proposalTtlMs + 100);
  await late.send(turn('Yes'));
  assert.deepEqual(stages(late.cues), []);
  assert.equal(said(late.cues).filter((t) => t === PROPOSE.review).length, 1);
  // Manual mode after the map is confirmed: the handoff line, then the proposal.
  const reflect = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) });
  await reflect.send(...SHOW(), { type: 'auto', on: false }, obs('o1', 'Changed.'));
  await reflect.send({ type: 'session', mode: 'learn', live: false, reason: 'ended' }, { type: 'session', mode: 'review', live: true, reason: null });
  await reflect.send({ type: 'ui', action: 'confirm', targetId: null, text: null });
  await reflect.send({ type: 'cue_done', cueId: of(reflect.cues, 'guide').at(-1)!.cueId, outcome: 'spoken' });
  assert.equal(said(reflect.cues).at(-1), PROPOSE.teach);
  await reflect.send(turn('Okay'));
  await reflect.advance(RULES.lineBeforeSwitchMs);
  assert.deepEqual(stages(reflect.cues), ['teach start']);
});

test('the auto switch is a client event: parsed strictly, and a client that never sends it leaves auto on', () => {
  const okBatch = parseBatch({ events: [{ seq: 1, atMs: 0, event: { type: 'auto', on: false } }] });
  assert.ok(okBatch.ok && okBatch.value[0]?.event.type === 'auto');
  assert.equal(parseBatch({ events: [{ seq: 1, atMs: 0, event: { type: 'auto', on: 'no' } }] }).ok, false);
  const c = rig({}).c;
  assert.equal(c.status().auto, true);
});

// ---- Reflect always has a session to explore ------------------------------------------------------------------------
const mapsOf = (cues: CueEnvelope[]) => cueOf(cues, 'map');
const evidenceIn = (map: ConductorMap): string[] =>
  [...map.steps.flatMap((s) => s.evidenceIds), ...map.guardrails.flatMap((g) => g.evidenceIds), ...map.gaps.flatMap((g) => g.evidenceIds)];

test('Reflect falls back: its own map first, then the last map of an earlier session, then the demo map', async () => {
  const maps = new MapRegistry();
  // No session anywhere yet: the synthetic demo map of the demo script, with no screen moments and no model call.
  const first = rig({}, maps, 'sess-a');
  await first.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  const demo = mapsOf(first.cues).at(-1);
  assert.equal(demo?.origin, 'demo');
  const seeded = demo?.map as ConductorMap;
  assert.deepEqual(seeded.processes.map((p) => p.title), ['Invoice email: payment terms', 'Prepaid cost: spread by quarter']);
  assert.deepEqual(evidenceIn(seeded), [], 'never seen on a screen');
  assert.ok(seeded.steps.some((s) => s.action.includes('Net 30') && s.decision?.reason?.includes('signed agreement') && s.decision.quote?.includes('signed agreement')));
  assert.ok(seeded.guardrails.some((g) => g.requiredAction.startsWith('Net 30 only for Lumen') && g.escalateTo === 'the finance lead'));
  assert.ok(seeded.guardrails.some((g) => g.condition.includes('prepaid cost over EUR 1,000') && g.exceptions.length === 1));
  assert.ok(seeded.gaps.length >= 1 && seeded.gaps.length <= 2 && seeded.teachBack.length > 0);
  assert.equal(cueOf(first.cues, 'guide').at(-1)?.step, 'demo_map');
  assert.ok(cueOf(first.cues, 'context').some((c) => c.text.includes('synthetic demo map')));
  assert.equal(first.calls.length, 0);
  assert.equal(maps.lastBuilt(), null, 'the demo map is never stored as a built map');

  // Session B builds its own map from its screen, as before: it becomes the last built map.
  const own = rig({ map_synthesis: () => ok(MAP) }, maps, 'sess-b');
  await own.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
  await own.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(mapsOf(own.cues).at(-1)?.origin, 'session');
  assert.deepEqual([maps.lastBuilt()?.sessionId, maps.lastBuilt()?.title], ['sess-b', 'Budget update']);
  assert.equal(maps.lastBuilt()?.map.baselineProvenance, undefined, 'the stored map keeps the workflow, not the bookkeeping');

  // A page reload is a new session with no screen: Reflect shows B's map, labelled as an earlier session.
  const reload = rig({}, maps, 'sess-c');
  await reload.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  const earlier = mapsOf(reload.cues).at(-1);
  assert.equal(earlier?.origin, 'earlier');
  assert.deepEqual((earlier?.map as ConductorMap).steps.map((s) => s.action), MAP.steps.map((s) => s.action));
  assert.equal(cueOf(reload.cues, 'guide').at(-1)?.step, 'earlier_map');
  assert.ok(cueOf(reload.cues, 'context').some((c) => c.text.includes('earlier session')));
  assert.equal(reload.calls.length, 0);
  // The person can still dig in: Clipa raises the open point at a pause, as for a map of the session's own.
  await reload.advance(RULES.pauseMs + 10);
  assert.equal(cueOf(reload.cues, 'ask').at(-1)?.text, 'Who is the lead?');
});

test('Reflect: edits change this session\'s copy only, and the copy gives way once the session has a screen of its own', async () => {
  const maps = new MapRegistry();
  maps.recordBuilt('sess-old', MAP as never, 1);
  const edit = { intent: 'edit', operations: [{ op: 'set', targetId: 'g1', field: 'condition', value: 'budget above 500', value2: null, quote: null }], reply: 'Changed the limit to 500.', teachBack: null };
  const r = rig({ map_edit: () => ok(edit), map_synthesis: () => ok(TWO) }, maps, 'sess-new');
  await r.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  await r.send({ type: 'transcript', role: 'expert', text: 'The lead signs above 500.' });
  const edited = mapsOf(r.cues).at(-1);
  assert.equal(edited?.origin, 'earlier');
  assert.equal((edited?.map as ConductorMap).guardrails[0]?.condition, 'budget above 500');
  assert.deepEqual([maps.lastBuilt()?.sessionId, maps.lastBuilt()?.map.guardrails[0]?.condition], ['sess-old', 'budget above 300'], 'the earlier map is unchanged');

  // A demo copy is edited the same way; the seeded map itself never changes.
  const d = rig({ map_edit: () => ok({ ...edit, operations: [{ ...edit.operations[0]!, value: 'longer terms' }] }) }, new MapRegistry(), 'sess-demo');
  await d.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  await d.send({ type: 'transcript', role: 'expert', text: 'Any longer terms need the finance lead.' });
  assert.equal((mapsOf(d.cues).at(-1)?.map as ConductorMap).guardrails[0]?.condition, 'longer terms');
  assert.equal(demoMap().guardrails[0]?.condition, 'Payment terms other than the standard Net 14 on an invoice email');

  // The session runs Show: Reflect builds its own map instead of showing the copy again.
  await r.send({ type: 'session', mode: 'review', live: false, reason: 'user' }, { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  const own = mapsOf(r.cues).at(-1);
  assert.equal(own?.origin, 'session');
  assert.deepEqual((own?.map as ConductorMap).processes.map((p) => p.title), ['Budget update', 'Supplier check']);
  assert.equal(maps.lastBuilt()?.sessionId, 'sess-new');
});

test('Reflect: confirming a fallback map registers it like any confirmed map, so Pass it on works after a reload', async () => {
  const maps = new MapRegistry();
  const r = rig({}, maps, 'sess-1');
  await r.send(hello('web'), { type: 'session', mode: 'review', live: true, reason: null });
  assert.equal(mapsOf(r.cues).at(-1)?.origin, 'demo');
  await r.send({ type: 'ui', action: 'confirm', targetId: null, text: null });
  const confirmed = mapsOf(r.cues).at(-1);
  assert.ok(confirmed?.confirmed === true && confirmed.origin === 'demo', 'still labelled as the demo map');
  assert.equal(maps.find(null)?.sessionId, 'sess-1');
  assert.ok(cueOf(r.cues, 'guide').some((g) => g.step === 'handoff'));
  assert.equal(maps.lastBuilt(), null);
  const hire = rig({}, maps, 'hire-1');
  await hire.send(hello('web', 'new_hire'), { type: 'session', mode: 'teach', live: true, reason: null });
  assert.ok(!cueOf(hire.cues, 'guide').some((g) => g.step === 'no_map'), 'Pass it on has a confirmed map');
  assert.deepEqual(maps.library().map((p) => [p.title, p.rules.length]), [['Invoice email: payment terms', 2], ['Prepaid cost: spread by quarter', 1]]);

  // A map of the session's own is still confirmed only after its teach-back, as before.
  const own = rig({ map_synthesis: () => ok(MAP) }, new MapRegistry(), 'sess-2');
  await own.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', 'Changed.'));
  await own.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  await own.send({ type: 'ui', action: 'confirm', targetId: null, text: null });
  assert.ok(!mapsOf(own.cues).some((m) => m.confirmed));
});

test('Reflect: when the model cannot build the session\'s own map, the board still opens with the last built map', async () => {
  const maps = new MapRegistry();
  maps.recordBuilt('sess-old', MAP as never, 1);
  // No map_synthesis answer: every build fails (runner_error), in the background after Show and again in Reflect.
  const r = rig({}, maps, 'sess-new');
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, obs('o1', null), obs('o2', 'Changed.'));
  await r.send({ type: 'session', mode: 'learn', live: false, reason: 'user' }, { type: 'session', mode: 'review', live: true, reason: null });
  const shown = mapsOf(r.cues).at(-1);
  assert.equal(shown?.origin, 'earlier');
  assert.deepEqual((shown?.map as ConductorMap).steps.map((s) => s.action), MAP.steps.map((s) => s.action));
  assert.equal(cueOf(r.cues, 'guide').at(-1)?.step, 'earlier_map');
  assert.ok(r.calls.filter((c) => c.task === 'map_synthesis').length >= 1, 'it did try to build its own map');
});

// ---- what the person says reaches the question ----------------------------------------------------------------------
const frame = (id: string, atMs: number, facts: Record<string, unknown> = {}): ClientEvent => {
  const parsed = parseBatch({ events: [{ seq: 0, atMs: 0, event: { type: 'observation', observation: {
    id, kind: 'screen_activity', timestampMs: atMs, evidenceIds: [`ev-${id}`],
    facts: { app: 'Mail', surface: 'compose window', summary: `Summary ${id}`, change: null, pendingAction: null, regions: [], ...facts },
  } } }] });
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
};
const askedWith = (r: Rig, id: string): string[] | undefined => {
  const call = r.calls.filter((c) => c.task === 'generic_question' && (c.body.observations as Array<{ id: string }>).some((o) => o.id === id)).at(-1);
  return call ? (call.body.transcript as Array<{ text: string }>).map((t) => t.text) : undefined;
};

test('the question hears the person: a reworded surface of the same app keeps what was said', async () => {
  const r = rig({ generic_question: () => ok({ question: null, topic: 'reason', observationIds: [], regionIds: [] }) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'share', state: 'capturing', reason: null });
  await r.send(frame('m1', 0));
  await r.advance(1_000);
  await r.send({ type: 'transcript', role: 'expert', text: 'Lumen has a signed agreement for Net 30.' });
  // Vision names the same app longer and the surface in other words, with a real change on it: a new screen, not a move.
  await r.send(frame('m2', 1_500, { app: 'Google Chrome - Mail', surface: 'draft reply', change: 'Net 14 changed to Net 30' }));
  await r.advance(RULES.pauseMs + RULES.settleMs + 50);
  assert.deepEqual(askedWith(r, 'm2'), ['Lumen has a signed agreement for Net 30.']);
  // Reworded again with nothing changed: still the same screen, and what was said is still there.
  await r.send(frame('m3', 3_000, { app: 'Mail', surface: 'reply draft' }));
  await r.advance(RULES.pauseMs + RULES.settleMs + 50);
  assert.deepEqual(askedWith(r, 'm3'), ['Lumen has a signed agreement for Net 30.']);
});

test('the question hears the person: another app keeps what was said while its screen was already up', async () => {
  const r = rig({ generic_question: () => ok({ question: null, topic: 'reason', observationIds: [], regionIds: [] }) });
  await r.send(hello('web'), { type: 'session', mode: 'learn', live: true, reason: null }, { type: 'share', state: 'capturing', reason: null });
  await r.send(frame('m1', 0));
  await r.advance(1_000);
  await r.send({ type: 'transcript', role: 'expert', text: 'Lumen has a signed agreement for Net 30.' });
  await r.advance(20_000);
  await r.send({ type: 'transcript', role: 'expert', text: 'Now the budget: the licence was prepaid for a year.' });
  // The Sheet was captured 2 s before that turn; vision delivers its frame after the turn.
  await r.send(frame('s1', 19_000, { app: 'Sheets', surface: 'budget sheet', change: 'Q1 to Q4 filled with 3,000' }));
  await r.advance(RULES.pauseMs + RULES.settleMs + 50);
  assert.deepEqual(askedWith(r, 's1'), ['Now the budget: the licence was prepaid for a year.'], 'the Mail turn stays with Mail');
});

// ---- the demo workspace: its order, email and ticket are one place ------------------------------------------------------
const wsFrame = (id: string, kind: 'order_view' | 'email_draft' | 'ticket', atMs: number, facts: Record<string, unknown>): ClientEvent => {
  const parsed = parseBatch({ events: [{ seq: 0, atMs: 0, event: { type: 'observation', observation: { id, kind, timestampMs: atMs, evidenceIds: [`ev-${id}`], facts } } }] });
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
};
const orderFrame = (id: string, atMs = 20_000): ClientEvent =>
  wsFrame(id, 'order_view', atMs, { customerRef: 'customer_07', orderId: 'ORD-2041', deliveryAddress: '12 Sample Street', deliveryWindow: '10:00-12:00' });
/** An edit is a short body (under 120 characters): the frame's summary then changes before and after email summaries get richer. */
const emailFrame = (id: string, body: string, atMs = 20_000): ClientEvent =>
  wsFrame(id, 'email_draft', atMs, { recipientRef: 'customer_07', subject: 'Your delivery', bodyText: body, attachments: [], previewState: 'editing' });
const lookingAt = (cues: CueEnvelope[]) => cueOf(cues, 'thought').filter((t) => t.text.startsWith('Looking at'));
const EXPERT_WORDS = 'Customer 07 asked for the details as text.';

test('workspace: order and email frames alternate; the email edit makes one question and nothing is cancelled or forgotten', async () => {
  const r = rig({ generic_question: () => ok(QUESTION) });
  await r.send(...SHOW(), turn(EXPERT_WORDS));
  await r.advance(8_000);
  // The first look at the order and the email, then the email edit; the frames keep alternating all the while.
  await r.send(orderFrame('w1'), emailFrame('w2', 'Hello'), orderFrame('w3'), emailFrame('w4', 'Delivery at 12 Sample Street'), orderFrame('w5'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.filter((c) => c.task === 'generic_question').length, 1, 'prepared as soon as the screen settled');
  await r.send(emailFrame('w6', 'Delivery at 12 Sample Street'), orderFrame('w7'), emailFrame('w8', 'Delivery at 12 Sample Street'));
  await r.advance(RULES.pauseMs + 10);
  const questions = r.calls.filter((c) => c.task === 'generic_question');
  assert.equal(questions.length, 1, 'no second preparation: the alternation is not a change');
  assert.equal(of(r.cues, 'ask').length, 1);
  assert.equal(of(r.cues, 'cancel').length, 0, 'the prepared question was never made out of date');
  assert.ok((questions[0]!.body.observations as Array<{ id: string }>).some((o) => o.id === 'w4'), 'it sees the edited email frame');
  assert.ok((questions[0]!.body.transcript as Array<{ text: string }>).some((t) => t.text === EXPERT_WORDS), 'it still has what the expert said before the edit');
  assert.equal(lookingAt(r.cues).length, 1, 'one thought about the workspace, not one per frame');
});

test('workspace: the alternating frames do not hold Show open; it looks done 30 s after the last real change', async () => {
  const r = rig({});
  await r.send(...SHOW(), orderFrame('d1'), emailFrame('d2', 'Hello'));
  // The order and the email keep alternating on the shared screen while the person does nothing.
  for (let i = 0; i < 17; i++) { await r.advance(2_000); await r.send(orderFrame(`d${3 + 2 * i}`), emailFrame(`d${4 + 2 * i}`, 'Hello')); }
  assert.ok(said(r.cues).includes(SHOW_LOOKS_DONE), 'the frames are not changes');
});

test('workspace: Pass it on recognises the process once and the checks see the order and the email', async () => {
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const r = rig({
    process_match: () => ok({ processId: 'm1-p1', confidence: 0.9 }),
    guardrail_check: () => ok({ status: 'clear', guardrailId: null, message: null, regionIds: [] }),
  }, maps, 'hire-1');
  await r.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, { type: 'share', state: 'capturing', reason: null });
  await r.send(orderFrame('n1'), emailFrame('n2', 'Image only'));
  await r.advance(RULES.settleMs + 10);
  for (let i = 0; i < 3; i++) { await r.send(orderFrame(`n${3 + 2 * i}`), emailFrame(`n${4 + 2 * i}`, 'Image only')); await r.advance(1_000); }
  await r.advance(RULES.pauseMs);
  assert.equal(r.calls.filter((c) => c.task === 'process_match').length, 1, 'the alternation is not another place to recognise');
  assert.equal(of(r.cues, 'say').length, 0, 'recognition is silent');
  const check = r.calls.find((c) => c.task === 'guardrail_check');
  assert.ok(check, 'the rules were checked at the pause');
  assert.deepEqual([...new Set((check.body.observations as Array<{ surface: string }>).map((o) => o.surface))].sort(), ['email draft', 'order view']);
  assert.equal(lookingAt(r.cues).length, 1);
});

// ---- the lines: the voice agent only voices what the app sends; every line stays generic --------------------------------
test('lines: every stage tells the voice agent that the app sends the questions; the welcome and summary lines make no promise', async () => {
  for (const mode of ['learn', 'review', 'teach'] as const) {
    assert.match(STAGE_ABOUT[mode], /every question and warning as \[ASK\] lines/, mode);
    assert.match(STAGE_ABOUT[mode], /beyond 'Got it\.'/, mode);
    assert.match(STAGE_ABOUT[mode], /skip_turn/, mode);
  }
  // The voice agent hears it at every stage start, as a [stage] context.
  for (const [mode, name] of [['learn', 'Show'], ['review', 'Reflect'], ['teach', 'Pass it on']] as const) {
    const r = rig({ map_synthesis: () => ok({ ...MAP, gaps: [] }) }, new MapRegistry(), `sess-${mode}`);
    await r.send(hello('web'), { type: 'session', mode, live: true, reason: null });
    assert.ok(cueOf(r.cues, 'context').some((c) => c.text === `[stage] Now in ${name}: ${STAGE_ABOUT[mode]}`), mode);
  }
  const r = rig({});
  await r.send(hello('web'));
  const welcome = cueOf(r.cues, 'guide')[0];
  assert.equal(welcome?.text, 'Press Start in Show and work as usual. I ask why at a natural pause.');
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const hire = rig({}, maps, 'hire-1');
  await hire.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, turn('Готово'));
  const summary = cueOf(hire.cues, 'guide').at(-1);
  assert.ok(summary?.step === 'summary' && summary.target === null && summary.speak === true, 'a short thanks, and no summary card to point at');
  assert.equal(summary?.text, 'Nice work on this case.');
});

test('lines: the lines Clipa says name no scenario (they are generic, the scenario lives in the data)', () => {
  const scenario = /customer|order|e-?mail|address|deliver|image|picture|attach|invoice|ORD-|\b07\b|as text/i;
  const lines = [
    ...Object.values(GUIDE).flatMap((persona) => Object.values(persona).flatMap((set) => Object.values(set).map((l) => l.text))),
    ...Object.values(OPEN_WEB), ...NUDGES, ...Object.values(STAGE_CONFIRM), ...Object.values(STAGE_START), ...Object.values(STAGE_ABOUT), ...Object.values(PROPOSE),
    SHOW_LOOKS_DONE, MAC_DONE_LINE, OFF_LINE, RESOLVED,
  ];
  assert.ok(lines.length > 40);
  for (const line of lines) assert.doesNotMatch(line, scenario, line);
});

// ---- Pass it on: one warning per rule, then a ready line ----------------------------------------------------------------
interface Verdict { status: 'warn' | 'clear' | 'unknown'; guardrailId: string | null; message: string | null; regionIds: string[] }
const WARN: Verdict = { status: 'warn', guardrailId: 'g1', message: 'Add the details as text.', regionIds: [] };
const CLEAR: Verdict = { status: 'clear', guardrailId: null, message: null, regionIds: [] };

/** A new hire on a confirmed map; the rule checks answer with `verdict.now`. The first frames are in and the first check is due. */
async function warnRig(): Promise<{ r: Rig; verdict: { now: Verdict } }> {
  const maps = new MapRegistry();
  maps.confirm('expert-session', MAP as never, 1);
  const verdict = { now: WARN };
  const r = rig({ process_match: () => ok({ processId: 'm1-p1', confidence: 0.9 }), guardrail_check: () => ok(verdict.now) }, maps, 'hire-1');
  await r.send(hello('web', 'new_hire', 'expert-session'), { type: 'session', mode: 'teach', live: true, reason: null }, { type: 'share', state: 'capturing', reason: null });
  await r.send(orderFrame('n1'), emailFrame('n2', 'Image only'));
  await r.advance(RULES.settleMs + 10); // recognised
  return { r, verdict };
}
const checks = (r: Rig) => r.calls.filter((c) => c.task === 'guardrail_check').length;
/** The person edits the email and pauses: the next check runs. */
async function editAndPause(r: Rig, id: string, body: string): Promise<void> {
  await r.send(emailFrame(id, body));
  await r.advance(RULES.teachCheckGapMs + RULES.pauseMs);
}

test('Pass it on: one warning per rule while it is open; once the check is clear Clipa says it is ready, once', async () => {
  await withRules({ nudges: false }, async () => {
    const { r, verdict } = await warnRig();
    await r.advance(RULES.pauseMs); // the first check, at the first pause
    assert.equal(of(r.cues, 'warn').length, 1);
    await r.send({ type: 'cue_done', cueId: of(r.cues, 'warn')[0]!.cueId, outcome: 'spoken' });
    // Another email frame and another pause: the rule is checked again and still broken, but it is not warned about twice.
    await editAndPause(r, 'n3', 'Image only, sent again');
    assert.equal(checks(r), 2, 'checked again');
    assert.equal(of(r.cues, 'warn').length, 1, 'one warning per rule');
    assert.equal(of(r.cues, 'cancel').length, 0);
    // The details are in: the check comes back clear, and Clipa says it is ready, glad about it.
    verdict.now = CLEAR;
    await editAndPause(r, 'n4', 'Delivery at 12 Sample Street');
    assert.equal(checks(r), 3);
    assert.deepEqual(said(r.cues), [RESOLVED]);
    assert.equal(RESOLVED, 'That fixes it. Ready for review.');
    assert.equal(cueOf(r.cues, 'state').at(-1)?.clipa, 'celebrate');
    // Once: later clear checks say nothing more.
    await editAndPause(r, 'n5', 'Delivery at 12 Sample Street, 10:00');
    assert.equal(checks(r), 4);
    assert.deepEqual(said(r.cues), [RESOLVED]);
    // A rule broken again after the fix is warned about again.
    verdict.now = WARN;
    await editAndPause(r, 'n6', 'Image only, again');
    assert.equal(of(r.cues, 'warn').length, 2);
  });
});

test('Pass it on: a warning that was never said (cancelled by typing, skipped by the face) is due again; an interrupted one is not', async () => {
  await withRules({ nudges: false }, async () => {
    const { r } = await warnRig();
    await r.advance(RULES.pauseMs);
    const warns = () => of(r.cues, 'warn');
    assert.equal(warns().length, 1);
    // The person goes back to typing before it was said: it is out of date, and the rule is warned about at the next pause.
    await r.send({ type: 'activity', state: 'typing' });
    assert.deepEqual(cueOf(r.cues, 'cancel').map((c) => c.cueId), [warns()[0]!.cueId]);
    await r.send({ type: 'activity', state: 'pause' });
    await editAndPause(r, 'n3', 'Image only, edited');
    assert.equal(warns().length, 2, 'warned again');
    // The face skipped it (the person was busy): it was not said either.
    await r.send({ type: 'cue_done', cueId: warns()[1]!.cueId, outcome: 'skipped' });
    await editAndPause(r, 'n4', 'Image only, edited again');
    assert.equal(warns().length, 3, 'warned again');
    // Its moment passed before the face reported anything: the same.
    await r.advance(RULES.warnTtlMs + 100);
    assert.equal(cueOf(r.cues, 'cancel').length, 2, 'the third warning ran out');
    await editAndPause(r, 'n5', 'Image only, edited once more');
    assert.equal(warns().length, 4, 'warned again');
    // The person heard it and spoke over its end: not said in full, but said. No repeat.
    await r.send({ type: 'cue_done', cueId: warns()[3]!.cueId, outcome: 'interrupted' });
    await editAndPause(r, 'n6', 'Image only, edited a last time');
    assert.equal(warns().length, 4, 'an interrupted warning was heard');
  });
});

test('Pass it on: a warning the person typed over while the voice agent was saying it was heard: the fix still gets its ready line', async () => {
  await withRules({ nudges: false }, async () => {
    const { r, verdict } = await warnRig();
    await r.advance(RULES.pauseMs);
    const warn = of(r.cues, 'warn')[0]!;
    await r.send({ type: 'talking', by: 'agent', active: true }); // the voice agent starts saying it
    await r.send({ type: 'activity', state: 'typing' }); // the person starts on the fix over its end
    assert.deepEqual(cueOf(r.cues, 'cancel').map((c) => c.cueId), [warn.cueId], 'its end is cut, as before');
    await r.send({ type: 'talking', by: 'agent', active: false }, { type: 'cue_done', cueId: warn.cueId, outcome: 'interrupted' }, { type: 'activity', state: 'pause' });
    await editAndPause(r, 'n3', 'Image only, still');
    assert.equal(of(r.cues, 'warn').length, 1, 'heard once: not warned again while it is open');
    verdict.now = CLEAR;
    await editAndPause(r, 'n4', 'Delivery at 12 Sample Street');
    assert.deepEqual(said(r.cues), [RESOLVED]);
  });
});

test('Pass it on: a warning does not outlive the off-the-record switch or a new stage: no ready line for it', async () => {
  const resets: ClientEvent[][] = [
    [{ type: 'off_record', on: true }, { type: 'off_record', on: false }],
    [{ type: 'session', mode: 'teach', live: false, reason: 'user' }, { type: 'session', mode: 'teach', live: true, reason: null }],
  ];
  for (const reset of resets) {
    await withRules({ nudges: false }, async () => {
      const { r, verdict } = await warnRig();
      await r.advance(RULES.pauseMs);
      assert.equal(of(r.cues, 'warn').length, 1);
      await r.send({ type: 'cue_done', cueId: of(r.cues, 'warn')[0]!.cueId, outcome: 'spoken' });
      await r.send(...reset);
      verdict.now = CLEAR;
      await r.send(orderFrame('n7'), emailFrame('n8', 'Delivery at 12 Sample Street'));
      await r.advance(RULES.settleMs + 10);
      await r.advance(RULES.teachCheckGapMs + RULES.pauseMs);
      assert.equal(checks(r), 2, `checked again after ${JSON.stringify(reset[0])}`);
      assert.deepEqual(said(r.cues), [], 'nothing was open any more');
    });
  }
});
