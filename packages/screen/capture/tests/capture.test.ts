import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { FrameLease, ProcessedFrame } from '../ScreenCapture.ts';
import { loadModules, harness, deferred, flush } from './helpers.ts';

const { ScreenCapture, DEFAULT_FRAME_ENCODING, validateMasks, maskPixels, cleanup } = await loadModules();
after(cleanup);
const mask = { id: 'synthetic-email', x: 0.1, y: 0.2, width: 0.4, height: 0.2 };

test('reject malformed masks; round fractional edges outwards', () => {
  for (const bad of [{ ...mask, x: NaN }, { ...mask, x: -0.1 }, { ...mask, width: 0 }, { ...mask, x: 0.8 }, { ...mask, id: '' }]) {
    assert.throws(() => validateMasks([bad]), RangeError);
  }
  assert.throws(() => validateMasks([mask, mask]), RangeError);
  const masks = validateMasks([mask]);
  assert.ok(Object.isFrozen(masks) && Object.isFrozen(masks[0]));
  assert.deepEqual(maskPixels({ ...mask, x: 0.101, width: 0.401 }, 100, 60), { x: 10, y: 12, width: 41, height: 12 });
});

test('request video without audio; review before output; masked preview = PNG pixels = stream pixels', async () => {
  const h = harness(ScreenCapture);
  await h.start();
  assert.deepEqual(h.requests, [{ video: true, audio: false }]);
  assert.equal(h.audioTrack.stopped, 1);
  assert.equal(h.capture.getSnapshot().state, 'paused');
  assert.equal(h.capture.resume(), false);
  assert.throws(() => h.capture.createProcessedStream());
  await h.step(5000);
  assert.equal(h.frames.length, 0);
  h.capture.setMasks([mask]);
  assert.equal(h.share(), true);
  const processed = h.capture.createProcessedStream();
  assert.notEqual(processed, h.source);
  assert.equal(h.tracks[0]!.rate, 0);
  await h.step();
  assert.equal(h.frames.length, 1);
  const pixels = new Uint8ClampedArray(await h.frames[0]!.image.arrayBuffer());
  assert.deepEqual(pixels, h.canvas.pixels);
  assert.deepEqual(h.tracks[0]!.frames.at(-1), pixels);
  for (let y = 12; y < 24; y++) for (let x = 10; x < 50; x++) {
    assert.deepEqual([...pixels.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)], [0, 0, 0, 255]);
  }
  assert.deepEqual([...pixels.slice(0, 4)], [255, 255, 255, 255]);
  assert.equal(h.frames[0]!.timestampMs, 6100);
  h.capture.dispose();
});

test('pause blocks frames and stream requests; resume invalidates the old lease', async () => {
  const h = harness(ScreenCapture);
  await h.start(); h.share(); h.capture.createProcessedStream(); await h.step();
  const lease = h.leases[0]!, generation = h.frames[0]!.generation;
  h.capture.pause();
  assert.equal(lease.signal.aborted, true); assert.equal(lease.isCurrent(), false);
  const requested = h.tracks[0]!.frames.length;
  await h.step(2000);
  assert.equal(h.frames.length, 1); assert.equal(h.tracks[0]!.frames.length, requested);
  assert.equal(h.tracks[0]!.enabled, false);
  assert.equal(h.capture.resume(), true); await h.step();
  assert.equal(h.frames.length, 2); assert.ok(h.frames[1]!.generation > generation);
  assert.equal(lease.isCurrent(), false);
  assert.equal(h.frames[1]!.timestampMs, 3200);
  h.capture.dispose();
});

test('discard encodings pending at pause; old completion cannot clear a new pending frame', async () => {
  const h = harness(ScreenCapture, { deferEncoding: true });
  await h.start(); h.share(); await h.step();
  const stale = h.encodings.shift();
  assert.ok(stale);
  h.capture.pause(); h.capture.resume(); await h.step();
  stale(); await flush();
  assert.equal(h.frames.length, 0);
  await h.step(2000); assert.equal(h.encodings.length, 1);
  h.encodings.shift()!(); await flush();
  assert.equal(h.frames.length, 1); assert.equal(h.frames[0]!.sequence, 2);
  h.capture.dispose();
});

