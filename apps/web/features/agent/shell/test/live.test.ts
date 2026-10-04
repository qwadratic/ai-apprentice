// Stream A's integrated runtime behind the shell's seam (spec of the coordinator, TASK-3.31): the shell mounts it after the session
// exists, never calls bridge.start (the person's click in A's panel does), answers every checkpoint through the bridge and
// coordinates the off-the-record switch with the mount. The mount here is a fake whose bridge is the contracts' MockScreenBridge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockScreenBridge } from '@apprentice/contracts/mock';
import type { ScreenBridge } from '@apprentice/contracts';
import { TEACH_CASE_ID, liveWorkspaceBind } from '../screen/live-bind.ts';
import { LiveMount } from '../screen/live-mount.ts';
import { LIVE_LABEL } from '../screen/runtime-workspace-source.ts';
import type { RuntimeWorkspaceMount, RuntimeWorkspaceOptions } from '../screen/runtime-workspace-source.ts';
import { buildScenario } from '../screen/sample-scenarios.ts';
import { FakeCapture, TOKEN, createRig, must, settle } from './helpers.ts';
import type { Rig } from './helpers.ts';

interface Fake {
  mounts: Array<{ options: RuntimeWorkspaceOptions; mount: RuntimeWorkspaceMount; bridge: MockScreenBridge; disposed: number; offRecord: boolean[] }>;
  factory(options: RuntimeWorkspaceOptions): RuntimeWorkspaceMount;
}

function fakeRuntime(rig: Rig): Fake {
  const mounts: Fake['mounts'] = [];
  const factory = (options: RuntimeWorkspaceOptions): RuntimeWorkspaceMount => {
    const bridge = new MockScreenBridge(rig.clock.now(), (sessionId) => buildScenario('t1', sessionId));
    const entry = { options, bridge, disposed: 0, offRecord: [] as boolean[], mount: null as unknown as RuntimeWorkspaceMount };
    entry.mount = {
      runtime: null, bridge: bridge as ScreenBridge, capture: new FakeCapture(), workspace: null,
      setOffRecord: async (on) => { entry.offRecord.push(on); },
      dispose: () => { entry.disposed += 1; },
    };
    mounts.push(entry);
    return entry.mount;
  };
  return { mounts, factory };
}

function setup(): { rig: Rig; fake: Fake; live: LiveMount } {
  const rig = createRig();
  const fake = fakeRuntime(rig);
  const live = new LiveMount({ factory: fake.factory, controller: rig.controller, apiBase: 'https://api.example.invalid', providesWorkspace: true });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });
  return { rig, fake, live };
}

test('the runtime mounts after the session exists, with the session, the epoch and the token, and is not started by the shell', async () => {
  const { rig, fake, live } = setup();
  assert.equal(fake.mounts.length, 0, 'nothing is mounted before a mode starts');
  const click = rig.clock.now();
  await rig.controller.start('learn');
  await settle();
  const m = must(fake.mounts[0]);
  assert.equal(fake.mounts.length, 1);
  assert.deepEqual(m.options.session instanceof Function ? m.options.session() : m.options.session, { sessionId: 'sess-1', sessionEpochMs: click });
  assert.equal(m.options.authHeader(), `Bearer ${TOKEN}`);
  assert.equal(m.options.apiBase, 'https://api.example.invalid');
  assert.equal(live.mountedFor(), 'sess-1');
  const s = rig.controller.store.getState();
  assert.deepEqual(s.screen.source, { label: LIVE_LABEL, synthetic: false });
  assert.equal(rig.sources.length, 0, 'no sample source runs next to the real one');
  // The bridge was only attached: nothing was captured or emitted until A's panel starts it.
  assert.equal(s.observations.length, 0);
  assert.ok(!JSON.stringify(s).includes(TOKEN), 'the token is not in the shell state');
  await rig.controller.end();
});

