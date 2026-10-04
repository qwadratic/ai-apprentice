// Generic vision storyboards: a call for a frame with no workspace surface sees up to K recent frames, oldest first,
// so `change` can describe what moved. Workspace frames keep one image and their pinned request. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import type {ScreenObservation} from '@apprentice/contracts';
import {createScreenRuntime} from '../src/screen-runtime.ts';
import {createMemoryEvidenceStore} from './evidence-store.ts';
import type {VisionRunner, VisionRunnerRequest} from './runner-client.ts';
import {createScreenService, defaultVisionPrompt, genericStoryboardPrompt, genericVisionPrompt, genericVisionSystem,
  visibleOnlySystem} from './service.ts';
import type {ScreenService} from './service.ts';
import {ScreenSessionHub} from './session-transport.ts';
import {FrameStoryboard, MAX_STORYBOARD_FRAMES, parseVisionFrames, STORYBOARD_DEFAULTS} from './storyboard.ts';
import type {StoryboardFrame, StoryboardOptions} from './storyboard.ts';
import {VISION_RESULT_SCHEMA, WORKSPACE_VISION_SCHEMA} from './vision-contract.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
/** A distinct synthetic PNG per n: the signature is checked, the trailing byte makes the pixels "change". */
const image = (n: number): Buffer => Buffer.concat([png, Buffer.from([n])]);
const b64 = (n: number): string => image(n).toString('base64');
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const activity = {outcome: 'observation', kind: 'screen_activity', facts: {app: 'Sheets', surface: 'sheet Q1 budget',
  summary: 'A budget table with three synthetic rows is open.', change: 'Row 4 was added.', entities: ['Total: 1,250'],
  pendingAction: null, pendingRegionId: null, regions: [{id: 'r1', label: 'row 4', box: [0.1, 0.4, 0.8, 0.05]}]}};
const email = {outcome: 'observation', kind: 'email_draft', facts: {recipientRef: null, subject: 'Synthetic',
  bodyText: 'Visible text', attachments: [], previewState: 'editing'}};
const frame = (n: number, timestampMs: number, bytes = image(n)): StoryboardFrame =>
  ({frameId: `frame-${n}`, timestampMs, mediaType: 'image/png', bytes});

interface Rig {
  readonly service: ScreenService; readonly sent: VisionRunnerRequest[]; readonly published: ScreenObservation[];
  offer(n: number, timestampMs: number, surface?: 'email' | null): Promise<string>;
}
/** A service whose queue clock follows the frames, so frames seconds apart are neither stale nor from the future. */
function rig(storyboard?: Partial<StoryboardOptions>): Rig {
  const sent: VisionRunnerRequest[] = []; const published: ScreenObservation[] = []; let clock = 1;
  const runner: VisionRunner = {async vision(input) { sent.push(input); return {json: input.schema === WORKSPACE_VISION_SCHEMA ? email : activity, ms: 1}; }};
  const service = createScreenService({runner, parseObservation: parseScreenObservation, evidence: createMemoryEvidenceStore(),
    publish: observation => { published.push(observation); }, queueOptions: {sampleIntervalMs: 0, now: () => clock},
    ...(storyboard ? {storyboard} : {})});
  service.start({sessionId: 'session', sessionEpochMs: 0});
  return {service, sent, published, async offer(n, timestampMs, surface = null) {
    clock = timestampMs + 1;
    const outcome = service.offer({sessionId: 'session', frameId: `frame-${n}`, timestampMs, processed: true,
      mediaType: 'image/png', bytes: image(n)}, {surface, sourceRevision: surface ? `${surface}-r1` : null});
    for (let i = 0; i < 50 && (service.snapshot().active > 0 || service.snapshot().queued > 0); i++) await tick();
    return outcome;
  }};
}

