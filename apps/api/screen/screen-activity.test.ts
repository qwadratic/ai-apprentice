// Ported from stream A's TASK-3.52 branch (PR #56): one processed frame of an arbitrary app goes through the real
// screen hub, vision validation, evidence store and conductor to a question at a pause. Only the provider response
// is synthetic; validation, queue, evidence, delivery, question preparation and region/evidence cues are production
// code. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import type {ScreenObservation} from '@apprentice/contracts';
import {Conductor, MapRegistry, RULES} from '../agent/conductor/engine.ts';
import {parseObservation} from '../agent/conductor/protocol.ts';
import type {CueEnvelope} from '../agent/conductor/protocol.ts';
import {LLM_TASKS} from '../agent/llm-tasks.ts';
import {buildKeyframes} from '../../web/features/agent/workmap/model.ts';
import {createMapState, reduceMap} from '../../../packages/agent/src/knowledge/map.ts';
import {createMemoryEvidenceStore} from './evidence-store.ts';
import {createScreenService} from './service.ts';
import {ScreenSessionHub} from './session-transport.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

for (const app of ['Gmail', 'Google Sheets', 'Google Maps', null]) {
  test(`a generic processed frame reaches a question with evidence and regions: ${app ?? 'unknown app'}`, async () => {
    let now = 100_010;
    const published: ScreenObservation[] = [];
    const cues: CueEnvelope[] = [];
    let preparedPrompt = '';
    const facts = {app, surface: 'details panel', summary: 'A selected item and a visible action are shown.',
      change: null, entities: ['Example item'], pendingAction: 'Open details', pendingRegionId: 'details',
      regions: [{id: 'details', label: 'Open details', box: [0.1, 0.2, 0.3, 0.1]}]};
    const conductor = new Conductor('session', {now: () => now, newId: () => 'cue-id', maps: new MapRegistry(),
      llm: async (task, body) => {
        assert.equal(task, 'generic_question');
        const prepared = must(LLM_TASKS[task], 'the generic_question task').prepare(body);
        assert.ok(prepared.ok);
        preparedPrompt = prepared.request.prompt;
        const latest = must(published.at(-1), 'a published observation');
        const output = prepared.check({question: 'What guides your choice of this item?', topic: 'reason',
          observationIds: [latest.id], regionIds: ['details']});
        assert.ok(output);
        return {ok: true, output};
      }});
    conductor.subscribe(cue => cues.push(cue));
    conductor.handle([{seq: 1, atMs: 0, event: {type: 'session', mode: 'learn', live: true, reason: null}},
      {seq: 2, atMs: 0, event: {type: 'activity', state: 'typing'}}], 'web');
    const hub = new ScreenSessionHub(({publish, onEvent}) => createScreenService({
      runner: {async vision(input) {
        assert.deepEqual(Buffer.from(must(input.images[0], 'one image').data, 'base64'), png);
        assert.match(input.prompt, /screen_activity/);
        return {json: {outcome: 'observation', kind: 'screen_activity', facts}, ms: 1};
      }}, parseObservation: parseScreenObservation, evidence: createMemoryEvidenceStore(), publish, onEvent,
      queueOptions: {sampleIntervalMs: 0, now: () => now},
    }), parseScreenStatus, () => now);
    hub.onObservation((sessionId, observation) => {
      assert.equal(sessionId, conductor.sessionId);
      published.push(observation);
      const parsed = parseObservation(observation);
      assert.ok(parsed.ok);
      conductor.onObservation(parsed.value);
      conductor.tick();
    });
    const started = hub.start('session', 100_000, 1);
    const session = hub.authenticate('session', started.sessionToken);
    session.service.offer({sessionId: 'session', frameId: 'frame', timestampMs: 5, processed: true, mediaType: 'image/png', bytes: png});
    await settle();
    assert.equal(published.length, 1);
    const observation = must(published[0], 'the published observation');
    assert.equal(observation.sourceRevision, null);
    assert.equal(observation.entityRef, null);
    const legacyMap = createMapState();
    assert.deepEqual(reduceMap(legacyMap, {type: 'observation', observation}), legacyMap,
      'a generic app must not enter the workspace customer-email map');
    const keyframes = buildKeyframes(published);
    assert.equal(keyframes.length, 1);
    assert.equal(must(keyframes[0], 'a keyframe').surface, 'screen');
    assert.deepEqual(must(keyframes[0], 'a keyframe').evidenceIds, observation.evidenceIds);
    assert.deepEqual(hub.updates(session, 1, 0).observations, published);
    const evidenceId = must(observation.evidenceIds[0], 'an evidence id');
    assert.equal((await session.service.evidence.resolve(evidenceId, {signal: new AbortController().signal})).frameId, 'frame');
    now += RULES.settleMs + 1;
    conductor.tick(); await settle();
    assert.match(preparedPrompt, /selected item/);
    if (app) assert.ok(preparedPrompt.includes(app));
    assert.equal(cues.filter(c => c.cue.type === 'ask').length, 0, 'typing prevents delivery');
    conductor.handle([{seq: 3, atMs: now - 100_000, event: {type: 'activity', state: 'pause'}}], 'web');
    now += RULES.pauseMs + 1;
    conductor.tick(); await settle();
    const ask = cues.find(c => c.cue.type === 'ask')?.cue;
    assert.ok(ask?.type === 'ask');
    assert.deepEqual(ask.evidenceIds, [evidenceId]);
    assert.deepEqual(ask.regions, [{regionId: 'details', label: 'Open details', box: [0.1, 0.2, 0.3, 0.1], evidenceId}]);
    conductor.handle([{seq: 4, atMs: now - 100_000, event: {type: 'off_record', on: true}}], 'web');
    hub.lifecycle(session, 1, 'pause', 'off_record');
    assert.equal(session.service.offer({sessionId: 'session', frameId: 'private-frame', timestampMs: 6, processed: true, mediaType: 'image/png', bytes: png}), 'inactive');
    await settle();
    assert.equal(published.length, 1, 'off-record stops observation delivery');
  });
}
