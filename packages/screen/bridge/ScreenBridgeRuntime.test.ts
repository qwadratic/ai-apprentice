import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import type {CaptureRuntime} from '../capture/ScreenCapture.ts';
import {loadBridgeRuntime} from './test-helpers.ts';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import {createMemoryEvidenceStore} from '../../../apps/api/screen/evidence-store.ts';
import {createScreenHandlers} from '../../../apps/api/screen/handlers.ts';
import {createScreenService} from '../../../apps/api/screen/service.ts';
import {ScreenSessionHub} from '../../../apps/api/screen/session-transport.ts';
import type {VisionRunner} from '../../../apps/api/screen/runner-client.ts';

const loaded = await loadBridgeRuntime();
const {createScreenBridgeRuntime} = loaded;
after(() => loaded.cleanup());

test('start opens the picker synchronously and uploads only the processed PNG with captured provenance', async () => {
  const harness = createHarness();
  let pickerCalled = false;
  harness.runtime.getDisplayMedia = () => { pickerCalled = true; return Promise.resolve(harness.stream as unknown as MediaStream); };
  const requests: Array<{url: string; body?: Record<string, unknown>}> = [];
  const instance = createScreenBridgeRuntime({apiBase: 'https://screen.test', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => 'email-r1', surface: () => 'email', captureRuntime: harness.runtime, frameIntervalMs: 1,
    fetch: async (input, init) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({url, ...(body ? {body} : {})});
      if (url.endsWith('/start')) {
        await tick();
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return Response.json({sessionId: 's', generation: 1, nextCursor: 0,
          status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      }
      if (url.endsWith('/frames')) return Response.json({ok: true, outcome: 'accepted', sessionId: 's', generation: 1, frameId: body!.frameId}, {status: 202});
      if (url.includes('/updates')) return Response.json({sessionId: 's', generation: 1, observations: [], statuses: [], nextCursor: 0});
      const command = JSON.parse(String(init?.body)).command as 'pause' | 'resume' | 'stop';
      const generation = (JSON.parse(String(init?.body)).generation as number) + 1;
      const state = command === 'pause' ? 'paused' : command === 'resume' ? 'capturing' : 'stopped';
      return Response.json({sessionId: 's', generation, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state}});
    }});
  const started = instance.bridge.start({sessionId: 's', sessionEpochMs: 0});
  assert.equal(pickerCalled, true, 'getDisplayMedia must run in the start call stack');
  await started;
  harness.video.videoWidth = 2; harness.video.videoHeight = 2; harness.video.readyState = 4;
  harness.step();
  const snapshot = instance.capture.getSnapshot();
  assert.ok(snapshot.geometry, JSON.stringify(snapshot));
  assert.equal(instance.capture.confirmMasks(snapshot.geometry!.revision), true);
  await instance.bridge.resume(); harness.step(); await tick(); await tick();
  const frame = requests.find(request => request.url.endsWith('/frames'))!.body!;
  assert.equal(frame.processed, true); assert.equal(frame.mediaType, 'image/png');
  assert.equal((frame.provenance as {captureGeneration: number}).captureGeneration > 0, true);
  assert.deepEqual({...frame.provenance as object, captureGeneration: undefined}, {surface: 'email', sourceRevision: 'email-r1', captureGeneration: undefined});
  assert.equal(typeof frame.data, 'string'); assert.equal('raw' in frame, false);
  instance.dispose();
});