test('the storyboard keeps the last K frames, oldest first, and always ends with the analysed frame', () => {
  const board = new FrameStoryboard({frames: 3});
  for (let n = 1; n <= 5; n++) board.record(frame(n, n * 1000));
  assert.equal(board.size, 3, 'bounded to K entries');
  assert.deepEqual(board.framesFor(frame(6, 6000)).map(item => item.frameId), ['frame-4', 'frame-5', 'frame-6']);
  // The analysed frame may already be in the ring (it was pending): it is sent once, last.
  assert.deepEqual(board.framesFor(frame(5, 5000)).map(item => item.frameId), ['frame-3', 'frame-4', 'frame-5']);
  // Frames captured after the analysed one are never in its storyboard.
  assert.deepEqual(board.framesFor(frame(9, 3500)).map(item => item.frameId), ['frame-3', 'frame-9']);
  board.clear(); assert.equal(board.size, 0); assert.equal(board.bytes, 0);
  assert.deepEqual(board.framesFor(frame(7, 7000)).map(item => item.frameId), ['frame-7']);
  const single = new FrameStoryboard({frames: 1}); single.record(frame(1, 1000));
  assert.equal(single.size, 0, 'K = 1 keeps nothing in memory');
  // The same pixels accepted again (after a failed call) stay one entry and never sit next to themselves in a call.
  const again = new FrameStoryboard({frames: 3});
  again.record(frame(1, 1000)); again.record(frame(2, 2000)); again.record({...frame(2, 3000), frameId: 'frame-2b'});
  assert.equal(again.size, 2);
  assert.deepEqual(again.framesFor({...frame(2, 4000), frameId: 'frame-2c'}).map(item => item.frameId), ['frame-1', 'frame-2c']);
});

test('earlier frames older than ~10 s or past the byte budget are left out; a duplicate refreshes its time', () => {
  const board = new FrameStoryboard({frames: 4});
  board.record(frame(1, 0)); board.record(frame(2, 1500));
  assert.deepEqual(board.framesFor(frame(3, 11_600)).map(item => item.frameId), ['frame-3'], 'both earlier frames are > 10 s old');
  assert.deepEqual(board.framesFor(frame(3, 11_400)).map(item => item.frameId), ['frame-2', 'frame-3']);
  // The screen stayed the same (duplicates of frame 2) until 9 s: frame 2 was still visible then, so it is a fresh "before".
  board.seen(frame(2, 9000)); board.seen(frame(8, 9500));
  assert.deepEqual(board.framesFor(frame(3, 18_000)).map(item => item.frameId), ['frame-2', 'frame-3']);
  assert.equal(STORYBOARD_DEFAULTS.maxAgeMs, 10_000);
  const big = (n: number): Buffer => Buffer.concat([png, Buffer.alloc(1000, n)]);
  const budget = new FrameStoryboard({frames: 4, maxBytes: 2 * big(0).length + 50});
  budget.record(frame(1, 1000, big(1))); budget.record(frame(2, 2000, big(2))); budget.record(frame(3, 3000, big(3)));
  assert.ok(budget.bytes <= 2 * big(0).length + 50 && budget.size === 2, 'the ring drops its oldest frames past the byte budget');
  assert.deepEqual(budget.framesFor(frame(4, 4000, big(4))).map(item => item.frameId), ['frame-3', 'frame-4']);
  const huge = Buffer.concat([png, Buffer.alloc(5000)]);
  assert.deepEqual(budget.framesFor(frame(5, 5000, huge)).map(item => item.frameId), ['frame-5'], 'the analysed frame is always sent');
  for (const limits of [{frames: 0}, {frames: MAX_STORYBOARD_FRAMES + 1}, {frames: 2.5}, {maxAgeMs: -1}, {maxBytes: 0}]) {
    assert.throws(() => new FrameStoryboard(limits), TypeError, JSON.stringify(limits));
  }
});

test('VISION_FRAMES parses to 1..4 with default 3', () => {
  assert.equal(STORYBOARD_DEFAULTS.frames, 3); assert.equal(MAX_STORYBOARD_FRAMES, 4);
  for (const [value, expected] of [[undefined, 3], ['', 3], ['abc', 3], ['2.5', 3], ['1', 1], ['2', 2], ['4', 4], ['9', 4],
    ['0', 1], ['-3', 1], [' 2 ', 2]] as const) assert.equal(parseVisionFrames(value), expected, String(value));
});

