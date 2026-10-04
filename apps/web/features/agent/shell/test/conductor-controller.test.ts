// The shell as a face of the conductor: boot and join, one session for the journey, events from the page, cues rendered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentApi } from '../api.ts';
import { createAgentApi } from '../api.ts';
import type { BrainDecision } from '../brain/types.ts';
import { BATCH_MS, RECONNECT_MIN_MS } from '../conductor/client.ts';
import { THOUGHT_MS } from '../conductor/face.ts';
import type { Target } from '../conductor/protocol.ts';
import { AUTO_LEAD_STORAGE_KEY, ShellController, TYPING_IDLE_MS } from '../controller.ts';
import type { ControllerDeps } from '../controller.ts';
import { SampleObservationSource } from '../screen/sample-source.ts';
import { conductorFetch, cue, sseCue, sseHello } from './conductor-fakes.ts';
import { FakePresenter, FakeTimers, FakeVoice, ScriptedBrain, TOKEN, modernApi, recordingFetch, settle } from './helpers.ts';

function conductorRig(options: { linkStatus?: number; memory?: Map<string, string> } = {}) {
  const timers = new FakeTimers();
  const clock = { base: 1_700_000_000_000, now: () => clock.base + timers.now };
  const c = conductorFetch(options.linkStatus === undefined ? {} : { linkStatus: options.linkStatus });
  const rest = recordingFetch(modernApi());
  const fetch = (url: string, init?: RequestInit): Promise<Response> => (url.includes('/api/agent/conductor/') ? c.fetch(url, init) : rest.fetch(url, init));
  const voice = new FakeVoice();
  const presenter = new FakePresenter();
  const brain = new ScriptedBrain();
  const pointed: Array<Target | null> = [];
  const guides: Array<{ phase: string; step: string; text: string } | null> = [];
  const flashes: Array<Target | null> = [];
  const api: AgentApi = createAgentApi({ base: 'https://api.example.invalid', fetch, now: clock.now, newId: () => 'legacy' });
  const memory = options.memory ?? new Map<string, string>();
  const deps: ControllerDeps = {
    api, fetch, connectVoice: voice.connector,
    createBrain: () => brain,
    createSampleSource: () => new SampleObservationSource(clock.now, timers, 'neutral'),
    presenter, now: clock.now, perfNow: () => timers.now, timers, isHidden: () => false,
    storage: { get: (k) => memory.get(k) ?? null, set: (k, v) => { memory.set(k, v); } },
    conductor: {
      base: 'https://api.example.invalid', version: 'web-test',
      present: (_text, target) => { if (target !== undefined) pointed.push(target); },
      guide: (step) => { guides.push(step); },
      attention: (target) => { flashes.push(target); },
    },
  };
  const controller = new ShellController(deps);
  /** Every conductor event posted so far, in order. */
  const events = (): Array<{ seq: number; event: Record<string, unknown> }> =>
    c.calls.filter((x) => x.url.endsWith('/events')).flatMap((x) => (x.body as { events: Array<{ seq: number; event: Record<string, unknown> }> }).events);
  const sessionPosts = (): number => rest.calls.filter((x) => x.url.endsWith('/api/agent/sessions') && x.method === 'POST').length;
  return { controller, timers, voice, presenter, brain, pointed, guides, flashes, conductor: c, rest, events, sessionPosts };
}

async function booted(options: { join?: string; page?: 'review' | 'teach'; linkStatus?: number; lastCueSeq?: number; memory?: Map<string, string> } = {}) {
  const rig = conductorRig({ ...(options.linkStatus === undefined ? {} : { linkStatus: options.linkStatus }), ...(options.memory ? { memory: options.memory } : {}) });
  await rig.controller.bootConductor({ join: options.join ?? null, page: options.page ?? null });
  await settle();
  rig.conductor.streams[0]?.push(sseHello(options.lastCueSeq ?? -1));
  await settle();
  rig.timers.advance(BATCH_MS);
  await settle();
  return rig;
}

