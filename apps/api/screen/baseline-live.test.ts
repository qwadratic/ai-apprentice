import test from 'node:test';
import assert from 'node:assert/strict';
import {Conductor, MapRegistry, RULES} from '../agent/conductor/engine.ts';
import {LLM_TASKS} from '../agent/llm-tasks.ts';
import type {MapSynthesisOutput} from '../agent/llm-tasks.ts';
import {parseBatch} from '../agent/conductor/protocol.ts';
import type {ClientEvent, CueEnvelope, SeenObservation} from '../agent/conductor/protocol.ts';
import type {TaskResult} from '../agent/llm.ts';
import {BASELINE_PROFILES} from '../../../packages/screen/baseline/profiles.ts';
import type {BaselinePromptContext, BaselineSnapshot} from '../../../packages/screen/baseline/profiles.ts';

interface Call {readonly task: string; readonly body: Record<string, unknown>}
interface Rig {
  readonly conductor: Conductor;
  readonly calls: Call[];
  readonly cues: CueEnvelope[];
  readonly maps: MapRegistry;
  send(...events: ClientEvent[]): Promise<void>;
  advance(ms: number): Promise<void>;
}

function observation(id: string, app: string | null, summary = 'The same visible work item is open.', surface = 'main workspace'): ClientEvent {
  const parsed = parseBatch({events: [{seq: 1, atMs: 0, event: {type: 'observation', observation: {
    id, kind: 'screen_activity', timestampMs: 1_000, evidenceIds: [`ev-${id}`],
    facts: {app, surface, summary, change: null, pendingAction: 'Continue',
      regions: [{id: 'primary', label: 'Primary action', box: [0.6, 0.7, 0.2, 0.1]}]},
  }}}]});
  if (!parsed.ok) throw new Error(parsed.field);
  return parsed.value[0]!.event;
}

function seen(id: string, app: string | null, summary = 'The same visible work item is open.'): SeenObservation {
  const event = observation(id, app, summary);
  if (event.type !== 'observation') throw new Error('Expected observation');
  return event.observation;
}

function rig(answer: (body: Record<string, unknown>) => TaskResult | Promise<TaskResult> = body => ({ok: true, output: {
  question: 'What determines the next step here?', topic: 'reason',
  observationIds: [(body.observations as Array<{id: string}>).at(-1)!.id], regionIds: ['primary'],
}}), tasks: Record<string, (body: Record<string, unknown>) => TaskResult | Promise<TaskResult>> = {}): Rig {
  let now = 1_000_000;
  let seq = 0;
  const calls: Call[] = [];
  const cues: CueEnvelope[] = [];
  const maps = new MapRegistry();
  const conductor = new Conductor('baseline-session', {now: () => now, newId: () => 'abcdef0123456789',
    maps, llm: async (task, body) => {
      calls.push({task, body: body as Record<string, unknown>});
      return task === 'generic_question' ? answer(body as Record<string, unknown>) : tasks[task]?.(body as Record<string, unknown>) ?? {ok: false, error: 'runner_error'};
    }});
  conductor.subscribe(cue => cues.push(cue));
  const settle = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
  return {conductor, calls, cues, maps,
    async send(...events) {
      conductor.handle(events.map(event => ({seq: ++seq, atMs: now - 1_000_000, event})), 'baseline-session');
      await settle();
    },
    async advance(ms) { now += ms; conductor.tick(); await settle(); },
  };
}

const statusBaseline = (value: Conductor): BaselineSnapshot =>
  (value.status() as {baseline: BaselineSnapshot}).baseline;

