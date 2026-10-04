// TASK-3.31 fixes found by the VM run: tab clicks, the silent Learn panel, the workspace's Preview, frame-level vision errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspace } from '../../../demo-workspace/workspace.ts';
import { AgentBrain, WAITING_NOTE_MS } from '../brain/agent-brain.ts';
import type { BrainSignals } from '../brain/types.ts';
import { bindWorkspaceCheckpoint } from '../screen/checkpoint-binding.ts';
import type { BindableWorkspace } from '../screen/checkpoint-binding.ts';
import { SAMPLE_CUSTOMERS, buildScenario } from '../screen/sample-scenarios.ts';
import { FakeCapture, createRig, must, settle } from './helpers.ts';

const signals = (over: Partial<BrainSignals> = {}): BrainSignals => ({
  sessionId: 's1', mode: 'learn', persona: 'plain', offRecord: false, voiceConnected: true, agentSpeaking: false, humanSpeaking: false, asked: 0, ...over,
});

const fakeBridge = () => {
  const status = new Set<(s: { schemaVersion: 1; sessionId: string; state: string; reason?: string }) => void>();
  const obs = new Set<(o: unknown) => void>();
  return {
    onStatus: (l: never) => { status.add(l); return () => status.delete(l); },
    onObservation: (l: never) => { obs.add(l); return () => obs.delete(l); },
    emitStatus: (state: string, reason?: string) => { for (const l of status) l({ schemaVersion: 1, sessionId: 'x', state, ...(reason ? { reason } : {}) }); },
  };
};

test('Learn never stays silently at zero: with observations and no change to ask about, a SKIP line says why', () => {
  const brain = new AgentBrain({ log: () => {}, customers: SAMPLE_CUSTOMERS });
  brain.begin({ sessionId: 's1', mode: 'learn', persona: 'plain', llm: null });
  // Only the order opens: nothing the policy asks about.
  const first = must(buildScenario('learn', 's1').observations.find((o) => o.kind === 'order_view'));
  brain.onObservation(first);
  assert.deepEqual(brain.tick(1000, signals()), []);
  const out = brain.tick(WAITING_NOTE_MS + 1000, signals());
  const note = must(out.find((d) => d.topic === 'waiting'));
  assert.equal(note.decision, 'SKIP');
  assert.match(note.whyNow, /no change worth a question yet/);
  assert.deepEqual(brain.tick(WAITING_NOTE_MS + 2000, signals()).filter((d) => d.topic === 'waiting'), [], 'not repeated at once');
  const offline = brain.tick(3 * WAITING_NOTE_MS, signals({ voiceConnected: false }));
  assert.match(must(offline.find((d) => d.topic === 'waiting')).whyNow, /voice is not connected/);
});

test('page key presses reach the policy as typing: no question while the person types, even without workspace heartbeats', () => {
  const brain = new AgentBrain({ log: () => {}, customers: SAMPLE_CUSTOMERS });
  brain.begin({ sessionId: 's1', mode: 'learn', persona: 'plain', llm: null });
  for (const o of buildScenario('learn', 's1').observations) if (o.kind !== 'input_activity' && o.timestampMs <= 23_000) brain.onObservation(o);
  assert.equal(brain.tick(23_000, signals({ lastInputAtMs: 22_900 })).some((d) => d.decision === 'ASK_NOW'), false, 'typing 100 ms ago');
  assert.ok(brain.tick(30_000, signals({ lastInputAtMs: 22_900 })).some((d) => d.decision === 'ASK_NOW'), 'asked at the pause');
});

test('a frame the vision could not read does not show as a stop while the capture runs', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  const capture = new FakeCapture();
  rig.controller.registerCapture(capture);
  capture.emit('capturing');
  (rig.controller as unknown as { onScreenStatus(s: unknown): void }).onScreenStatus({ schemaVersion: 1, sessionId: 'sess-1', state: 'error', reason: 'vision_incomplete' });
  const s = rig.controller.store.getState();
  assert.equal(s.screen.state, 'capturing');
  assert.equal(s.banner, null, 'no "Screen observation stopped" banner');
  await rig.controller.end();
});

test('Preview outside Teach answers "Start Teach first" (not "No agent is connected"); the port survives A switching its own', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  const workspace = createWorkspace({ sessionId: 'sess-1' });
  const bridge = fakeBridge();
  const unbind = bindWorkspaceCheckpoint({ workspace: workspace as unknown as BindableWorkspace, bridge: bridge as never, host: rig.controller, now: rig.clock.now });
  await workspace.preview();
  let check = workspace.getState().check;
  assert.equal(check.status, 'unknown');
  assert.match((check as { message: string }).message, /Start Teach first/);
  // A's runtime clears its port on a non-capturing status: the shell's port goes back on.
  bridge.emitStatus('capturing');
  workspace.setCheckpoint(undefined);
  bridge.emitStatus('error', 'vision_incomplete');
  await workspace.preview();
  check = workspace.getState().check;
  assert.notEqual(check.status, 'error', 'never "No agent is connected"');
  unbind();
  workspace.dispose();
  await rig.controller.end();
  await settle();
});