test('boot: one session, the cue stream with the token in the header, then hello and mode', async () => {
  const rig = await booted();
  assert.equal(rig.sessionPosts(), 1);
  const get = rig.conductor.calls.find((x) => x.url.includes('/cues'));
  assert.ok(get);
  assert.equal(get.headers['authorization'], `Bearer ${TOKEN}`);
  assert.ok(!get.url.includes(TOKEN));
  const types = rig.events().map((e) => e.event.type);
  assert.deepEqual(types.slice(0, 2), ['hello', 'mode']);
  assert.equal(rig.events()[0]?.event.client, 'web');
  assert.equal(rig.events()[0]?.event.persona, 'expert');
  assert.equal(rig.controller.conductorLeads(), true);
  rig.controller.dispose();
});

test('join: the code is posted to /link before the stream opens, page=review opens Reflect, old lines are not replayed', async () => {
  const rig = conductorRig();
  await rig.controller.bootConductor({ join: 'ABCD2345', page: 'review' });
  await settle();
  const link = rig.conductor.calls.findIndex((x) => x.url.endsWith('/link'));
  const get = rig.conductor.calls.findIndex((x) => x.url.includes('/cues'));
  assert.ok(link >= 0 && get > link, 'link first, then the stream');
  assert.deepEqual(rig.conductor.calls[link]?.body, { code: 'ABCD2345' });
  assert.equal(rig.controller.store.getState().mode, 'review');
  assert.equal(rig.controller.conductorStore.getState().linked, true);
  // The macOS session already said things: they are history, only the map comes back.
  rig.conductor.streams[0]?.push(sseHello(2));
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'say', text: 'Old line' })));
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'map', version: 3, map: { steps: [], guardrails: [], gaps: [], teachBack: 'tb', comments: [] }, confirmed: false })));
  rig.conductor.streams[0]?.push(sseCue(cue(3, { type: 'guide', step: 'talk_to_edit', phase: 'review', text: 'Just tell me what to change.', target: null, speak: false }, { for: 'web' })));
  await settle();
  const s = rig.controller.conductorStore.getState();
  assert.equal(s.map?.version, 3);
  assert.equal(s.line?.text, 'Just tell me what to change.');
  assert.ok(!rig.presenter.bubbles.includes('Old line'));
  rig.controller.dispose();
});

test('an expired join code: a warning, and the page runs its own conductor session', async () => {
  const rig = conductorRig({ linkStatus: 404 });
  await rig.controller.bootConductor({ join: 'ABCD2345', page: null });
  await settle();
  assert.equal(rig.controller.conductorStore.getState().linked, false);
  assert.equal(rig.controller.store.getState().banner?.kind, 'warn');
  rig.controller.dispose();
});

test('Learn runs in the journey session; an ask cue is spoken as [ASK], outlined, and reported spoken when the agent is done', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  assert.equal(rig.sessionPosts(), 1, 'the journey session is reused');
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.ok(rig.events().some((e) => e.event.type === 'session' && e.event.live === true && e.event.mode === 'learn'));
  rig.conductor.streams[0]?.push(sseCue(cue(1, {
    type: 'ask', questionId: 'q1', text: 'Why did you change the total?', topic: 'reason',
    regions: [{ regionId: 'r1', label: 'Total', box: [0.5, 0.5, 0.2, 0.1], evidenceId: 'e1' }], evidenceIds: ['e1'],
  })));
  await settle();
  assert.ok(rig.voice.userMessages.includes('[ASK] Why did you change the total?'));
  const s = rig.controller.conductorStore.getState();
  assert.equal(s.regions[0]?.regionId, 'r1');
  assert.equal(rig.pointed[rig.pointed.length - 1]?.kind, 'region');
  assert.equal(rig.presenter.bubble, 'Why did you change the total?');
  rig.voice.mode('speaking');
  rig.voice.mode('listening');
  await settle();
  rig.timers.advance(BATCH_MS);
  await settle();
  const done = rig.events().find((e) => e.event.type === 'cue_done');
  assert.ok(done);
  assert.equal(done.event.outcome, 'spoken');
  assert.ok(rig.events().some((e) => e.event.type === 'talking' && e.event.by === 'agent' && e.event.active === true));
  rig.controller.dispose();
});