for (const [app, appId] of [['Gmail', 'gmail'], ['Google Sheets', 'google_sheets'], ['Google Maps', 'google_maps']] as const) {
  test(`live Learn supplies the ${app} baseline separately after two distinct observations`, async () => {
    const r = rig(() => ({ok: true, output: {question: `What matters in ${app}?`, topic: 'scope',
      observationIds: [`${appId}-2`], regionIds: ['primary']}}));
    await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'},
      observation(`${appId}-1`, app), observation(`${appId}-2`, app));
    await r.advance(RULES.settleMs + 10);
    assert.equal(r.calls.filter(call => call.task === 'generic_question').length, 1);
    const body = r.calls.find(call => call.task === 'generic_question')!.body;
    const prepared = LLM_TASKS.generic_question!.prepare(body);
    assert.ok(prepared.ok, prepared.ok ? undefined : prepared.field);
    const context = body.baselineContext as BaselinePromptContext;
    assert.equal(context.source, 'supplied_baseline');
    assert.equal(context.learned, false);
    assert.equal(context.appId, appId);
    assert.equal(context.profileId, BASELINE_PROFILES[appId].id);
    assert.deepEqual(context.evidence.observationIds, [`${appId}-1`, `${appId}-2`]);
    assert.deepEqual(body.transcript, [], 'supplied workflow must not be represented as expert speech');
    assert.match(prepared.request.prompt, /supplied_baseline/);
    assert.deepEqual(statusBaseline(r.conductor), expectCandidate(appId));
    await r.send({type: 'activity', state: 'pause'});
    await r.advance(RULES.pauseMs + 10);
    const ask = r.cues.find(cue => cue.cue.type === 'ask')?.cue;
    assert.ok(ask?.type === 'ask');
    assert.deepEqual(ask.evidenceIds, [`ev-${appId}-2`]);
    assert.deepEqual(ask.regions.map(region => [region.regionId, region.box]), [['primary', [0.6, 0.7, 0.2, 0.1]]]);
  });
}

test('unknown apps and app switches clear the active baseline until the new app is stable', () => {
  const conductor = rig().conductor;
  conductor.onObservation(seen('g1', 'Gmail'));
  conductor.onObservation(seen('g2', 'Gmail'));
  assert.equal(statusBaseline(conductor).profileId, 'baseline.gmail-ticket-reply');
  conductor.onObservation(seen('unknown', null));
  assert.deepEqual([statusBaseline(conductor).status, statusBaseline(conductor).profileId], ['suspended', null]);
  conductor.onObservation(seen('s1', 'Google Sheets'));
  assert.deepEqual([statusBaseline(conductor).status, statusBaseline(conductor).profileId], ['confirming', null]);
  conductor.onObservation(seen('s2', 'Google Sheets'));
  assert.deepEqual([statusBaseline(conductor).status, statusBaseline(conductor).profileId],
    ['candidate', 'baseline.sheets-quarterly-report']);
});

test('an app-only change invalidates a prepared old-profile question', async () => {
  const r = rig();
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'},
    observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal((r.calls[0]!.body.baselineContext as BaselinePromptContext).appId, 'gmail');
  await r.send(observation('s1', 'Google Sheets'));
  await r.advance(RULES.settleMs + 10);
  const latest = r.calls.filter(call => call.task === 'generic_question').at(-1)!;
  assert.equal(latest.body.baselineContext, null);
  assert.deepEqual((latest.body.observations as Array<{id: string}>).at(-1)?.id, 's1');
  await r.send({type: 'activity', state: 'pause'});
  await r.advance(RULES.pauseMs + 10);
  const asks = r.cues.flatMap(cue => cue.cue.type === 'ask' ? [cue.cue] : []);
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0]!.evidenceIds, ['ev-s1']);
});

test('off-record immediately resets the selector and requires two fresh observations afterward', async () => {
  const r = rig();
  await r.send(observation('m1', 'Google Maps'), observation('m2', 'Google Maps'));
  assert.equal(statusBaseline(r.conductor).profileId, 'baseline.maps-business-venue');
  await r.send({type: 'off_record', on: true});
  assert.deepEqual(statusBaseline(r.conductor), {
    appId: null, profileId: null, candidate: null, status: 'empty',
    evidence: {observationIds: [], evidenceIds: []}, basis: 'none',
  });
  await r.send(observation('private', 'Gmail'), {type: 'off_record', on: false}, observation('g1', 'Gmail'));
  assert.deepEqual([statusBaseline(r.conductor).status, statusBaseline(r.conductor).profileId], ['confirming', null]);
  await r.send(observation('g2', 'Gmail'));
  assert.equal(statusBaseline(r.conductor).profileId, 'baseline.gmail-ticket-reply');
});

function expectCandidate(appId: 'gmail' | 'google_sheets' | 'google_maps'): BaselineSnapshot {
  const prefix = appId;
  const profile = BASELINE_PROFILES[appId];
  return {
    appId, profileId: profile.id,
    candidate: {appId, profileId: profile.id, observationIds: [`${prefix}-1`, `${prefix}-2`]},
    status: 'candidate',
    evidence: {observationIds: [`${prefix}-1`, `${prefix}-2`], evidenceIds: [`ev-${prefix}-1`, `ev-${prefix}-2`]},
    basis: 'candidate_scope_requires_confirmation',
  };
}