test('off-record closes delivery before awaiting HTTP and panel resume cannot reopen it', async () => {
  const harness = createHarness(); let releasePause!: () => void;
  const pauseResponse = new Promise<Response>(resolve => { releasePause = () => resolve(Response.json({sessionId: 's', generation: 4, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'paused'}})); });
  let updatesResolve!: (response: Response) => void;
  const updates = new Promise<Response>(resolve => { updatesResolve = resolve; });
  let pauseCalls = 0;
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345', sourceRevision: () => 'order-r1',
    captureRuntime: harness.runtime, pollIntervalMs: 1, fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/start')) return Response.json({sessionId: 's', generation: 1, nextCursor: 0, status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      if (url.includes('/updates')) return updates;
      if (url.endsWith('/lifecycle')) {
        const command = JSON.parse(String(init?.body)).command;
        if (command === 'pause' && ++pauseCalls === 1) return Response.json({sessionId: 's', generation: 2, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'paused'}});
        if (command === 'resume') return Response.json({sessionId: 's', generation: 3, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}});
        return pauseResponse;
      }
      throw new Error(url);
    }});
  const seen: unknown[] = []; instance.bridge.onObservation(value => seen.push(value));
  await instance.bridge.start({sessionId: 's', sessionEpochMs: 0});
  harness.video.videoWidth = 2; harness.video.videoHeight = 2; harness.video.readyState = 4; harness.step();
  assert.ok(instance.capture.getSnapshot().geometry, JSON.stringify(instance.capture.getSnapshot()));
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision); await instance.bridge.resume();
  await tick();
  const pausing = instance.bridge.pause();
  assert.equal(instance.capture.getSnapshot().state, 'paused');
  await instance.panelController.resume();
  assert.equal(instance.capture.getSnapshot().state, 'paused', 'panel cannot clear app off-record state');
  updatesResolve(Response.json({sessionId: 's', generation: 3, observations: [observation()], statuses: [], nextCursor: 1}));
  await tick(); assert.deepEqual(seen, [], 'late poll results must be discarded');
  releasePause(); await pausing; instance.dispose();
});

test('real handlers complete start, frame, poll, pause, resume and post-stop Evidence', async () => {
  const harness = createHarness();
  const runner: VisionRunner = {async vision() { return {json: {outcome: 'observation', kind: 'email_draft',
    facts: {recipientRef: null, subject: 'Synthetic', bodyText: 'Visible', attachments: [], previewState: 'editing'}}, ms: 1}; }};
  const hub = new ScreenSessionHub(({publish, onEvent}) => createScreenService({runner, parseObservation: parseScreenObservation,
    evidence: createMemoryEvidenceStore(), publish, onEvent, queueOptions: {sampleIntervalMs: 0, now: () => harness.now()}}),
  parseScreenStatus, () => harness.now());
  const handlers = createScreenHandlers({hub, allowOrigin: () => true});
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = new Request(url, {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), origin: 'https://demo.example'}});
    const parts = url.pathname.split('/').filter(Boolean); const sessionId = decodeURIComponent(parts[2]!);
    if (parts.at(-1) === 'start') return handlers.start(request, {sessionId});
    if (parts.at(-1) === 'frames') return handlers.frames(request, {sessionId});
    if (parts.at(-1) === 'updates') return handlers.updates(request, {sessionId});
    if (parts.at(-1) === 'lifecycle') return handlers.lifecycle(request, {sessionId});
    const evidenceIndex = parts.indexOf('evidence'); const id = decodeURIComponent(parts[evidenceIndex + 1]!);
    return parts.at(-1) === 'asset' ? handlers.asset(request, {sessionId, id}) : handlers.resolve(request, {sessionId, id});
  };
  const instance = createScreenBridgeRuntime({apiBase: 'https://demo.example', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => 'email-r1', surface: () => 'email', captureRuntime: harness.runtime, frameIntervalMs: 1,
    pollIntervalMs: 1, fetch: transport});
  const observations: ReturnType<typeof parseScreenObservation>[] = [];
  instance.bridge.onObservation(value => observations.push(value));
  await instance.bridge.start({sessionId: 'real-session', sessionEpochMs: 0});
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision);
  await instance.bridge.resume(); harness.step();
  for (let attempt = 0; attempt < 20 && observations.length === 0; attempt++) await tick();
  assert.equal(observations.length, 1);
  const evidenceId = observations[0]!.evidenceIds[0]!;
  const live = await instance.bridge.resolveEvidence(evidenceId); assert.match(live.assetRef, /^blob:/);
  await instance.bridge.pause(); await instance.bridge.resume(); harness.step(); await tick();
  await instance.bridge.stop();
  const review = await instance.bridge.resolveEvidence(evidenceId); assert.match(review.assetRef, /^blob:/);
  instance.dispose();
});

