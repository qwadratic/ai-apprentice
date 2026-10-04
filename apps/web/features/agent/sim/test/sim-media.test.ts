import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURRENT_TAB_OPTIONS, SimMediaInstalledError, installSimMedia, installSimMediaIfRequested, simModeFromSearch } from '../sim-media.ts';
import { FakeMediaDevices, FakeStream, FakeTrack, asStream, createFakeStream } from './helpers.ts';

function fakeMic() {
  const clones: FakeStream[] = [];
  return {
    clones,
    cloneStream: (): MediaStream => {
      const stream = new FakeStream([new FakeTrack('audio')]);
      clones.push(stream);
      return asStream(stream);
    },
  };
}

test('importing the module installs nothing: the page keeps its own getUserMedia and getDisplayMedia', async () => {
  const devices = new FakeMediaDevices();
  const before = { user: devices.getUserMedia, display: devices.getDisplayMedia };
  await import('../sim-media.ts');
  assert.equal(devices.getUserMedia, before.user);
  assert.equal(devices.getDisplayMedia, before.display);
  assert.equal(Object.getOwnPropertySymbols(devices).length, 0);
});

test('installSimMedia sends an audio request to the synthetic mic and a clone of its stream to every caller', async () => {
  const devices = new FakeMediaDevices();
  const mic = fakeMic();
  const installed = installSimMedia({ mic, mediaDevices: devices, createStream: createFakeStream });
  const a = await devices.getUserMedia({ audio: true });
  const b = await devices.getUserMedia({ audio: { echoCancellation: true } });
  assert.equal(mic.clones.length, 2);
  assert.notEqual(a, b);
  assert.equal(devices.userMediaCalls.length, 0, 'the real device was never asked');
  assert.deepEqual(installed.calls, [
    { kind: 'getUserMedia', synthetic: true },
    { kind: 'getUserMedia', synthetic: true },
  ]);
});

test('a request that is not for audio goes to the real device; audio plus video mixes the two', async () => {
  const devices = new FakeMediaDevices();
  const mic = fakeMic();
  installSimMedia({ mic, mediaDevices: devices, createStream: createFakeStream });
  const camera = await devices.getUserMedia({ video: true });
  assert.equal(camera.getVideoTracks().length, 1);
  assert.deepEqual(devices.userMediaCalls, [{ video: true }]);
  const both = await devices.getUserMedia({ audio: true, video: true });
  assert.equal(both.getAudioTracks().length, 1);
  assert.equal(both.getVideoTracks().length, 1);
  // The real device was asked for the video only.
  assert.deepEqual(devices.userMediaCalls[1], { video: true });
});

test('getDisplayMedia asks for the current tab, keeps the caller\'s options and cannot be talked out of the tab', async () => {
  const devices = new FakeMediaDevices();
  installSimMedia({ mic: fakeMic(), mediaDevices: devices, createStream: createFakeStream });
  await devices.getDisplayMedia({ video: true, audio: false });
  await devices.getDisplayMedia({ video: { frameRate: 2 }, preferCurrentTab: false, selfBrowserSurface: 'exclude' });
  await devices.getDisplayMedia();
  assert.deepEqual(devices.displayCalls[0], { video: true, audio: false, ...CURRENT_TAB_OPTIONS });
  assert.deepEqual(devices.displayCalls[1], { video: { frameRate: 2 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
  assert.deepEqual(devices.displayCalls[2], { video: true, audio: false, ...CURRENT_TAB_OPTIONS });
  assert.equal(CURRENT_TAB_OPTIONS.preferCurrentTab, true);
  assert.equal(CURRENT_TAB_OPTIONS.selfBrowserSurface, 'include');
});

test('screen: false leaves getDisplayMedia alone', () => {
  const devices = new FakeMediaDevices();
  const original = devices.getDisplayMedia;
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices, screen: false });
  assert.equal(devices.getDisplayMedia, original);
  installed.restore();
});

test('restore() puts the originals back, also when they lived on the prototype, and can be called twice', async () => {
  const devices = new FakeMediaDevices();
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices });
  assert.ok(Object.prototype.hasOwnProperty.call(devices, 'getUserMedia'), 'installed as an own property');
  installed.restore();
  installed.restore();
  assert.equal(Object.prototype.hasOwnProperty.call(devices, 'getUserMedia'), false, 'the prototype method shows again');
  assert.equal(Object.prototype.hasOwnProperty.call(devices, 'getDisplayMedia'), false);
  const stream = await devices.getUserMedia({ audio: true });
  assert.equal(devices.userMediaCalls.length, 1, 'the real getUserMedia answers again');
  assert.equal(stream.getAudioTracks().length, 1);
  // And it can be installed again.
  installSimMedia({ mic: fakeMic(), mediaDevices: devices }).restore();
});

test('restore() puts back an own-property original', () => {
  const devices = new FakeMediaDevices();
  const own = (): Promise<MediaStream> => Promise.resolve(asStream(new FakeStream()));
  Object.defineProperty(devices, 'getUserMedia', { value: own, writable: true, configurable: true });
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices });
  assert.notEqual(devices.getUserMedia, own);
  installed.restore();
  assert.equal(devices.getUserMedia, own);
});