test('the second same-summary frame refreshes the prepared question with the confirmed candidate', async () => {
  const r = rig();
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'}, observation('g1', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.at(-1)!.body.baselineContext, null);
  await r.send(observation('g2', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.filter(call => call.task === 'generic_question').length, 2);
  assert.equal((r.calls.at(-1)!.body.baselineContext as BaselinePromptContext).appId, 'gmail');
  await r.send({type: 'activity', state: 'pause'});
  await r.advance(RULES.pauseMs + 10);
  const ask = r.cues.find(cue => cue.cue.type === 'ask')?.cue;
  assert.ok(ask?.type === 'ask');
  assert.deepEqual(ask.evidenceIds, ['ev-g2']);
});

test('a late async result from the previous app never becomes an audible question', async () => {
  let resolveOld!: (result: TaskResult) => void;
  const oldAnswer = new Promise<TaskResult>(resolve => { resolveOld = resolve; });
  const r = rig(body => (body.baselineContext as BaselinePromptContext | null)?.appId === 'gmail'
    ? oldAnswer
    : {ok: true, output: {question: 'Current app question', topic: 'scope', observationIds: ['s2'], regionIds: ['primary']}});
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.length, 1);
  await r.send(observation('s1', 'Google Sheets'), observation('s2', 'Google Sheets'));
  resolveOld({ok: true, output: {question: 'Stale Gmail question', topic: 'scope', observationIds: ['g2'], regionIds: ['primary']}});
  await r.send({type: 'activity', state: 'pause'});
  await r.advance(RULES.pauseMs + RULES.settleMs + 10);
  const asks = r.cues.flatMap(cue => cue.cue.type === 'ask' ? [cue.cue] : []);
  assert.deepEqual(asks.map(ask => ask.text), ['Current app question']);
  assert.deepEqual(asks[0]!.evidenceIds, ['ev-s2']);
});

const REVIEW_MAP = {processes: [], steps: [], guardrails: [], gaps: [], teachBack: 'Here is the observed workflow. Is that right?'};

test('Review retains server-owned profile and evidence provenance through publication and confirmation', async () => {
  const r = rig(undefined, {map_synthesis: () => ({ok: true, output: REVIEW_MAP})});
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.advance(RULES.pauseMs + RULES.settleMs + 10);
  const ask = r.cues.find(cue => cue.cue.type === 'ask')?.cue;
  assert.ok(ask?.type === 'ask');
  await r.send({type: 'transcript', role: 'expert', text: 'This customer needs a separate approval.'});
  await r.send({type: 'session', mode: 'learn', live: false, reason: 'user'});
  const synthesis = r.calls.find(call => call.task === 'map_synthesis')!;
  assert.ok(synthesis);
  assert.deepEqual((synthesis.body.transcript as Array<{role: string; text: string}>).filter(turn => turn.role === 'expert').map(turn => turn.text), ['This customer needs a separate approval.']);
  await r.send({type: 'session', mode: 'review', live: true, reason: null});
  const published = r.cues.flatMap(cue => cue.cue.type === 'map' ? [cue.cue] : []).at(-1)!;
  assert.ok(published);
  const provenance = (published.map as MapSynthesisOutput).baselineProvenance!;
  assert.ok(provenance);
  assert.ok(provenance.observations.some(entry => entry.observationId === 'g2' && entry.appId === 'gmail' && entry.profileId === 'baseline.gmail-ticket-reply' && entry.evidenceIds.includes('ev-g2')));
  const answer = provenance.turns.find(turn => turn.questionId === ask.questionId);
  assert.ok(answer, 'the expert explanation refers to the question that elicited it');
  assert.equal(answer.appId, 'gmail');
  assert.equal(answer.profileId, 'baseline.gmail-ticket-reply');
  assert.ok(answer.observationIds.includes('g2'));
  assert.ok(answer.evidenceIds.includes('ev-g2'));
  assert.equal(typeof answer.atMs, 'number');
  await r.send({type: 'ui', action: 'confirm', targetId: null, text: null});
  const confirmed = r.maps.find('baseline-session');
  assert.ok(confirmed);
  assert.deepEqual(confirmed.map.baselineProvenance, provenance);
});