test('workspace runtime correlates current vision, activity and checkpoint replies and rejects edits', async () => {
  const harness = createHarness(); let delivered = false; let deliverOldAfterEdit = false;
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => 'email-r1', captureRuntime: harness.runtime, pollIntervalMs: 1,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/start')) return Response.json({sessionId: 's', generation: 1, nextCursor: 0,
        status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      if (url.endsWith('/lifecycle')) {
        const body = JSON.parse(String(init?.body)); const generation = body.generation + 1;
        const state = body.command === 'pause' ? 'paused' : body.command === 'resume' ? 'capturing' : 'stopped';
        return Response.json({sessionId: 's', generation, nextCursor: 0, status: {schemaVersion: 1, sessionId: 's', state}});
      }
      if (url.includes('/updates')) {
        const generation = Number(new URL(url, 'https://test').searchParams.get('generation'));
        const observations = !delivered ? visualPair('s') : deliverOldAfterEdit ? [visualPair('s')[1]!] : [];
        delivered = true; deliverOldAfterEdit = false;
        return Response.json({sessionId: 's', generation, observations, statuses: [], nextCursor: observations.length});
      }
      throw new Error(url);
    }});
  await instance.bridge.start({sessionId: 's', sessionEpochMs: 0});
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision);
  const statuses: string[] = []; instance.bridge.onStatus(value => statuses.push(value.state)); statuses.length = 0;
  instance.bridge.onObservation(value => { if (value.kind === 'email_draft') (value.facts as {subject: string}).subject = 'mutated'; });
  const resuming = instance.bridge.resume();
  assert.equal(statuses.includes('capturing'), false, 'local capture resume must not announce server readiness');
  await resuming; assert.equal(statuses.at(-1), 'capturing');
  instance.workspace.setScope({sessionId: 's', revisions: {order: 'order-r1', email: 'email-r1'}});
  const waiting = instance.workspace.registry.waitForCurrent({sessionId: 's', revisions: {order: 'order-r1', email: 'email-r1'},
    signal: new AbortController().signal, timeoutMs: 500});
  const current = await waiting; assert.deepEqual(current.map(value => value.kind), ['order_view', 'email_draft']);
  assert.equal((instance.workspace.registry.snapshot('s').find(value => value.kind === 'email_draft')?.facts as {subject: string}).subject, '');
  const activity = instance.workspace.publishActivity({surface: 'email', typing: true, lastInputAtMs: 20, idleMs: 0});
  assert.equal(activity.source, 'workspace'); assert.equal(activity.sequence > current[1]!.sequence, true);
  const checkpoint = {schemaVersion: 1 as const, id: 'cp-1', sessionId: 's', timestampMs: 30,
    observationIds: current.map(value => value.id), revisions: {order: 'order-r1', email: 'email-r1'}, action: 'send' as const};
  const unsubscribe = instance.bridge.onCheckpoint(value => { unsubscribe(); void instance.bridge.replyToCheckpoint({schemaVersion: 1, checkpointId: value.id,
    status: 'clear', message: 'Visible facts match.', evidenceIds: value.observationIds.map(id => `e-${id}`), basedOn: value.revisions}); });
  assert.equal((await instance.workspace.dispatchCheckpoint(checkpoint)).status, 'clear');
  const pending = instance.workspace.dispatchCheckpoint({...checkpoint, id: 'cp-2'});
  instance.workspace.setScope({sessionId: 's', revisions: {order: 'order-r1', email: 'email-r2'}});
  await assert.rejects(pending, {name: 'AbortError'});
  deliverOldAfterEdit = true; await tick(); await tick();
  assert.deepEqual(instance.workspace.registry.snapshot('s').map(value => value.kind), ['order_view']);
  instance.dispose();
});

test('off-record latched before a session blocks panel start and resume', async () => {
  const harness = createHarness(); let pickerCalls = 0;
  harness.runtime.getDisplayMedia = async () => { pickerCalls++; return harness.stream as unknown as MediaStream; };
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => null, sourceRevision: () => null, captureRuntime: harness.runtime,
    fetch: async () => { throw new Error('network must remain closed'); }});
  await instance.bridge.pause();
  await assert.rejects(instance.bridge.start({sessionId: 's', sessionEpochMs: 0}), /off the record/);
  await instance.panelController.start({sessionId: 's', sessionEpochMs: 0});
  await instance.panelController.resume();
  assert.equal(pickerCalls, 0);
  assert.equal(instance.workspace.getSession(), null);
  instance.dispose();
});