test('installing twice on the same devices is refused', () => {
  const devices = new FakeMediaDevices();
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices });
  assert.throws(() => installSimMedia({ mic: fakeMic(), mediaDevices: devices }), SimMediaInstalledError);
  installed.restore();
});

test('?sim= decides: the guard installs for expert and newhire and touches nothing otherwise', () => {
  assert.equal(simModeFromSearch(''), null);
  assert.equal(simModeFromSearch('?foo=1'), null);
  assert.equal(simModeFromSearch('?sim='), null);
  assert.equal(simModeFromSearch('?sim=nobody'), null);
  assert.equal(simModeFromSearch('?sim=expert'), 'expert');
  assert.equal(simModeFromSearch('?x=1&sim=Expert'), 'expert');
  assert.equal(simModeFromSearch('?sim=newhire'), 'newHire');
  assert.equal(simModeFromSearch('?sim=new-hire'), 'newHire');
  assert.equal(simModeFromSearch('?sim=newHire'), 'newHire');

  const off = new FakeMediaDevices();
  const original = { user: off.getUserMedia, display: off.getDisplayMedia };
  assert.equal(installSimMediaIfRequested('?mode=learn', { mic: fakeMic(), mediaDevices: off }), null);
  assert.equal(off.getUserMedia, original.user);
  assert.equal(off.getDisplayMedia, original.display);
  assert.equal(Object.prototype.hasOwnProperty.call(off, 'getUserMedia'), false);

  const on = new FakeMediaDevices();
  const result = installSimMediaIfRequested('?sim=expert', { mic: fakeMic(), mediaDevices: on });
  assert.equal(result?.persona, 'expert');
  assert.ok(Object.prototype.hasOwnProperty.call(on, 'getUserMedia'));
  result?.media.restore();
});

// ---- the screen fallback (browsers that cannot capture a tab) ------------------------------------------------------------

function fallbackStream(): { calls: number; provider: () => Promise<MediaStream>; stream: MediaStream } {
  const stream = asStream(new FakeStream([new FakeTrack('video')]));
  const state = { calls: 0, stream, provider: (): Promise<MediaStream> => { state.calls += 1; return Promise.resolve(stream); } };
  return state;
}

test('fallback: a tab capture that works is used and the fallback stays unused', async () => {
  const devices = new FakeMediaDevices();
  const fb = fallbackStream();
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices, screen: { fallback: fb.provider } });
  const stream = await devices.getDisplayMedia({ video: true });
  assert.notEqual(stream, fb.stream);
  assert.equal(fb.calls, 0);
  assert.deepEqual(installed.calls.at(-1), { kind: 'getDisplayMedia', synthetic: true, via: 'tab' });
});

test('fallback: a tab capture that fails (NotReadableError in headless Chrome) falls back to the screen source', async () => {
  const devices = new FakeMediaDevices();
  devices.getDisplayMedia = (): Promise<MediaStream> => Promise.reject(new DOMException('Could not start video source', 'NotReadableError'));
  const fb = fallbackStream();
  const installed = installSimMedia({ mic: fakeMic(), mediaDevices: devices, screen: { fallback: fb.provider } });
  assert.equal(await devices.getDisplayMedia!({ video: true }), fb.stream);
  assert.equal(fb.calls, 1);
  assert.deepEqual(installed.calls.at(-1), { kind: 'getDisplayMedia', synthetic: true, via: 'fallback' });
});

test('fallback: a tab capture that never answers falls back after the timeout, and a late stream is ended', async () => {
  const devices = new FakeMediaDevices();
  const late = new FakeStream([new FakeTrack('video')]);
  let answer: (s: MediaStream) => void = () => undefined;
  devices.getDisplayMedia = (): Promise<MediaStream> => new Promise((resolve) => { answer = resolve; });
  const fb = fallbackStream();
  installSimMedia({ mic: fakeMic(), mediaDevices: devices, screen: { fallback: fb.provider, timeoutMs: 30 } });
  assert.equal(await devices.getDisplayMedia!({ video: true }), fb.stream);
  answer(asStream(late));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(late.tracks.every((t) => t.stopped), 'the late capture was ended');
});

test('fallback: forceFallback skips the real call; without a fallback a failing capture still fails', async () => {
  const devices = new FakeMediaDevices();
  const fb = fallbackStream();
  installSimMedia({ mic: fakeMic(), mediaDevices: devices, screen: { fallback: fb.provider, forceFallback: true } }).restore();
  const forced = new FakeMediaDevices();
  installSimMedia({ mic: fakeMic(), mediaDevices: forced, screen: { fallback: fb.provider, forceFallback: true } });
  assert.equal(await forced.getDisplayMedia({ video: true }), fb.stream);
  assert.equal(forced.displayCalls.length, 0, 'the real call was never made');

  const failing = new FakeMediaDevices();
  failing.getDisplayMedia = (): Promise<MediaStream> => Promise.reject(new DOMException('no', 'NotReadableError'));
  installSimMedia({ mic: fakeMic(), mediaDevices: failing });
  await assert.rejects(failing.getDisplayMedia!({ video: true }), /no/);
});