test('the person\'s words go up as transcript turns; context cues go to the voice agent unspoken', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.voice.say('user', 'Because the supplier always double-bills in December.');
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'context', text: '[map] The person selected step s2.' })));
  await settle();
  rig.timers.advance(BATCH_MS);
  await settle();
  const t = rig.events().find((e) => e.event.type === 'transcript');
  assert.ok(t);
  assert.equal(t.event.role, 'expert');
  assert.ok(rig.voice.contexts.includes('[map] The person selected step s2.'));
  rig.controller.dispose();
});

test('typing sends activity typing at once and idle after the quiet time; a spoken cue meanwhile is skipped', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.controller.noteTyping();
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'activity').at(-1)?.event.state, 'typing');
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'say', text: 'Not now' })));
  await settle();
  assert.ok(!rig.voice.userMessages.includes('[ASK] Not now'));
  rig.timers.advance(TYPING_IDLE_MS);
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'activity').at(-1)?.event.state, 'idle');
  const skipped = rig.events().find((e) => e.event.type === 'cue_done');
  assert.equal(skipped?.event.outcome, 'skipped');
  rig.controller.dispose();
});

test('the in-browser brain never speaks while the conductor leads', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  const ask: BrainDecision = { decision: 'ASK_NOW', topic: 'reason', kind: 'reason', whyNow: 'test', evidenceIds: [], utterance: { text: 'A brain question?' } };
  rig.brain.queue = [ask];
  rig.timers.advance(1000);
  await settle();
  assert.ok(!rig.voice.userMessages.some((m) => m.includes('A brain question?')));
  rig.controller.dispose();
});

test('off the record: the event goes first, then nothing is rendered until back on record', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.controller.noteTyping();
  await settle();
  await rig.controller.goOffRecord();
  await settle();
  rig.timers.advance(TYPING_IDLE_MS);
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'activity').length, 1, 'nothing but off_record is sent off the record');
  const off = rig.events().find((e) => e.event.type === 'off_record');
  assert.ok(off);
  assert.equal(off.event.on, true);
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'say', text: 'Should not show' })));
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'state', clipa: 'hidden' })));
  await settle();
  assert.ok(!rig.presenter.bubbles.includes('Should not show'));
  assert.equal(rig.controller.conductorStore.getState().pose, 'hidden');
  assert.ok(!rig.events().some((e) => e.event.type === 'cue_done'), 'nothing is reported off the record');
  rig.controller.backOnRecord();
  await settle();
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'off_record').at(-1)?.event.on, false);
  // The pause that began off the record is reported, so the conductor does not wait for one.
  assert.equal(rig.events().filter((e) => e.event.type === 'activity').at(-1)?.event.state, 'idle');
  rig.controller.dispose();
});

test('a map cue and a teach-back reach the conductor store; the Review buttons send ui events', async () => {
  const rig = await booted();
  const map = { steps: [{ id: 's1', kind: 'action', goal: 'Open the invoice', action: 'Opened it', decision: null, evidenceIds: [] }], guardrails: [], gaps: [{ question: 'Is that for every supplier?', targetId: null, evidenceIds: [], regionIds: [] }], teachBack: 'You open the invoice.', comments: [] };
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'map', version: 2, map, confirmed: false })));
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'teachback', version: 2, text: 'You open the invoice.' })));
  await settle();
  const s = rig.controller.conductorStore.getState();
  assert.equal(s.map?.version, 2);
  assert.equal(s.teachBack?.text, 'You open the invoice.');
  rig.controller.uiAction('answer_gap', 'gap-1');
  rig.controller.uiAction('correct', null, 'Only for supplier A.');
  rig.controller.uiAction('confirm');
  rig.timers.advance(BATCH_MS);
  await settle();
  const ui = rig.events().filter((e) => e.event.type === 'ui').map((e) => [e.event.action, e.event.targetId, e.event.text]);
  assert.deepEqual(ui, [['answer_gap', 'gap-1', null], ['correct', null, 'Only for supplier A.'], ['confirm', null, null]]);
  rig.controller.dispose();
});