test('snapshot and freeze provenance before asynchronous encoding', async () => {
  const current: { surface: 'email'; sourceRevision: string | null } = {
    surface: 'email', sourceRevision: 'email-r1',
  };
  const h = harness(ScreenCapture, { deferEncoding: true, snapshotProvenance: () => current });
  await h.start(); h.share();
  const generation = h.capture.getSnapshot().generation;
  await h.step();
  current.sourceRevision = 'email-r2';
  h.encodings.shift()!(); await flush();
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0]!.generation, generation);
  assert.deepEqual(h.frames[0]!.provenance, { surface: 'email', sourceRevision: 'email-r1' });
  assert.ok(Object.isFrozen(h.frames[0]!.provenance));
  h.capture.dispose();
});

test('pause drops an encoded frame instead of assigning a newer revision', async () => {
  const current: { surface: 'order'; sourceRevision: string } = {
    surface: 'order', sourceRevision: 'order-r1',
  };
  const h = harness(ScreenCapture, { deferEncoding: true, snapshotProvenance: () => current });
  await h.start(); h.share(); await h.step();
  const stale = h.encodings.shift()!;
  current.sourceRevision = 'order-r2';
  h.capture.pause(); h.capture.resume();
  stale(); await flush();
  assert.equal(h.frames.length, 0);
  await h.step();
  h.encodings.shift()!(); await flush();
  assert.equal(h.frames.length, 1);
  assert.deepEqual(h.frames[0]!.provenance, { surface: 'order', sourceRevision: 'order-r2' });
  assert.equal(h.frames[0]!.generation, h.capture.getSnapshot().generation);
  h.capture.dispose();
});

test('missing provenance is null and invalid provenance fails closed', async () => {
  const standalone = harness(ScreenCapture);
  await standalone.start(); standalone.share(); await standalone.step();
  assert.deepEqual(standalone.frames[0]!.provenance, { surface: null, sourceRevision: null });
  assert.ok(Object.isFrozen(standalone.frames[0]!.provenance));
  standalone.capture.dispose();

  const invalid = harness(ScreenCapture, {
    snapshotProvenance: () => ({ surface: 'email', sourceRevision: '' }),
  });
  await invalid.start(); invalid.share(); await invalid.step();
  assert.equal(invalid.frames.length, 0);
  assert.equal(invalid.capture.getSnapshot().state, 'error');
  assert.equal(invalid.capture.getSnapshot().reason, 'frame-failed');
});

test('no backlog while downstream is busy; late vision result never commits after resume', async () => {
  const jobs: Array<{
    job: ReturnType<typeof deferred<void>>;
    frame: ProcessedFrame;
    lease: FrameLease;
  }> = [];
  const applied: string[] = [];
  const h = harness(ScreenCapture, { onFrame: async (frame, lease) => {
    const job = deferred(); jobs.push({ job, frame, lease }); await job.promise;
    if (lease.isCurrent()) applied.push(frame.frameId);
  } });
  await h.start(); h.share(); await h.step(); await h.step(2000); await h.step(2000);
  assert.equal(jobs.length, 1);
  h.capture.pause(); assert.equal(jobs[0]!.lease.signal.aborted, true);
  h.capture.resume(); await h.step(); assert.equal(jobs.length, 2);
  jobs[0]!.job.resolve(); await flush(); assert.deepEqual(applied, []);
  await h.step(2000); assert.equal(jobs.length, 2);
  jobs[1]!.job.resolve(); await flush(); assert.deepEqual(applied, [jobs[1]!.frame.frameId]);
  h.capture.dispose();
});

