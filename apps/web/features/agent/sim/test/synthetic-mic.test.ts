import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicStoppedError, createSyntheticMic } from '../synthetic-mic.ts';
import type { MicEvent } from '../synthetic-mic.ts';
import { FakeAudioContext, createFakeStream, flush } from './helpers.ts';

function setup(options: { monitor?: boolean; failFirstLoad?: string } = {}) {
  const context = new FakeAudioContext();
  const loads: string[] = [];
  const events: MicEvent[] = [];
  let failed = false;
  const mic = createSyntheticMic({
    context,
    monitor: options.monitor ?? false,
    createStream: createFakeStream,
    loadClip: (clipId) => {
      loads.push(clipId);
      if (options.failFirstLoad === clipId && !failed) {
        failed = true;
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(new ArrayBuffer(4000));
    },
    onEvent: (e) => events.push(e),
  });
  return { context, mic, loads, events };
}

test('say() decodes the clip, resumes the context, plays into the stream destination and resolves when the clip ends', async () => {
  const { context, mic, events } = setup();
  let done = false;
  const played = mic.say('expert.reason').then(() => {
    done = true;
  });
  await flush();
  assert.equal(context.resumeCalls, 1, 'a suspended context is resumed');
  assert.equal(context.sources.length, 1);
  const source = context.sources[0];
  assert.ok(source?.started, 'the clip started');
  assert.equal(source.buffer?.duration, 4);
  // source -> gain -> the stream destination; nothing goes to the speakers unless monitor is on.
  const gain = context.gains[0];
  assert.deepEqual(source.connectedTo, [gain]);
  assert.deepEqual(gain?.connectedTo, [context.streamDestination]);
  assert.equal(mic.isSpeaking(), true);
  assert.equal(done, false, 'still playing');
  source.end();
  await played;
  assert.equal(mic.isSpeaking(), false);
  assert.deepEqual(
    events.map((e) => e.type),
    ['queued', 'start', 'end'],
  );
});

test('clips never overlap: a second say() waits for the first to end and plays in order', async () => {
  const { context, mic } = setup();
  const first = mic.say('expert.reason');
  const second = mic.say('expert.essentials');
  await flush();
  assert.equal(context.sources.length, 1, 'only the first clip is playing');
  context.sources[0]?.end();
  await first;
  await flush();
  assert.equal(context.sources.length, 2);
  assert.equal(mic.isSpeaking(), true);
  context.sources[1]?.end();
  await second;
  assert.equal(context.startOrder.length, 2);
});

test('a clip is loaded and decoded once; the second say() reuses the decoded buffer', async () => {
  const { context, mic, loads } = setup();
  const a = mic.say('expert.scope');
  await flush();
  context.sources[0]?.end();
  await a;
  const b = mic.say('expert.scope');
  await flush();
  context.sources[1]?.end();
  await b;
  assert.deepEqual(loads, ['expert.scope']);
  assert.equal(context.decodeCalls, 1);
  assert.equal(context.sources.length, 2);
});

test('preload() decodes ahead so the first answer does not wait', async () => {
  const { context, mic, loads } = setup();
  await mic.preload(['expert.reason', 'expert.scope']);
  assert.deepEqual(loads, ['expert.reason', 'expert.scope']);
  assert.equal(context.decodeCalls, 2);
  const played = mic.say('expert.reason');
  await flush();
  assert.equal(context.decodeCalls, 2, 'no new decode');
  context.sources[0]?.end();
  await played;
});

test('a clip that fails to load rejects its say() and is retried by the next one; the queue keeps going', async () => {
  const { context, mic, loads } = setup({ failFirstLoad: 'expert.reason' });
  await assert.rejects(mic.say('expert.reason'), /network down/);
  const again = mic.say('expert.reason');
  await flush();
  context.sources[0]?.end();
  await again;
  assert.deepEqual(loads, ['expert.reason', 'expert.reason']);
});

test('monitor plays the clips through the speakers as well', async () => {
  const { context, mic } = setup({ monitor: true });
  const played = mic.say('expert.scope');
  await flush();
  assert.deepEqual(context.gains[0]?.connectedTo, [context.streamDestination, context.destination]);
  context.sources[0]?.end();
  await played;
});

test('stop() cancels the clip that is playing and the queue, ends the tracks and closes the context', async () => {
  const { context, mic, events } = setup();
  const first = mic.say('expert.reason');
  const second = mic.say('expert.essentials');
  const firstOutcome = assert.rejects(first, MicStoppedError);
  const secondOutcome = assert.rejects(second, MicStoppedError);
  await flush();
  mic.stop();
  await firstOutcome;
  await secondOutcome;
  assert.equal(context.sources[0]?.stopped, true);
  assert.equal(context.sources.length, 1, 'the queued clip never started');
  assert.equal(context.closed, true);
  assert.ok(context.streamDestination.stream.getTracks().every((t) => (t as unknown as { stopped: boolean }).stopped));
  assert.ok(events.some((e) => e.type === 'cancelled'));
  assert.ok(!events.some((e) => e.type === 'end'));
  await assert.rejects(mic.say('expert.scope'), MicStoppedError);
  mic.stop();
});

test('cloneStream() gives every consumer its own tracks: stopping a clone does not end the mic', () => {
  const { context, mic } = setup();
  const clone = mic.cloneStream();
  const [track] = clone.getAudioTracks() as unknown as Array<{ stopped: boolean; origin: unknown }>;
  assert.ok(track);
  assert.notEqual(track, context.streamDestination.stream.getAudioTracks()[0]);
  track.stopped = true;
  assert.equal((context.streamDestination.stream.getAudioTracks()[0] as unknown as { stopped: boolean }).stopped, false);
});

test('sayText exists only when the mic was given a renderText route', async () => {
  const { mic } = setup();
  assert.equal(mic.sayText, undefined);
  const context = new FakeAudioContext();
  const rendered: string[] = [];
  const withText = createSyntheticMic({
    context,
    loadClip: () => Promise.resolve(new ArrayBuffer(10)),
    renderText: (text) => {
      rendered.push(text);
      return Promise.resolve(new ArrayBuffer(2000));
    },
  });
  assert.ok(withText.sayText);
  const played = withText.sayText('Hello there');
  await flush();
  context.sources[0]?.end();
  await played;
  assert.deepEqual(rendered, ['Hello there']);
});