test('failed app resume restores off-record privacy until a successful app resume', async () => {
  const harness = createHarness(); let resumeCalls = 0; let frameCalls = 0; let generation = 1;
  let failResume!: () => void; let markResumeRequested!: () => void;
  const resumeRequested = new Promise<void>(resolve => { markResumeRequested = resolve; });
  const failedResume = new Promise<Response>(resolve => { failResume = () => resolve(Response.json({ok: false}, {status: 503})); });
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => 'email-r1', surface: () => 'email', captureRuntime: harness.runtime, frameIntervalMs: 1,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/start')) return Response.json({sessionId: 's', generation, nextCursor: 0,
        status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      if (url.endsWith('/frames')) {
        frameCalls++;
        const body = JSON.parse(String(init?.body));
        return Response.json({ok: true, outcome: 'accepted', sessionId: 's', generation, frameId: body.frameId}, {status: 202});
      }
      if (url.includes('/updates')) return Response.json({sessionId: 's', generation, observations: [], statuses: [], nextCursor: 0});
      const command = JSON.parse(String(init?.body)).command as 'pause' | 'resume';
      if (command === 'resume' && ++resumeCalls === 2) { markResumeRequested(); return failedResume; }
      generation++;
      return Response.json({sessionId: 's', generation, nextCursor: 0,
        status: {schemaVersion: 1, sessionId: 's', state: command === 'resume' ? 'capturing' : 'paused'}});
    }});
  await instance.bridge.start({sessionId: 's', sessionEpochMs: 0});
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision);
  await instance.bridge.resume();
  await instance.bridge.pause();

  const resuming = instance.bridge.resume();
  await resumeRequested;
  const pausingAgain = instance.bridge.pause();
  failResume();
  await assert.rejects(resuming, /http_503/);
  await pausingAgain;
  await instance.panelController.resume();
  await instance.panelController.start({sessionId: 's', sessionEpochMs: 0});
  harness.step(); await tick(); await tick();
  assert.equal(instance.capture.getSnapshot().state, 'paused');
  assert.equal(frameCalls, 0, 'panel controls cannot upload after a failed app-owned resume');

  await instance.bridge.resume();
  harness.step(); await tick(); await tick();
  assert.equal(instance.capture.getSnapshot().state, 'capturing');
  assert.equal(frameCalls, 1, 'a successful app-owned resume releases the privacy latch');
  instance.dispose();
});

test('a runtime starts each session id once and accepts a distinct app session', async () => {
  const harness = createHarness(); let pickerCalls = 0; let startCalls = 0;
  harness.runtime.getDisplayMedia = async () => { pickerCalls++; return harness.stream as unknown as MediaStream; };
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => null, captureRuntime: harness.runtime, fetch: async (input, init) => {
      const url = new URL(String(input), 'https://test');
      const sessionId = decodeURIComponent(url.pathname.split('/')[3]!);
      if (url.pathname.endsWith('/start')) {
        startCalls++;
        return Response.json({sessionId, generation: 1, nextCursor: 0,
          status: {schemaVersion: 1, sessionId, state: 'capturing'}}, {status: 201});
      }
      const body = JSON.parse(String(init?.body));
      return Response.json({sessionId, generation: body.generation + 1, nextCursor: 0,
        status: {schemaVersion: 1, sessionId, state: 'stopped'}}, {status: 200});
    }});
  await instance.bridge.start({sessionId: 'first', sessionEpochMs: 0});
  await instance.bridge.stop();
  await assert.rejects(instance.panelController.start({sessionId: 'first', sessionEpochMs: 0}),
    /Start a new app session/);
  assert.equal(pickerCalls, 1, 'a rejected repeated session must not reopen the picker');
  assert.equal(startCalls, 1, 'a rejected repeated session must not reach the server');

  await instance.panelController.start({sessionId: 'second', sessionEpochMs: 10});
  assert.equal(pickerCalls, 2);
  assert.equal(startCalls, 2);
  instance.dispose();
});