test('observations and checkpoints of the real bridge reach the brain, and every checkpoint is answered through the bridge', async () => {
  const { rig, fake } = setup();
  await rig.controller.start('teach');
  await settle();
  const m = must(fake.mounts[0]);
  // What A's panel does on the person's click:
  await m.bridge.start({ sessionId: 'sess-1', sessionEpochMs: must(rig.controller.store.getState().session).epochMs });
  m.bridge.advanceTo(rig.clock.now() + 4500);
  const s = rig.controller.store.getState();
  assert.ok(s.observations.length >= 3);
  assert.ok(s.observations.every((o) => o.synthetic === false), 'real-source rows are never labelled synthetic');
  m.bridge.raiseCheckpoint();
  await settle();
  assert.equal(m.bridge.replies.length, 1, 'the reply went back through bridge.replyToCheckpoint');
  assert.equal(must(m.bridge.replies[0]).status, 'unknown', 'no mock success: the NullBrain cannot judge');
  assert.equal(must(rig.controller.store.getState().teach.checkpoint).status, 'unknown');
});

test('a new session disposes the mount and mounts again; ending the session disposes it', async () => {
  const { rig, fake } = setup();
  await rig.controller.start('learn');
  await settle();
  await rig.controller.end();
  await settle();
  assert.equal(must(fake.mounts[0]).disposed >= 1, true, 'disposed with the session');
  await rig.controller.start('teach');
  await settle();
  assert.equal(fake.mounts.length, 2);
  assert.equal(must(fake.mounts[1]).disposed, 0);
  assert.equal(must(fake.mounts[1]).options.session instanceof Function, true);
});

test('Review has no screen, so it gets no mount', async () => {
  const { rig, fake } = setup();
  await rig.controller.start('review');
  await settle();
  assert.equal(fake.mounts.length, 0);
});

test('off the record is coordinated with the mount first, and the next session starts clean', async () => {
  const { rig, fake } = setup();
  await rig.controller.start('learn');
  await settle();
  await rig.controller.goOffRecord();
  assert.deepEqual(must(fake.mounts[0]).offRecord, [true]);
  assert.equal(rig.controller.store.getState().offRecord, true);
  rig.controller.backOnRecord();
  await rig.controller.start('learn');
  await settle();
  assert.equal(fake.mounts.length, 2);
});

test('the sample switch never replaces the real screen', async () => {
  const { rig } = setup();
  await rig.controller.start('learn');
  await settle();
  await rig.controller.setSampleObservations(true);
  assert.equal(rig.sources.length, 0);
  assert.equal(rig.controller.store.getState().screen.source?.synthetic, false);
});

test('a runtime that cannot be mounted is noted and does not break the session', async () => {
  const rig = createRig();
  const live = new LiveMount({ factory: () => { throw new Error('picker unavailable'); }, controller: rig.controller, apiBase: '', providesWorkspace: true });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });
  await rig.controller.start('learn');
  await settle();
  assert.equal(rig.controller.store.getState().phase, 'live');
  assert.ok(rig.controller.store.getState().events.some((e) => /could not be mounted: picker unavailable/.test(e.text)));
});

test('the sample is a labelled fallback: it runs until a screen is shared, then the real screen takes over', async () => {
  const rig = createRig({ scenarios: true });
  const fake = fakeRuntime(rig);
  const live = new LiveMount({ factory: fake.factory, controller: rig.controller, apiBase: '', providesWorkspace: true });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  await settle();
  const m = must(fake.mounts[0]);
  let s = rig.controller.store.getState();
  assert.equal(s.screen.source?.synthetic, true, 'no screen is shared yet: the sample runs, labelled synthetic');
  assert.equal(rig.sources.length, 1);
  rig.timers.advance(3000);
  assert.ok(rig.controller.store.getState().observations.every((o) => o.synthetic), 'every row of the sample is marked synthetic');

  // The person chooses a window in A's panel: the bridge starts and reports capturing.
  await m.bridge.start({ sessionId: 'sess-1', sessionEpochMs: must(s.session).epochMs });
  await settle();
  s = rig.controller.store.getState();
  assert.deepEqual(s.screen.source, { label: LIVE_LABEL, synthetic: false });
  assert.equal(s.screen.state, 'capturing');
  const before = s.observations.length;
  rig.timers.advance(20_000);
  assert.equal(rig.controller.store.getState().observations.length, before, 'the sample no longer emits');
  assert.ok(rig.controller.store.getState().events.some((e) => /A screen is shared: the sample observations stopped/.test(e.text)));
  m.bridge.advanceTo(rig.clock.now() + 5000);
  const rows = rig.controller.store.getState().observations;
  assert.ok(rows.length > before);
  assert.ok(rows.slice(before).every((o) => o.synthetic === false), 'rows of the real screen are not marked synthetic');
  await rig.controller.end();
  assert.ok(m.disposed >= 1);
});