test('Review provenance remains bounded with the retained observations and expert turns', async () => {
  const r = rig(undefined, {map_synthesis: () => ({ok: true, output: REVIEW_MAP})});
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'});
  for (let i = 0; i < Math.max(RULES.keepObservations, RULES.keepTurns) + 5; i++) {
    await r.send(observation(`g${i}`, 'Gmail'), {type: 'transcript', role: 'expert', text: `Synthetic explanation ${i}.`});
  }
  await r.send({type: 'session', mode: 'review', live: true, reason: null});
  const published = r.cues.flatMap(cue => cue.cue.type === 'map' ? [cue.cue] : []).at(-1)!;
  const provenance = (published.map as MapSynthesisOutput).baselineProvenance!;
  assert.ok(provenance.observations.length > 0 && provenance.observations.length <= RULES.keepObservations);
  assert.ok(provenance.turns.length > 0 && provenance.turns.length <= RULES.keepTurns);
  assert.ok(!provenance.observations.some(entry => entry.observationId === 'g0'));
});

test('navigation inside the same app retains its stable baseline and valid observation references', async () => {
  const r = rig();
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, {type: 'activity', state: 'typing'}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  await r.send(observation('g3', 'Gmail', 'An invoice reply is open.', 'reply composer'));
  assert.equal(statusBaseline(r.conductor).status, 'candidate');
  await r.advance(RULES.settleMs + 10);
  const body = r.calls.at(-1)!.body;
  assert.equal((body.baselineContext as BaselinePromptContext).appId, 'gmail');
  const prepared = LLM_TASKS.generic_question!.prepare(body);
  assert.ok(prepared.ok, prepared.ok ? undefined : prepared.field);
});

test('Teach does not recognize learned processes while a baseline app is confirming or unknown', async () => {
  const r = rig(undefined, {process_match: () => ({ok: true, output: {processId: 'm1-p1', confidence: 0.9}})});
  r.maps.confirm('expert', REVIEW_MAP, 1);
  await r.send({type: 'session', mode: 'teach', live: true, reason: null}, observation('g1', 'Gmail'));
  await r.advance(RULES.pauseMs + RULES.settleMs + 10);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 0);
  await r.send(observation('unknown', null));
  await r.advance(4000 + RULES.pauseMs);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 0);
  await r.send(observation('g2', 'Gmail'), observation('g3', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 1);
});

test('a negative process match retries after meaningful new evidence and the recognition cooldown', async () => {
  const r = rig(undefined, {process_match: () => ({ok: true, output: {processId: null, confidence: 0.2}})});
  r.maps.confirm('expert', REVIEW_MAP, 1);
  await r.send({type: 'session', mode: 'teach', live: true, reason: null}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 1);
  await r.send(observation('g3', 'Gmail', 'The customer invoice reply is now visible.'));
  await r.advance(RULES.settleMs + 10);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 1, 'cooldown prevents immediate repeated recognition');
  await r.advance(4000);
  assert.equal(r.calls.filter(call => call.task === 'process_match').length, 2);
});

test('screen changes during Review do not cancel an active gap question', async () => {
  const r = rig(undefined, {map_synthesis: () => ({ok: true, output: {...REVIEW_MAP,
    gaps: [{question: 'Who approves this?', targetId: null, evidenceIds: ['g2'], regionIds: ['primary']}]}})});
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.send({type: 'session', mode: 'review', live: true, reason: null});
  await r.advance(RULES.pauseMs + RULES.gapAfterAnswerMs + 10);
  const gap = r.cues.find(cue => cue.cue.type === 'ask');
  assert.ok(gap);
  await r.send(observation('s1', 'Google Sheets'), observation('s2', 'Google Sheets'));
  assert.ok(!r.cues.some(cue => cue.cue.type === 'cancel' && cue.cue.cueId === gap.cueId));
});

test('a Show-end map still publishes when its async synthesis completes after Review starts', async () => {
  let resolveMap!: (value: TaskResult) => void;
  const pending = new Promise<TaskResult>(resolve => { resolveMap = resolve; });
  const r = rig(undefined, {map_synthesis: () => pending});
  await r.send({type: 'session', mode: 'learn', live: true, reason: null}, observation('g1', 'Gmail'), observation('g2', 'Gmail'));
  await r.send({type: 'session', mode: 'learn', live: false, reason: 'user'});
  assert.equal(r.calls.filter(call => call.task === 'map_synthesis').length, 1);
  await r.send({type: 'session', mode: 'review', live: true, reason: null});
  resolveMap({ok: true, output: REVIEW_MAP});
  await r.advance(1);
  const maps = r.cues.flatMap(cue => cue.cue.type === 'map' ? [cue.cue] : []);
  assert.equal(maps.length, 1);
  assert.equal(r.calls.filter(call => call.task === 'map_synthesis').length, 1);
  assert.ok((maps[0]!.map as MapSynthesisOutput).baselineProvenance?.observations.some(entry => entry.observationId === 'g2'));
});