test('a delayed resume failure cannot latch privacy on a replacement session', async () => {
  const harness = createHarness(); let oldResumeCalls = 0; let failOldResume!: () => void;
  const oldResumeFailure = new Promise<Response>(resolve => {
    failOldResume = () => resolve(Response.json({ok: false}, {status: 503}));
  });
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345',
    sourceRevision: () => null, captureRuntime: harness.runtime, fetch: async (input, init) => {
      const url = new URL(String(input), 'https://test');
      const sessionId = decodeURIComponent(url.pathname.split('/')[3]!);
      if (url.pathname.endsWith('/start')) return Response.json({sessionId, generation: 1, nextCursor: 0,
        status: {schemaVersion: 1, sessionId, state: 'capturing'}}, {status: 201});
      if (url.pathname.endsWith('/updates')) return Response.json({sessionId, generation: 1, observations: [], statuses: [], nextCursor: 0});
      const body = JSON.parse(String(init?.body));
      if (sessionId === 'old' && body.command === 'resume' && ++oldResumeCalls === 2) return oldResumeFailure;
      return Response.json({sessionId, generation: body.generation + 1, nextCursor: 0,
        status: {schemaVersion: 1, sessionId, state: body.command === 'pause' ? 'paused' : 'capturing'}}, {status: 200});
    }});
  await instance.bridge.start({sessionId: 'old', sessionEpochMs: 0});
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision);
  await instance.bridge.resume(); await instance.bridge.pause();
  const staleResume = instance.bridge.resume();
  await tick();

  const stoppingOld = instance.bridge.stop();
  const replacement = createHarness();
  harness.runtime.getDisplayMedia = async () => replacement.stream as unknown as MediaStream;
  await instance.bridge.start({sessionId: 'new', sessionEpochMs: 10});
  failOldResume();
  await assert.rejects(staleResume, /http_503/);
  await stoppingOld;
  instance.capture.confirmMasks(instance.capture.getSnapshot().geometry!.revision);
  await instance.panelController.resume();
  assert.equal(instance.capture.getSnapshot().state, 'capturing', 'old failure must not latch privacy on the new session');
  instance.dispose();
});

function observation() {
  return {schemaVersion: 1, id: 'o', sessionId: 's', sequence: 1, timestampMs: 1, source: 'vision', frameId: 'f',
    sourceRevision: 'order-r1', kind: 'order_view', facts: {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null},
    entityRef: null, evidenceIds: ['e']};
}
function visualPair(sessionId: string) {
  return [
    {schemaVersion: 1, id: 'order-1', sessionId, sequence: 1, timestampMs: 10, source: 'vision', frameId: 'f-order',
      sourceRevision: 'order-r1', kind: 'order_view', facts: {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null}, entityRef: null, evidenceIds: ['e-order']},
    {schemaVersion: 1, id: 'email-1', sessionId, sequence: 2, timestampMs: 11, source: 'vision', frameId: 'f-email',
      sourceRevision: 'email-r1', kind: 'email_draft', facts: {recipientRef: null, subject: '', bodyText: '', attachments: [], previewState: 'preview'}, entityRef: null, evidenceIds: ['e-email']},
  ];
}
function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
function createHarness() {
  const callbacks: FrameRequestCallback[] = [];
  let clock = 10;
  const track = new EventTarget() as EventTarget & {readyState: MediaStreamTrackState; muted: boolean; enabled: boolean; stop(): void};
  track.readyState = 'live'; track.muted = false; track.enabled = true; track.stop = () => { track.readyState = 'ended'; };
  const stream = {getAudioTracks: () => [], getVideoTracks: () => [track], getTracks: () => [track]};
  const video = new EventTarget() as EventTarget & {muted: boolean; playsInline: boolean; srcObject: unknown; readyState: number;
    videoWidth: number; videoHeight: number; play(): Promise<void>; pause(): void};
  Object.assign(video, {muted: false, playsInline: false, srcObject: null, readyState: 4, videoWidth: 2, videoHeight: 2,
    play: async () => undefined, pause: () => undefined});
  const context = {save() {}, restore() {}, setTransform() {}, globalAlpha: 1, globalCompositeOperation: 'source-over', drawImage() {}, fillRect() {}, fillStyle: '#000'};
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64'));
  const canvas = {width: 0, height: 0, getContext: () => context,
    toBlob(callback: BlobCallback) { callback(new Blob([png], {type: 'image/png'})); }};
  const runtime: CaptureRuntime = {getDisplayMedia: async () => stream as unknown as MediaStream, createVideo: () => video as unknown as HTMLVideoElement,
    createCanvas: () => canvas as unknown as HTMLCanvasElement, now: () => clock, schedule: callback => { callbacks.push(callback); return callbacks.length; },
    cancel: () => undefined};
  return {runtime, stream, video, now: () => clock, step: () => { clock += 10; callbacks.shift()?.(clock); }};
}