test('a real screen that is never shared leaves the standby disposed with the session', async () => {
  const rig = createRig({ scenarios: true });
  const fake = fakeRuntime(rig);
  const live = new LiveMount({ factory: fake.factory, controller: rig.controller, apiBase: '', providesWorkspace: true });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  await settle();
  await rig.controller.end();
  assert.ok(must(fake.mounts[0]).disposed >= 1);
});

test('the mount\'s capture is registered with the controller: its state shows, and ending the session stops it', async () => {
  const { rig, fake } = setup();
  await rig.controller.start('learn');
  await settle();
  const capture = must(fake.mounts[0]).mount.capture as FakeCapture;
  capture.emit('capturing');
  assert.equal(rig.controller.store.getState().screen.capture.state, 'capturing');
  await rig.controller.end();
  assert.equal(capture.stops >= 1, true);
});

test('Pass it on opens the workspace on the new order (image only); Show keeps the practice order', async () => {
  const rig = createRig();
  const resets: Array<{ mode: string | null; caseId: string | undefined }> = [];
  const ports: unknown[] = [];
  const factory = (): RuntimeWorkspaceMount => {
    const bridge = new MockScreenBridge(rig.clock.now(), (sessionId) => buildScenario('t1', sessionId));
    // The part of A's WorkspaceController the shell's bind uses.
    const workspace = {
      reset: (caseId?: string) => { resets.push({ mode: rig.controller.store.getState().session?.mode ?? null, caseId }); },
      setCheckpoint: (port?: unknown) => { ports.push(port); },
    };
    return { runtime: null, bridge: bridge as ScreenBridge, capture: new FakeCapture(), workspace, setOffRecord: async () => {}, dispose: () => {} };
  };
  const live = new LiveMount({
    factory, controller: rig.controller, apiBase: '', providesWorkspace: true,
    bind: liveWorkspaceBind({ host: rig.controller, now: () => rig.clock.now() }),
  });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });

  await rig.controller.start('learn');
  await settle();
  assert.equal(live.mountedFor(), 'sess-1');
  assert.deepEqual(resets, [], 'Show keeps the workspace\'s first case, the practice order');
  assert.equal(ports.length, 1, 'the checkpoint port is connected in Show too');
  await rig.controller.end();
  await settle();

  await rig.controller.start('teach');
  await settle();
  assert.equal(TEACH_CASE_ID, 'new-image');
  assert.deepEqual(resets, [{ mode: 'teach', caseId: 'new-image' }], 'Teach opens on the new order with the image only');
  assert.equal(ports.length, 2, 'the checkpoint port is connected after the reset');
  live.dispose();
});

test('a reset that fails is noted and the checkpoint port is still connected', async () => {
  const rig = createRig();
  const ports: unknown[] = [];
  const factory = (): RuntimeWorkspaceMount => ({
    runtime: null, bridge: new MockScreenBridge(rig.clock.now(), (sessionId) => buildScenario('t1', sessionId)) as ScreenBridge, capture: new FakeCapture(),
    workspace: { reset: () => { throw new Error('Unknown demo case.'); }, setCheckpoint: (port?: unknown) => { ports.push(port); } },
    setOffRecord: async () => {}, dispose: () => {},
  });
  const live = new LiveMount({ factory, controller: rig.controller, apiBase: '', providesWorkspace: true, bind: liveWorkspaceBind({ host: rig.controller, now: () => rig.clock.now() }) });
  live.setRoots({ workspace: {} as HTMLElement, screen: {} as HTMLElement });
  await rig.controller.start('teach');
  await settle();
  assert.equal(ports.length, 1);
  assert.ok(rig.controller.store.getState().events.some((e) => /The new order could not be opened: Unknown demo case\./.test(e.text)));
  live.dispose();
});

test('a screen-only mount (no workspace of its own) needs only the screen root', async () => {
  const rig = createRig();
  const fake = fakeRuntime(rig);
  const live = new LiveMount({ factory: fake.factory, controller: rig.controller, apiBase: '', providesWorkspace: false });
  assert.equal(live.providesWorkspace, false);
  live.setRoots({ screen: {} as HTMLElement });
  await rig.controller.start('learn');
  await settle();
  assert.equal(fake.mounts.length, 1);
});