test('a guide cue shows its line and points at its UI target; a cancel clears it', async () => {
  const rig = await booted();
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'guide', step: 'welcome', phase: 'share', text: 'Share your whole screen.', target: { kind: 'ui', name: 'share' }, speak: false })));
  await settle();
  assert.equal(rig.presenter.bubble, 'Share your whole screen.');
  assert.deepEqual(rig.pointed.at(-1), { kind: 'ui', name: 'share' });
  assert.deepEqual(rig.guides.at(-1), { phase: 'share', step: 'welcome', text: 'Share your whole screen.' });
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'cancel', cueId: 'c1-abcdef12' })));
  await settle();
  assert.equal(rig.controller.conductorStore.getState().line, null);
  assert.equal(rig.presenter.bubble, '');
  assert.equal(rig.pointed.at(-1), null);
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.ok(rig.events().some((e) => e.event.type === 'cue_done' && e.event.cueId === 'c1-abcdef12' && e.event.outcome === 'shown'));
  rig.controller.dispose();
});

test('a restarted server: the page says hello again, re-sends its live session and follows the new conductor', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(7, { type: 'say', text: 'before' })));
  await settle();
  rig.conductor.streams[0]?.end();
  await settle();
  rig.timers.advance(RECONNECT_MIN_MS);
  await settle();
  rig.conductor.streams[1]?.push(sseHello(0));
  await settle();
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'hello').length, 2);
  assert.ok(rig.events().filter((e) => e.event.type === 'session' && e.event.live === true).length >= 2);
  rig.conductor.streams[1]?.push(sseCue(cue(1, { type: 'say', text: 'after restart' })));
  await settle();
  assert.ok(rig.voice.userMessages.includes('[ASK] after restart'));
  assert.deepEqual(rig.controller.conductorStore.getState().said.map((s) => [s.text, s.outcome]), [['before', 'interrupted'], ['after restart', 'pending']]);
  rig.controller.dispose();
});

test('Teach: the hello is sent again as the new hire when the stage changes', async () => {
  const rig = await booted();
  rig.controller.setMode('teach');
  rig.timers.advance(BATCH_MS);
  await settle();
  const hellos = rig.events().filter((e) => e.event.type === 'hello');
  assert.equal(hellos.length, 2);
  assert.equal(hellos[1]?.event.persona, 'new_hire');
  rig.controller.dispose();
});

test('a thought cue shows in the thought bubble for a few seconds and is never spoken or reported', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'thought', text: 'Looking at Mail: compose window' }, { for: 'web' })));
  await settle();
  assert.deepEqual(rig.controller.conductorStore.getState().thought, { cueId: 'c1-abcdef12', text: 'Looking at Mail: compose window' });
  assert.ok(!rig.voice.userMessages.some((m) => m.includes('Looking at')), 'never spoken');
  assert.ok(!rig.presenter.bubbles.includes('Looking at Mail: compose window'), 'not in the speech bubble');
  rig.timers.advance(THOUGHT_MS - 100);
  assert.notEqual(rig.controller.conductorStore.getState().thought, null);
  rig.timers.advance(200);
  assert.equal(rig.controller.conductorStore.getState().thought, null, 'gone after a few seconds');
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.ok(!rig.events().some((e) => e.event.type === 'cue_done' && e.event.cueId === 'c1-abcdef12'));
  rig.controller.dispose();
});

test('an attention cue flashes Clipa and sends her to a new target; at her current target she only flashes', async () => {
  const rig = await booted();
  const region = { kind: 'region', regionId: 'r-to', label: 'recipient field', box: [0.1, 0.1, 0.3, 0.05], evidenceId: 'ev-1' };
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'point', target: region })));
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'attention', target: region }, { for: 'web' })));
  await settle();
  assert.equal(rig.flashes.length, 1);
  assert.equal(rig.pointed.length, 1, 'already there: no second flight');
  rig.conductor.streams[0]?.push(sseCue(cue(3, { type: 'attention', target: { kind: 'ui', name: 'mode_tab', mode: 'review' } }, { for: 'web' })));
  await settle();
  assert.equal(rig.flashes.length, 2);
  assert.deepEqual(rig.pointed.at(-1), { kind: 'ui', name: 'mode_tab', mode: 'review' }, 'a new target: she goes there');
  rig.conductor.streams[0]?.push(sseCue(cue(4, { type: 'attention', target: null }, { for: 'web' })));
  await settle();
  assert.deepEqual(rig.flashes.at(-1), null, 'no target: she flashes where she is');
  rig.controller.dispose();
});