test('resize immediately closes output; stale geometry cannot be confirmed', async () => {
  const h = harness(ScreenCapture, { deferEncoding: true });
  await h.start(); h.capture.setMasks([mask]); h.share(); h.capture.createProcessedStream(); await h.step();
  const old = h.capture.getSnapshot().geometry;
  assert.ok(old);
  h.video.videoWidth = 200;
  h.video.dispatchEvent(new Event('resize'));
  const snapshot = h.capture.getSnapshot();
  assert.equal(snapshot.state, 'paused'); assert.equal(snapshot.reason, 'geometry-changed');
  assert.equal(h.tracks[0]!.enabled, false); assert.ok(snapshot.reviewRequired);
  assert.equal(h.capture.confirmMasks(old.revision), false); assert.equal(h.capture.resume(), false);
  h.encodings.shift()!(); await flush(); assert.equal(h.frames.length, 0);
  assert.equal(h.share(), true); await h.step(); h.encodings.shift()!(); await flush();
  assert.equal(h.frames[0]!.geometry.width, 200);
  assert.deepEqual([...h.canvas.pixels!.slice((12 * 200 + 20) * 4, (12 * 200 + 20) * 4 + 4)], [0, 0, 0, 255]);
  h.capture.dispose();
});

test('resize between encoding and delivery is rejected even before the resize event', async () => {
  const h = harness(ScreenCapture, { deferEncoding: true });
  await h.start(); h.share(); await h.step(); h.video.videoHeight = 80;
  h.encodings.shift()!(); await flush(); assert.equal(h.frames.length, 0);
  await h.step(); assert.equal(h.capture.getSnapshot().reason, 'geometry-changed');
  h.capture.dispose();
});

test('mask editing invalidates active work and requires confirmation again', async () => {
  const h = harness(ScreenCapture);
  await h.start(); h.share(); await h.step(); h.capture.setMasks([mask]);
  assert.equal(h.leases[0]!.isCurrent(), false); assert.equal(h.capture.resume(), false);
  await h.step(2000); assert.equal(h.frames.length, 1);
  h.share(); await h.step(); assert.equal(h.frames.length, 2);
  h.capture.dispose();
});

test('permission refusal is recoverable; stop while picker is pending releases its eventual source', async () => {
  const h = harness(ScreenCapture, { getDisplayMedia: () => Promise.reject(new DOMException('Synthetic denial', 'NotAllowedError')) });
  await h.start(); assert.equal(h.capture.getSnapshot().reason, 'permission-denied');
  h.capture.dispose();
  const picker = deferred<MediaStream>();
  const pending = harness(ScreenCapture, { getDisplayMedia: () => picker.promise });
  const starting = pending.start(); assert.equal(pending.capture.getSnapshot().state, 'selecting');
  pending.capture.stop(); picker.resolve(pending.source as unknown as MediaStream); await starting;
  assert.equal(pending.sourceTrack.readyState, 'ended'); assert.equal(pending.audioTrack.readyState, 'ended');
  assert.equal(pending.capture.getSnapshot().state, 'stopped');
});

test('old picker rejection cannot overwrite a newer capture', async () => {
  const picker = deferred<MediaStream>();
  let calls = 0;
  let h!: ReturnType<typeof harness>;
  h = harness(ScreenCapture, { getDisplayMedia: () => ++calls === 1 ? picker.promise :
    Promise.resolve(h.source as unknown as MediaStream) });
  const first = h.start(); h.capture.stop(); await h.start();
  picker.reject(new DOMException('Synthetic denial', 'NotAllowedError')); await first;
  assert.equal(h.capture.getSnapshot().state, 'paused'); h.capture.dispose();
});

test('stop during video initialization and user-ended source both clean up', async () => {
  const playing = deferred();
  const h = harness(ScreenCapture, { play: () => playing.promise });
  const start = h.start(); await flush(); h.capture.stop(); playing.resolve(); await start;
  assert.equal(h.sourceTrack.readyState, 'ended'); assert.equal(h.video.srcObject, null);
  assert.equal(h.animations.size, 0);
  const live = harness(ScreenCapture); await live.start(); live.share(); await live.step();
  live.sourceTrack.readyState = 'ended'; live.sourceTrack.dispatchEvent(new Event('ended'));
  assert.equal(live.capture.getSnapshot().reason, 'source-ended'); assert.ok(live.leases[0]!.signal.aborted);
  assert.equal(live.animations.size, 0); assert.equal(live.capture.getSnapshot().geometry, null);
});

