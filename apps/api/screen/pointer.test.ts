// The pointer hint on a frame upload (macOS app): parsed leniently, never a reason to refuse a frame, and added as
// one line to a generic frame's vision request only. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import {createMemoryEvidenceStore} from './evidence-store.ts';
import {createScreenHandlers} from './handlers.ts';
import {MAX_POINTER_TRAIL, parsePointerHint, pointerLine} from './pointer.ts';
import type {VisionRunner, VisionRunnerRequest} from './runner-client.ts';
import {createScreenService, defaultVisionPrompt, genericVisionPrompt} from './service.ts';
import {ScreenSessionHub} from './session-transport.ts';

const origin = 'https://demo.example';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const activity = {outcome: 'observation', kind: 'screen_activity', facts: {app: null, surface: 'settings page',
  summary: 'The pointer rests on a Save button.', change: null, entities: [], pendingAction: 'Save', pendingRegionId: 'r1',
  regions: [{id: 'r1', label: 'Save button', box: [0.6, 0.78, 0.08, 0.05]}]}};

test('a pointer hint parses, rounds and keeps at most 8 trail points', () => {
  const trail = Array.from({length: 12}, (_, index) => [0.1 + index * 0.01, 0.2, 1200 - index * 100.4]);
  const hint = parsePointerHint({x: 0.62, y: 0.81, dwellMs: 1400.6, trail});
  assert.ok(hint);
  assert.equal(hint.x, 0.62); assert.equal(hint.y, 0.81); assert.equal(hint.dwellMs, 1401);
  assert.equal(hint.trail.length, MAX_POINTER_TRAIL);
  assert.deepEqual(hint.trail[1], [0.11, 0.2, 1100]);
  // dwellMs and trail are optional.
  assert.deepEqual(parsePointerHint({x: 0, y: 1}), {x: 0, y: 1, dwellMs: 0, trail: []});
});

test('a malformed or absent pointer hint is null', () => {
  for (const value of [undefined, null, 'x', [0.5, 0.5], {x: 0.5}, {x: 1.2, y: 0.5}, {x: -0.1, y: 0.5},
    {x: 0.5, y: Number.NaN}, {x: 0.5, y: 0.5, dwellMs: -1}, {x: 0.5, y: 0.5, dwellMs: '900'},
    {x: 0.5, y: 0.5, trail: 'none'}, {x: 0.5, y: 0.5, trail: [[0.5, 0.5]]}, {x: 0.5, y: 0.5, trail: [[0.5, 2, 100]]},
    {x: 0.5, y: 0.5, trail: [[0.5, 0.5, -5]]}]) {
    assert.equal(parsePointerHint(value), null, JSON.stringify(value));
  }
});

test('the pointer line says resting, moving or at', () => {
  assert.equal(pointerLine({x: 0.62, y: 0.81, dwellMs: 1400, trail: []}), 'Pointer: resting 1.4 s at (0.62, 0.81).');
  assert.equal(pointerLine({x: 0.62, y: 0.81, dwellMs: 0, trail: [[0.3, 0.4, 900], [0.5, 0.6, 300]]}),
    'Pointer: moving from (0.30, 0.40) to (0.62, 0.81).');
  assert.equal(pointerLine({x: 0.62, y: 0.81, dwellMs: 0, trail: []}), 'Pointer: at (0.62, 0.81).');
  assert.equal(pointerLine({x: 0.62, y: 0.81, dwellMs: 0, trail: [[0.621, 0.81, 400]]}), 'Pointer: at (0.62, 0.81).');
});

test('the generic prompt explains the ring and holds no scenario facts', () => {
  assert.match(genericVisionPrompt, /magenta ring/);
  assert.match(genericVisionPrompt, /Pointer line/);
  assert.doesNotMatch(genericVisionPrompt, /customer_07|delivery address/i);
});

function request(url: string, method: 'GET' | 'POST', body?: unknown, token?: string): Request {
  return new Request(url, {method, headers: {origin, ...(body === undefined ? {} : {'content-type': 'application/json'}),
    ...(token ? {authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
/** One frame through the real HTTP path, with or without a `pointer` field; returns the status and the runner request. */
async function upload(extra: Record<string, unknown>, surface: 'email' | null = null): Promise<{status: number; sent: VisionRunnerRequest[]}> {
  const sent: VisionRunnerRequest[] = [];
  const runner: VisionRunner = {async vision(input) { sent.push(input); return {json: activity, ms: 2}; }};
  const hub = new ScreenSessionHub(({publish, onEvent}) => createScreenService({runner, parseObservation: parseScreenObservation,
    evidence: createMemoryEvidenceStore(), publish, onEvent, queueOptions: {sampleIntervalMs: 0, now: () => 100_010}}),
  parseScreenStatus, () => 100_010, 8, 128);
  const handlers = createScreenHandlers({hub, allowOrigin: () => true});
  const started = await (await handlers.start(request(`${origin}/s`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 's'}))
    .json() as {sessionToken: string};
  const response = await handlers.frames(request(`${origin}/s/frames`, 'POST', {generation: 1, frameId: 'frame-1', timestampMs: 5,
    processed: true, mediaType: 'image/png', data: png.toString('base64'),
    provenance: {surface, sourceRevision: null, captureGeneration: 1}, ...extra}, started.sessionToken), {sessionId: 's'});
  await tick();
  return {status: response.status, sent};
}

test('a frame with a pointer hint adds one Pointer line to the generic vision request', async () => {
  const {status, sent} = await upload({pointer: {x: 0.62, y: 0.81, dwellMs: 1400, trail: [[0.4, 0.5, 2000], [0.6, 0.8, 700]]}});
  assert.equal(status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.prompt, `${genericVisionPrompt}\nPointer: resting 1.4 s at (0.62, 0.81).`);
});

test('a frame without a pointer hint sends the generic prompt unchanged (the web path)', async () => {
  const {status, sent} = await upload({});
  assert.equal(status, 202);
  assert.equal(sent[0]?.prompt, genericVisionPrompt);
});

test('a malformed pointer hint is dropped and the frame still goes', async () => {
  const {status, sent} = await upload({pointer: {x: 7, y: 'left'}});
  assert.equal(status, 202);
  assert.equal(sent[0]?.prompt, genericVisionPrompt);
});

test('a workspace frame keeps its prompt even with a pointer hint', async () => {
  const {status, sent} = await upload({pointer: {x: 0.5, y: 0.5, dwellMs: 900}}, 'email');
  assert.equal(status, 202);
  assert.equal(sent[0]?.prompt, `${defaultVisionPrompt}\nAnalyze the email draft surface. Return its matching kind, or incomplete if it is not readable.`);
});

test('any other unknown upload key is still refused', async () => {
  const {status, sent} = await upload({cursor: {x: 0.5, y: 0.5}});
  assert.equal(status, 400);
  assert.equal(sent.length, 0);
});