test('a stage cue opens the stage exactly like a click on the rail; nothing is applied off the record', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'stage', mode: 'review' }, { for: 'web' })));
  await settle();
  assert.equal(rig.controller.store.getState().mode, 'review', 'the Reflect tab is open');
  assert.equal(rig.controller.store.getState().session?.mode, 'learn', 'like a rail click, the running session keeps going');
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.equal(rig.events().filter((e) => e.event.type === 'mode').at(-1)?.event.mode, 'review', 'the conductor hears the mode, as after a click');
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'stage', mode: 'bogus' })));
  await settle();
  assert.equal(rig.controller.store.getState().mode, 'review', 'an unknown stage is ignored');
  await rig.controller.goOffRecord();
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(3, { type: 'stage', mode: 'teach' })));
  rig.conductor.streams[0]?.push(sseCue(cue(4, { type: 'thought', text: 'Hmm…' })));
  await settle();
  assert.equal(rig.controller.store.getState().mode, 'review');
  assert.equal(rig.controller.conductorStore.getState().thought, null);
  rig.controller.dispose();
});

test('a stage cue with start starts that stage like Start: the running one ends first, the same stage again is only opened', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'stage', mode: 'learn', start: true }, { for: 'web' })));
  await settle();
  assert.equal(rig.controller.store.getState().session?.mode, 'learn', 'Show already runs: nothing restarts');
  rig.conductor.streams[0]?.push(sseCue(cue(2, { type: 'stage', mode: 'review', start: true }, { for: 'web' })));
  await settle();
  await settle();
  const s = rig.controller.store.getState();
  assert.equal(s.mode, 'review');
  assert.equal(s.phase, 'live');
  assert.equal(s.session?.mode, 'review', 'Reflect runs now');
  rig.timers.advance(BATCH_MS);
  await settle();
  const sessions = rig.events().filter((e) => e.event.type === 'session').map((e) => `${String(e.event.mode)} ${String(e.event.live)}`);
  assert.deepEqual(sessions.slice(-3), ['learn true', 'learn false', 'review true'], 'Show ended, then Reflect started, in the journey session');
  rig.controller.dispose();
});

test('an end cue ends the running session like End; off the record it is ignored', async () => {
  const rig = await booted();
  await rig.controller.start('learn');
  await settle();
  rig.conductor.streams[0]?.push(sseCue(cue(1, { type: 'end', reason: 'off' }, { for: 'web' })));
  await settle();
  await settle();
  assert.notEqual(rig.controller.store.getState().phase, 'live', 'the session ended');
  assert.equal(rig.voice.ended, true, 'the voice is closed');
  rig.controller.dispose();
});

test('Lead me through: on by default, the switch is remembered per viewer and told to the conductor (off also after the hello)', async () => {
  const memory = new Map<string, string>();
  const rig = await booted({ memory });
  assert.equal(rig.controller.isAutoLead(), true);
  assert.equal(rig.events().filter((e) => e.event.type === 'auto').length, 0, 'on is the default: nothing to tell');
  rig.controller.setAutoLead(false);
  rig.timers.advance(BATCH_MS);
  await settle();
  assert.deepEqual(rig.events().filter((e) => e.event.type === 'auto').map((e) => e.event.on), [false]);
  assert.equal(memory.get(AUTO_LEAD_STORAGE_KEY), 'off');
  rig.controller.dispose();
  const again = await booted({ memory });
  assert.equal(again.controller.isAutoLead(), false, 'remembered');
  const sent = again.events().map((e) => e.event.type);
  assert.ok(sent.indexOf('auto') > sent.indexOf('hello'), 'told right after the hello');
  again.controller.setAutoLead(true);
  again.timers.advance(BATCH_MS);
  await settle();
  assert.equal(again.events().filter((e) => e.event.type === 'auto').at(-1)?.event.on, true);
  assert.equal(memory.get(AUTO_LEAD_STORAGE_KEY), 'on');
  again.controller.dispose();
  // Blocked storage: the page still works, with auto on.
  const blocked = conductorRig();
  assert.equal(blocked.controller.isAutoLead(), true);
  blocked.controller.dispose();
});