test('a generic frame is analysed with the last K frames, oldest first, and the latest frame stays the Evidence', async () => {
  const {service, sent, published, offer} = rig();
  for (let n = 1; n <= 4; n++) assert.equal(await offer(n, n * 1500), 'accepted');
  assert.deepEqual(sent.map(request => request.images.length), [1, 2, 3, 3]);
  assert.equal(sent[0]?.prompt, genericVisionPrompt, 'a single frame keeps the one-frame request');
  const request = sent[3];
  if (!request) throw new Error('expected four runner requests');
  assert.deepEqual(request.images.map(item => item.data), [b64(2), b64(3), b64(4)], 'oldest first, the analysed frame last');
  assert.equal(request.prompt, genericStoryboardPrompt(3)); assert.equal(request.system, genericVisionSystem);
  assert.equal(request.schema, VISION_RESULT_SCHEMA);
  assert.match(request.prompt, /You see 3 consecutive frames from the last seconds, oldest first\. Describe only the LATEST frame/);
  assert.match(request.prompt, /change says in a few words what visibly changed across the frames/);
  assert.match(request.prompt, /Each box is \[x, y, width, height\] normalised 0\.\.1 to the processed frame/);
  assert.equal(request.prompt.includes('You see one frame'), false);
  assert.equal(published.length, 4);
  const last = published[3];
  if (last?.kind !== 'screen_activity') throw new Error('expected a screen_activity observation');
  assert.equal(last.frameId, 'frame-4'); assert.equal(last.evidenceIds.length, 1);
  const evidence = await service.evidence.read(last.evidenceIds[0] ?? '', {});
  assert.equal(evidence.record.frameId, 'frame-4'); assert.deepEqual(evidence.bytes, image(4));
  // A duplicate (same pixels) is not a new storyboard frame.
  assert.equal(await offer(4, 7000), 'duplicate'); assert.equal(sent.length, 4);
});

test('pause (off the record), resume and stop clear the storyboard', async () => {
  for (const reset of ['pause', 'stop'] as const) {
    const {service, sent, offer} = rig();
    await offer(1, 1500); await offer(2, 3000);
    assert.equal(sent.at(-1)?.images.length, 2);
    if (reset === 'pause') { service.pause(); service.resume(); } else { service.stop(); service.start({sessionId: 'session', sessionEpochMs: 0}); }
    await offer(3, 4500);
    assert.equal(sent.at(-1)?.images.length, 1, `${reset} starts a new storyboard`);
    assert.equal(sent.at(-1)?.prompt, genericVisionPrompt);
    assert.deepEqual(sent.at(-1)?.images.map(item => item.data), [b64(3)]);
  }
  // Through the session hub: off the record is a lifecycle pause with that reason.
  const sent: VisionRunnerRequest[] = []; let clock = 100_000;
  const runner: VisionRunner = {async vision(input) { sent.push(input); return {json: activity, ms: 1}; }};
  const hub = new ScreenSessionHub(({publish, onEvent}) => createScreenService({runner, parseObservation: parseScreenObservation,
    evidence: createMemoryEvidenceStore(), publish, onEvent, queueOptions: {sampleIntervalMs: 0, now: () => clock}}),
  parseScreenStatus, () => clock);
  const started = hub.start('session', 100_000, 1); const session = hub.authenticate('session', started.sessionToken);
  const offer = async (n: number, generation: number): Promise<void> => {
    clock = 100_000 + n * 1500 + 1;
    hub.offer(session, {generation, frame: {sessionId: 'session', frameId: `frame-${n}`, timestampMs: n * 1500, processed: true,
      mediaType: 'image/png', bytes: image(n)}, provenance: {surface: null, sourceRevision: null, captureGeneration: 1}});
    for (let i = 0; i < 50 && session.service.snapshot().active > 0; i++) await tick();
  };
  await offer(1, 1); await offer(2, 1);
  assert.equal(sent.at(-1)?.images.length, 2);
  const paused = hub.lifecycle(session, 1, 'pause', 'off_record'); assert.equal(paused.status.reason, 'off_record');
  hub.lifecycle(session, paused.generation, 'resume');
  await offer(3, paused.generation + 1);
  assert.deepEqual(sent.at(-1)?.images.map(item => item.data), [b64(3)], 'nothing from before off the record is sent');
});