test('muted or undecodable source pauses without releasing stale pixels', async () => {
  const h = harness(ScreenCapture); await h.start(); h.share(); await h.step();
  h.sourceTrack.muted = true; h.sourceTrack.dispatchEvent(new Event('mute'));
  await h.step(2000); assert.equal(h.frames.length, 1); assert.equal(h.capture.resume(), false);
  h.sourceTrack.muted = false; h.sourceTrack.dispatchEvent(new Event('unmute'));
  assert.equal(h.capture.getSnapshot().reason, 'user-paused');
  assert.equal(h.capture.getSnapshot().state, 'paused'); assert.equal(h.capture.resume(), true);
  h.video.readyState = 1; await h.step(2000);
  assert.equal(h.frames.length, 1); assert.equal(h.capture.getSnapshot().state, 'paused');
  h.video.readyState = 2; await h.step();
  assert.equal(h.capture.getSnapshot().reason, 'user-paused');
  assert.equal(h.frames.length, 1); assert.equal(h.capture.resume(), true); h.capture.dispose();
});

test('unsupported manual stream capture fails closed instead of recording automatically', async () => {
  const h = harness(ScreenCapture, { noManualCapture: true }); await h.start(); h.share();
  assert.throws(() => h.capture.createProcessedStream(), /Manual canvas/);
  assert.equal(h.tracks[0]!.readyState, 'ended'); h.capture.dispose();
});

test('current encoding/consumer failures stop capture; an obsolete rejection does not stop resumed capture', async () => {
  const h = harness(ScreenCapture, { onFrame: () => { throw Error('Synthetic consumer failure'); } });
  await h.start(); h.share(); await h.step(); assert.equal(h.capture.getSnapshot().reason, 'consumer-failed');
  assert.equal(h.sourceTrack.readyState, 'ended');
  const job = deferred(); const next = harness(ScreenCapture, { onFrame: () => job.promise });
  await next.start(); next.share(); await next.step(); next.capture.pause(); next.capture.resume();
  job.reject(Error('Obsolete failure')); await flush(); assert.equal(next.capture.getSnapshot().state, 'capturing'); next.capture.dispose();
  const bad = harness(ScreenCapture); bad.canvas.toBlob = (callback: BlobCallback) => callback(null);
  await bad.start(); bad.share(); await bad.step(); assert.equal(bad.capture.getSnapshot().reason, 'frame-failed');
});

test('frame identity does not repeat when the same session restarts', async () => {
  const h = harness(ScreenCapture); await h.start(); h.share(); await h.step(); const id = h.frames[0]!.frameId;
  h.capture.stop(); h.sourceTrack.readyState = 'live'; await h.start(); h.share(); await h.step();
  assert.notEqual(h.frames[1]!.frameId, id); h.capture.dispose();
});

// Frame encoding for vision (smaller frames for the Codex runner): a shared screen of any app goes at most 960 px wide
// as JPEG 0.5; the demo workspace surfaces stay native-size PNG unless applyTo is 'all'. All pixels are synthetic.
test('a shared screen goes 960 px wide as JPEG 0.5, scaled from the masked processed canvas', async () => {
  assert.deepEqual({ ...DEFAULT_FRAME_ENCODING }, { maxWidth: 960, jpegQuality: 0.5, applyTo: 'generic' });
  assert.ok(Object.isFrozen(DEFAULT_FRAME_ENCODING));
  const h = harness(ScreenCapture, { videoWidth: 1920, videoHeight: 1080 });
  await h.start(); h.capture.setMasks([mask]); assert.equal(h.share(), true); await h.step();
  assert.equal(h.frames.length, 1);
  assert.deepEqual(h.blobRequests.at(-1), { canvas: 'scaled', width: 960, height: 540, type: 'image/jpeg', quality: 0.5 });
  assert.equal(h.frames[0]!.image.type, 'image/jpeg');
  assert.equal(h.frames[0]!.geometry.width, 1920, 'geometry stays the source geometry');
  assert.deepEqual(h.scaled[0]!.draws, [[0, 0, 960, 540]]);
  const pixels = new Uint8ClampedArray(await h.frames[0]!.image.arrayBuffer());
  const at = (x: number, y: number): number[] => [...pixels.slice((y * 960 + x) * 4, (y * 960 + x) * 4 + 4)];
  // The mask covers x 0.1..0.5, y 0.2..0.4 of the source: black in the encoded frame at the same relative place.
  for (const [x, y] of [[96, 108], [300, 160], [479, 215]] as const) assert.deepEqual(at(x, y), [0, 0, 0, 255], `${x},${y}`);
  for (const [x, y] of [[10, 10], [600, 160], [300, 300]] as const) assert.deepEqual(at(x, y), [255, 255, 255, 255], `${x},${y}`);
  h.capture.stop();
  assert.deepEqual([h.scaled[0]!.width, h.scaled[0]!.height], [1, 1], 'stop clears the scaled copy');
  h.capture.dispose();
});

