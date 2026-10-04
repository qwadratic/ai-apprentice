import assert from 'node:assert/strict';
import test from 'node:test';
import {createScreenBridgeRuntime} from './ScreenBridgeRuntime.js';
import type {CaptureRuntime} from '../capture/ScreenCapture.ts';

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
      if (url.endsWith('/start')) return Response.json({sessionId: 's', generation: 1, nextCursor: 0,
        status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      if (url.endsWith('/frames')) return Response.json({ok: true, outcome: 'accepted', sessionId: 's', generation: 1, frameId: body!.frameId}, {status: 202});
      if (url.includes('/updates')) return Response.json({sessionId: 's', generation: 1, observations: [], statuses: [], nextCursor: 0});
      return Response.json({sessionId: 's', generation: 2, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}});
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
  const pauseResponse = new Promise<Response>(resolve => { releasePause = () => resolve(Response.json({sessionId: 's', generation: 3, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'paused'}})); });
  let updatesResolve!: (response: Response) => void;
  const updates = new Promise<Response>(resolve => { updatesResolve = resolve; });
  const instance = createScreenBridgeRuntime({apiBase: '', authHeader: () => 'Bearer browser-session-token-12345', sourceRevision: () => 'order-r1',
    captureRuntime: harness.runtime, pollIntervalMs: 1, fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/start')) return Response.json({sessionId: 's', generation: 1, nextCursor: 0, status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}}, {status: 201});
      if (url.includes('/updates')) return updates;
      if (url.endsWith('/lifecycle')) {
        const command = JSON.parse(String(init?.body)).command;
        if (command === 'resume') return Response.json({sessionId: 's', generation: 2, nextCursor: 1, status: {schemaVersion: 1, sessionId: 's', state: 'capturing'}});
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
  updatesResolve(Response.json({sessionId: 's', generation: 1, observations: [observation()], statuses: [], nextCursor: 1}));
  await tick(); assert.deepEqual(seen, [], 'late poll results must be discarded');
  releasePause(); await pausing; instance.dispose();
});

function observation() {
  return {schemaVersion: 1, id: 'o', sessionId: 's', sequence: 1, timestampMs: 1, source: 'vision', frameId: 'f',
    sourceRevision: 'order-r1', kind: 'order_view', facts: {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null},
    entityRef: null, evidenceIds: ['e']};
}
function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
function createHarness() {
  const callbacks: FrameRequestCallback[] = [];
  const track = new EventTarget() as EventTarget & {readyState: MediaStreamTrackState; muted: boolean; enabled: boolean; stop(): void};
  track.readyState = 'live'; track.muted = false; track.enabled = true; track.stop = () => { track.readyState = 'ended'; };
  const stream = {getAudioTracks: () => [], getVideoTracks: () => [track], getTracks: () => [track]};
  const video = new EventTarget() as EventTarget & {muted: boolean; playsInline: boolean; srcObject: unknown; readyState: number;
    videoWidth: number; videoHeight: number; play(): Promise<void>; pause(): void};
  Object.assign(video, {muted: false, playsInline: false, srcObject: null, readyState: 4, videoWidth: 2, videoHeight: 2,
    play: async () => undefined, pause: () => undefined});
  const context = {save() {}, restore() {}, setTransform() {}, globalAlpha: 1, globalCompositeOperation: 'source-over', drawImage() {}, fillRect() {}, fillStyle: '#000'};
  const canvas = {width: 0, height: 0, getContext: () => context,
    toBlob(callback: BlobCallback) { callback(new Blob([new Uint8Array([1, 2, 3])], {type: 'image/png'})); }};
  const runtime: CaptureRuntime = {getDisplayMedia: async () => stream as unknown as MediaStream, createVideo: () => video as unknown as HTMLVideoElement,
    createCanvas: () => canvas as unknown as HTMLCanvasElement, now: () => 10, schedule: callback => { callbacks.push(callback); return callbacks.length; },
    cancel: () => undefined};
  return {runtime, stream, video, step: () => callbacks.shift()?.(10)};
}