test('a workspace frame keeps one image and its pinned prompt, system and schema', async () => {
  const {sent, offer} = rig();
  for (let n = 1; n <= 3; n++) await offer(n, n * 1500, 'email');
  await offer(4, 6000); await offer(5, 7500, 'email');
  const workspace = sent.filter(request => request.schema === WORKSPACE_VISION_SCHEMA);
  assert.equal(workspace.length, 4);
  for (const request of workspace) {
    assert.equal(request.images.length, 1);
    assert.equal(request.prompt, `${defaultVisionPrompt}\nAnalyze the email draft surface. Return its matching kind, or incomplete if it is not readable.`);
    assert.equal(request.system, visibleOnlySystem);
  }
  assert.deepEqual(workspace.map(request => request.images[0]?.data), [b64(1), b64(2), b64(3), b64(5)]);
  // Workspace frames never enter the storyboard: the generic frame in between went alone.
  const generic = sent.find(request => request.schema === VISION_RESULT_SCHEMA);
  assert.deepEqual(generic?.images.map(item => item.data), [b64(4)]);
  assert.equal(createHash('sha256').update(JSON.stringify([defaultVisionPrompt, visibleOnlySystem])).digest('hex'),
    '9a1822228191f8d5524dd4b9f947844b3ad0946db457a7acec8d884960775eec');
});

test('VISION_FRAMES=1 sends exactly the request from before storyboards', async t => {
  // [genericVisionPrompt, genericVisionSystem] before storyboards, byte for byte.
  assert.equal(createHash('sha256').update(JSON.stringify([genericVisionPrompt, genericVisionSystem])).digest('hex'),
    '2b83aa33855b5cca4b62de793a304d8881ad7329f42aea148ff74de702f51e5c');
  const {sent, offer} = rig({frames: 1});
  for (let n = 1; n <= 3; n++) await offer(n, n * 1500);
  assert.equal(sent.length, 3);
  for (const [index, request] of sent.entries()) {
    assert.deepEqual(request, {images: [{media_type: 'image/png', data: b64(index + 1)}], prompt: genericVisionPrompt,
      system: genericVisionSystem, schema: VISION_RESULT_SCHEMA});
  }
  // The runtime reads VISION_FRAMES from its env; unset means 3.
  const root = await mkdtemp(path.join(os.tmpdir(), 'vision-frames-'));
  t.after(async () => { await rm(root, {recursive: true, force: true}); });
  // Both runtimes run side by side: the queue's real 1.5 s sample interval separates the two frames.
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const runs = await Promise.all(([[{VISION_FRAMES: '1'}, [1, 1]], [{}, [1, 2]]] as const).map(async ([env, expected]) => {
    const calls: VisionRunnerRequest[] = [];
    const runner: VisionRunner = {async vision(input) { calls.push(input); return {json: activity, ms: 1}; }};
    const dir = await mkdtemp(path.join(root, 'run-'));
    const runtime = createScreenRuntime({databasePath: path.join(dir, 'screen.sqlite'), mediaDir: path.join(dir, 'media'), runner, env});
    try {
      const epoch = Date.now() - 10_000;
      const started = runtime.hub.start('session', epoch, 1);
      const session = runtime.hub.authenticate('session', started.sessionToken);
      for (const [n, timestampMs] of [[1, 6000], [2, 8000]] as const) {
        if (n > 1) await wait(1600);
        assert.equal(session.service.offer({sessionId: 'session', frameId: `frame-${n}`, timestampMs, processed: true,
          mediaType: 'image/png', bytes: image(n)}), 'accepted');
        for (let i = 0; i < 100 && (calls.length < n || session.service.snapshot().active > 0); i++) await wait(5);
      }
      return {env, expected, images: calls.map(request => request.images.length)};
    } finally {
      runtime.close();
    }
  }));
  for (const run of runs) assert.deepEqual(run.images, run.expected, JSON.stringify(run.env));
});