test('workspace surface frames stay native-size PNG by default; applyTo all compacts them too', async () => {
  const email = () => ({ surface: 'email' as const, sourceRevision: 'email-r1' });
  const workspace = harness(ScreenCapture, { snapshotProvenance: email, frameEncoding: { maxWidth: 50 } });
  await workspace.start(); workspace.share(); await workspace.step();
  assert.deepEqual(workspace.blobRequests.at(-1), { canvas: 'processed', width: 100, height: 60, type: 'image/png', quality: undefined });
  assert.equal(workspace.frames[0]!.image.type, 'image/png'); assert.equal(workspace.scaled.length, 0);
  workspace.capture.dispose();
  const all = harness(ScreenCapture, { snapshotProvenance: email, frameEncoding: { maxWidth: 50, applyTo: 'all' } });
  await all.start(); all.share(); await all.step();
  assert.deepEqual(all.blobRequests.at(-1), { canvas: 'scaled', width: 50, height: 30, type: 'image/jpeg', quality: 0.5 });
  all.capture.dispose();
});

test('a narrow share keeps its size; jpegQuality null encodes PNG; invalid encoding knobs throw', async () => {
  const narrow = harness(ScreenCapture);
  await narrow.start(); narrow.share(); await narrow.step();
  assert.deepEqual(narrow.blobRequests.at(-1), { canvas: 'processed', width: 100, height: 60, type: 'image/jpeg', quality: 0.5 });
  assert.equal(narrow.scaled.length, 0);
  narrow.capture.dispose();
  const png = harness(ScreenCapture, { frameEncoding: { maxWidth: 40, jpegQuality: null } });
  await png.start(); png.share(); await png.step();
  assert.deepEqual(png.blobRequests.at(-1), { canvas: 'scaled', width: 40, height: 24, type: 'image/png', quality: undefined });
  png.capture.dispose();
  for (const frameEncoding of [{ maxWidth: 0 }, { maxWidth: Number.NaN }, { jpegQuality: 0 }, { jpegQuality: 1.5 },
    { applyTo: 'workspace' as 'all' }]) {
    assert.throws(() => harness(ScreenCapture, { frameEncoding }), RangeError, JSON.stringify(frameEncoding));
  }
});

test('a generic frame is sent only after a visible change: a caret or a clock is not one', async () => {
  const modules = await loadModules();
  const { visiblyChanged, CHANGE_THUMBNAIL } = modules as unknown as {
    visiblyChanged: typeof import('../ScreenCapture.ts').visiblyChanged;
    CHANGE_THUMBNAIL: typeof import('../ScreenCapture.ts').CHANGE_THUMBNAIL;
  };
  after(() => modules.cleanup());
  const size = CHANGE_THUMBNAIL.width * CHANGE_THUMBNAIL.height;
  const base = new Uint8Array(size).fill(120);
  assert.equal(visiblyChanged(null, base), true, 'the first frame is always sent');
  assert.equal(visiblyChanged(base, base.slice()), false, 'the same pixels are not a change');
  const caret = base.slice(); caret[10] = 250;
  assert.equal(visiblyChanged(base, caret), false, 'one moved pixel (a blinking caret) is not a change');
  const faint = base.slice(); faint[10] = 130; faint[11] = 130;
  assert.equal(visiblyChanged(base, faint), false, 'a shift of 10 gray levels or less is not a change');
  const typed = base.slice(); typed[10] = 131; typed[200] = 20;
  assert.equal(visiblyChanged(base, typed), true, 'two pixels moved by more than 10 levels is a change');
  assert.equal(visiblyChanged(base, new Uint8Array(size + 1)), true, 'another geometry is a change');
});
