import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainDecision } from '../brain/types.ts';
import { ASK_AUDIO_TIMEOUT_MS, PERSONA_STORAGE_KEY, parseMode, parsePersona } from '../controller.ts';
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import type { RecordedRequest } from './helpers.ts';
import { ScriptedBrain, TOKEN, createRig, json, legacyApi, modernApi, must, settle } from './helpers.ts';

const ask = (over: Partial<BrainDecision> = {}): BrainDecision => ({
  decision: 'ASK_NOW', topic: 'why_text_body', kind: 'reason', whyNow: 'quiet for 3.2 s', evidenceIds: ['evidence-1'],
  utterance: { text: 'Why did you type the address instead of attaching the screenshot?' }, expectsAnswer: true, ...over,
});

const uploaded = (calls: RecordedRequest[]): string[] =>
  calls.filter((c) => c.url.endsWith('/events')).flatMap((c) => (c.body as { events: Array<{ text: string }> }).events.map((e) => e.text));

test('start: one click makes the session, the epoch, the token and the voice', async () => {
  const rig = createRig();
  const click = rig.clock.now();
  await rig.controller.start('learn');
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'live');
  assert.equal(must(s.session).id, 'sess-1');
  assert.equal(must(s.session).epochMs, click, 'the epoch is the click, not the end of the request');
  assert.equal(must(s.session).legacyRoutes, false);
  assert.equal(s.voice.phase, 'listening');
  assert.equal(must(s.session).conversationId, 'conv_test_1');
  assert.equal(rig.voice.url.startsWith('wss://'), true);
  const signed = must(rig.calls.find((c) => c.url.includes('/signed-url')));
  assert.equal(signed.headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(rig.presenter.state, 'listening');
  assert.deepEqual(rig.controller.captureSession(), { sessionId: 'sess-1', sessionEpochMs: click });
});

test('the epoch is taken at the click even when the session request is slow', async () => {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const slow = async (req: RecordedRequest) => {
    if (req.url.endsWith('/api/agent/sessions')) { await gate; return json(201, { sessionId: 'slow-1', token: TOKEN, issuedAtMs: 1, serverNowMs: 1 }); }
    return null;
  };
  const rig = createRig({ responders: [slow, modernApi()] });
  const click = rig.clock.now();
  const starting = rig.controller.start('learn');
  assert.equal(rig.controller.store.getState().phase, 'starting');
  rig.timers.advance(700);
  open();
  await starting;
  assert.equal(must(rig.controller.store.getState().session).epochMs, click);
  assert.throws(() => createRig().controller.captureSession(), /Start a mode/);
});

test('temporary fallback: a 404 on /api/agent/sessions runs the whole session on the legacy routes', async () => {
  const rig = createRig({ responders: [legacyApi()] });
  await rig.controller.start('learn');
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'live');
  assert.equal(must(s.session).legacyRoutes, true);
  assert.equal(s.voice.phase, 'listening');
  rig.timers.advance(2000);
  await settle();
  const events = must(rig.calls.find((c) => c.url.endsWith('/events')));
  assert.equal(events.url, 'https://api.example.invalid/agent/sessions/legacy-session-id/events');
  assert.equal(events.headers['authorization'], undefined);
  assert.ok(rig.calls.every((c) => c.headers['authorization'] === undefined || !c.url.includes('/agent/sessions/legacy')));
});

test('a failed session request ends in an error state, with Clipa warning', async () => {
  const rig = createRig({ responders: [(req) => (req.url.endsWith('/api/agent/sessions') ? json(429, {}) : null)] });
  await rig.controller.start('learn');
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'error');
  assert.equal(s.banner?.kind, 'error');
  assert.match(s.banner?.text ?? '', /too many requests/);
  assert.equal(rig.presenter.state, 'warning');
});

test('voice failure is not fatal: the session stays live, silent, with a banner', async () => {
  const rig = createRig({ responders: [modernApi({ signedUrlStatus: 503 })] });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'live');
  assert.equal(s.voice.phase, 'offline');
  assert.equal(s.banner?.kind, 'warn');
  rig.timers.advance(3500);
  assert.ok(rig.controller.store.getState().observations.length >= 2, 'sample observations still flow');
  assert.equal(rig.voice.contexts.length, 0);
});

test('a failing microphone or connection is reported without the signed URL', async () => {
  const rig = createRig();
  rig.voice.failWith = 'Microphone permission denied';
  await rig.controller.start('learn');
  const s = rig.controller.store.getState();
  assert.equal(s.voice.phase, 'offline');
  assert.match(s.voice.error ?? '', /Microphone permission denied/);
  assert.ok(s.events.every((e) => !e.text.includes('wss://')));
});

test('sample observations: buffered while the voice connects, then sent as contextual updates', async () => {
  const rig = createRig();
  rig.voice.autoConnect = false;
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  assert.equal(rig.controller.store.getState().voice.phase, 'connecting');
  rig.timers.advance(3000);
  assert.equal(rig.voice.contexts.length, 0, 'nothing is sent before the voice is connected');
  must(rig.voice.events).onConnect('conv_test_1');
  assert.ok(rig.voice.contexts.length >= 2);
  assert.match(must(rig.voice.contexts[0]), /^\[screen\] \(synthetic sample\) Order SYN-101/);
  rig.timers.advance(3000);
  assert.ok(rig.voice.contexts.some((c) => c.startsWith('[screen] (synthetic sample) Email draft')));
  assert.ok(rig.voice.contexts.every((c) => !c.includes('Synthetic delivery')), 'no typed text is sent');
  const s = rig.controller.store.getState();
  assert.equal(s.screen.source?.synthetic, true);
  assert.deepEqual(s.observations.map((o) => o.id).slice(0, 3), ['order-1', 'input-1', 'email-1']);
});

test('context buffered while the voice connects survives the SDK firing connected before startSession returns', async () => {
  // Real SDK order: onStatusChange(connected) and onConnect fire inside startSession, before the handle exists.
  const rig = createRig();
  let release: () => void = () => {};
  rig.voice.gate = new Promise<void>((resolve) => { release = resolve; });
  await rig.controller.setSampleObservations(true);
  const starting = rig.controller.start('learn');
  await settle();
  rig.timers.advance(3500); // order at 1 s and email at 3 s are buffered; the heartbeat is never sent
  assert.equal(rig.voice.contexts.length, 0);
  release();
  await starting;
  assert.equal(rig.controller.store.getState().voice.phase, 'listening');
  assert.equal(rig.voice.contexts.length, 2, 'the first buffered observation is not dropped');
  assert.match(must(rig.voice.contexts[0]), /^\[screen\] \(synthetic sample\) Order SYN-101/);
  assert.match(must(rig.voice.contexts[1]), /^\[screen\] \(synthetic sample\) Email draft/);
  assert.ok(!rig.controller.store.getState().events.some((e) => /Screen context is not sent/.test(e.text)), 'no false "not sent" note');
  // Later observations go straight through.
  rig.timers.advance(2000);
  assert.ok(rig.voice.contexts.some((c) => c.startsWith('[screen] (synthetic sample) Ticket')));
});

test('a context that really cannot be sent is noted again after the voice was usable', async () => {
  const rig = createRig({ responders: [modernApi({ signedUrlStatus: 503 })] });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  rig.timers.advance(3500);
  const notes = rig.controller.store.getState().events.filter((e) => /Screen context is not sent/.test(e.text));
  assert.equal(notes.length, 1, 'one note while the voice is offline');
});

test('off the record while the voice is still connecting aborts the connection and closes it as soon as it opens', async () => {
  const rig = createRig();
  let release: () => void = () => {};
  rig.voice.gate = new Promise<void>((resolve) => { release = resolve; });
  const starting = rig.controller.start('learn');
  await settle();
  assert.equal(rig.controller.store.getState().voice.phase, 'connecting');
  await rig.controller.goOffRecord();
  assert.equal(must(rig.voice.signal).aborted, true);
  release();
  await starting;
  await settle();
  assert.equal(rig.voice.ended, true, 'the microphone is closed the moment the handshake ends');
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'ended');
  assert.equal(s.voice.phase, 'ended');
  assert.equal(s.banner, null, 'no "voice not available" banner for a cancelled connection');
});

test('the sample toggle: off by default, can be flipped while live, never for Review', async () => {
  const rig = createRig();
  assert.equal(rig.controller.store.getState().screen.sampleOn, false);
  await rig.controller.start('learn');
  assert.equal(rig.sources.length, 0, 'no source without the toggle');
  await rig.controller.setSampleObservations(true);
  assert.equal(rig.sources.length, 1);
  assert.equal(rig.controller.store.getState().screen.source?.label, 'Sample observations (synthetic)');
  await rig.controller.setSampleObservations(false);
  assert.equal(rig.controller.store.getState().screen.source, null);
  await rig.controller.end();

  const review = createRig();
  await review.controller.setSampleObservations(true);
  await review.controller.start('review');
  assert.equal(review.sources.length, 0, 'Review does not need the screen');
});

test('an ASK_NOW decision is spoken as [ASK] text, shown in the feed and the bubble, and measured', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  rig.timers.advance(1500); // the order observation arrives at t = 1 s
  brain.queue = [ask()];
  rig.timers.advance(500);
  const text = 'Why did you type the address instead of attaching the screenshot?';
  assert.deepEqual(rig.voice.userMessages, [`[ASK] ${text}`]);
  let s = rig.controller.store.getState();
  assert.equal(s.feed.length, 1);
  assert.equal(must(s.feed[0]).status, 'asked');
  assert.equal(s.voice.thinking, true);
  assert.equal(rig.presenter.bubble, text);
  assert.equal(rig.presenter.state, 'thinking');
  assert.equal(must(s.decisions[0]).spoken, true);
  assert.match(must(s.decisions[0]).whyNow, /quiet/);

  rig.timers.advance(640);
  rig.voice.mode('speaking');
  s = rig.controller.store.getState();
  assert.equal(rig.presenter.state, 'speaking');
  // The question went out at t = 2 s; the latest observation before it arrived at t = 1 s; the agent spoke at t = 2.64 s.
  assert.equal(must(s.decisions[0]).latencyMs, 1640, 'observation-to-audio latency is recorded');
  rig.voice.mode('listening');
  assert.equal(rig.presenter.state, 'listening');
});

test('a question that never produces audio stops looking like thinking, and is logged', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.start('learn');
  brain.queue = [ask()];
  rig.timers.advance(500);
  assert.equal(rig.controller.store.getState().voice.thinking, true);
  rig.timers.advance(ASK_AUDIO_TIMEOUT_MS);
  const s = rig.controller.store.getState();
  assert.equal(s.voice.thinking, false);
  assert.equal(rig.presenter.state, 'listening');
  assert.ok(s.events.some((e) => e.dir === 'err' && /did not start speaking/.test(e.text)));
  assert.equal(must(s.decisions[0]).latencyMs, null, 'no latency is invented');
});

test('the person speaking after a question answers it; the brain is told', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.start('learn');
  brain.queue = [ask()];
  rig.timers.advance(500);
  rig.voice.mode('speaking');
  rig.voice.say('ai', 'Why did you type the address instead of attaching the screenshot?');
  rig.voice.mode('listening');
  rig.voice.say('user', 'customer_07 asked for it as text.');
  const s = rig.controller.store.getState();
  assert.equal(must(s.feed[0]).status, 'answered');
  assert.deepEqual(must(s.feed[0]).answer?.text, 'customer_07 asked for it as text.');
  assert.deepEqual(brain.answers, [{ kind: 'answer', text: 'customer_07 asked for it as text.', topic: 'why_text_body' }]);
  assert.equal(rig.presenter.bubble, '', 'the bubble is cleared');
  assert.ok(brain.calls.includes('transcript:agent') && brain.calls.includes('transcript:user'));
  // A second user message with no open question is only a transcript line.
  rig.voice.say('user', 'And one more thing.');
  assert.equal(rig.controller.store.getState().feed.length, 1);
});

test('DEFER goes to the feed and Review, SKIP only to the decision log', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.start('learn');
  brain.queue = [
    ask({ decision: 'DEFER', topic: 'who_releases', whyNow: 'budget used' }),
    { decision: 'SKIP', topic: 'visible', kind: 'none', whyNow: 'already on screen', evidenceIds: [] },
  ];
  rig.timers.advance(500);
  const s = rig.controller.store.getState();
  assert.equal(rig.voice.userMessages.length, 0, 'nothing is spoken');
  assert.deepEqual(s.feed.map((f) => [f.topic, f.status]), [['who_releases', 'deferred']]);
  assert.deepEqual(s.decisions.map((d) => [d.decision, d.whyNow]), [['DEFER', 'budget used'], ['SKIP', 'already on screen']]);
  assert.ok(s.events.some((e) => e.type === 'DECISION' && e.text.includes('already on screen')));
});

test('a spoken decision is never sent when the voice is offline, off the record or the agent is speaking', async () => {
  const offline = createRig({ brain: new ScriptedBrain(), responders: [modernApi({ signedUrlStatus: 503 })] });
  await offline.controller.start('learn');
  (offline.brain as ScriptedBrain).queue = [ask()];
  offline.timers.advance(500);
  assert.equal(must(offline.controller.store.getState().feed[0]).status, 'unspoken');
  assert.match(must(offline.controller.store.getState().feed[0]).note ?? '', /voice is not connected/);

  const brain = new ScriptedBrain();
  const busy = createRig({ brain });
  await busy.controller.start('learn');
  busy.voice.mode('speaking');
  brain.queue = [ask()];
  busy.timers.advance(500);
  assert.equal(busy.voice.userMessages.length, 0);
  assert.equal(must(busy.controller.store.getState().feed[0]).status, 'deferred');
});

test('a WARN decision makes Clipa look like a warning while it speaks, and points at the resolved target', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  rig.controller.setTargetResolver((t) => (t.surface === 'email' ? { x: 10, y: 20, width: 300, height: 40 } : null));
  await rig.controller.start('teach');
  brain.queue = [ask({ decision: 'WARN', clipa: { state: 'warning', target: { surface: 'email', hint: 'send' } } })];
  rig.timers.advance(500);
  rig.voice.mode('speaking');
  assert.equal(rig.presenter.state, 'warning');
  assert.deepEqual(rig.presenter.targets.at(-1), { x: 10, y: 20, width: 300, height: 40 });
});

test('the brain tick receives the signals of the shell', async () => {
  const seen: unknown[] = [];
  const brain = new ScriptedBrain();
  brain.tick = (_now?: number, signals?: unknown) => { seen.push(signals); return []; };
  const rig = createRig({ brain });
  rig.controller.setPersona('quiet');
  await rig.controller.start('learn');
  rig.timers.advance(500);
  assert.deepEqual(seen[0], {
    sessionId: 'sess-1', mode: 'learn', persona: 'quiet', offRecord: false, voiceConnected: true, agentSpeaking: false, humanSpeaking: false, asked: 0,
  });
});

test('off the record: voice first, then the screen, then capture; the log stops with the switch', async () => {
  const rig = createRig();
  rig.controller.registerCapture(rig.capture);
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  rig.timers.advance(2000);
  await settle();
  const before = rig.controller.store.getState();
  assert.equal(before.phase, 'live');

  await rig.controller.goOffRecord();
  assert.deepEqual(rig.trace, ['voice.end', 'source.stop', 'capture.stop']);
  const s = rig.controller.store.getState();
  assert.equal(s.offRecord, true);
  assert.equal(s.phase, 'ended');
  assert.equal(s.voice.phase, 'ended');
  assert.equal(s.screen.source, null);
  assert.equal(rig.presenter.state, 'off');
  assert.equal(rig.presenter.bubble, '');
  const lines = uploaded(rig.calls);
  assert.ok(lines.includes('Off the record: capture and upload stopped.'));
  assert.ok(!lines.some((l) => l.startsWith('Off the record: session ended')), 'nothing after the switch is uploaded');
  // The visible log still explains what happened.
  assert.ok(s.events.some((e) => e.text.includes('What was already sent is not deleted or recalled')));
  // Both channels stay closed: a start is refused until the person goes back on record.
  const callsBefore = rig.calls.length;
  await rig.controller.start('learn');
  assert.equal(rig.calls.length, callsBefore);
  rig.controller.backOnRecord();
  assert.equal(rig.controller.store.getState().offRecord, false);
  assert.equal(rig.presenter.state, 'idle');
  await rig.controller.start('learn');
  assert.equal(rig.controller.store.getState().phase, 'live');
});

test('off the record while a session is still being made cancels the start', async () => {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const slow = async (req: RecordedRequest) => {
    if (req.url.endsWith('/api/agent/sessions')) { await gate; return json(201, { sessionId: 'late-1', token: TOKEN, issuedAtMs: 1, serverNowMs: 1 }); }
    return null;
  };
  const rig = createRig({ responders: [slow, modernApi()] });
  const starting = rig.controller.start('learn');
  await rig.controller.goOffRecord();
  open();
  await starting;
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'ended');
  assert.equal(s.session, null);
  assert.equal(rig.calls.some((c) => c.url.includes('/signed-url')), false, 'no voice was requested');
});

test('end: the session log is finished with the conversation id', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  await rig.controller.end('Session ended.');
  const finish = must(rig.calls.find((c) => c.url.endsWith('/finish')));
  assert.deepEqual(finish.body, { conversationId: 'conv_test_1' });
  assert.equal(finish.headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(rig.controller.store.getState().phase, 'ended');
  assert.ok(rig.controller.store.getState().events.some((e) => /transcript stored: yes/.test(e.text)));
});

test('the 10 minute cap ends the session by itself', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  const deadline = must(rig.controller.store.getState().session).deadlineMs;
  assert.equal(deadline, must(rig.controller.store.getState().session).epochMs + SESSION_LIMIT_MS);
  rig.timers.advance(SESSION_LIMIT_MS - 1000);
  assert.equal(rig.controller.store.getState().phase, 'live');
  rig.timers.advance(1000);
  await settle();
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'ended');
  assert.equal(rig.voice.ended, true);
  assert.ok(s.events.some((e) => e.text.includes('the 10 minutes limit was reached')));
});

test('a tab hidden for 2 minutes ends the session', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  rig.controller.onVisibilityChange(true);
  rig.timers.advance(2 * 60 * 1000);
  await settle();
  assert.equal(rig.controller.store.getState().phase, 'ended');
});

test('a voice that drops on its own ends the session and says so', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  must(rig.voice.events).onDisconnect('agent hung up');
  await settle();
  const s = rig.controller.store.getState();
  assert.equal(s.phase, 'ended');
  assert.match(s.banner?.text ?? '', /Voice disconnected \(agent hung up\)/);
});

test('switching modes keeps the live session, its feed and its voice', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.start('learn');
  brain.queue = [ask()];
  rig.timers.advance(500);
  const before = rig.controller.store.getState();
  rig.controller.setMode('review');
  rig.controller.setMode('teach');
  rig.controller.setMode('learn');
  const after = rig.controller.store.getState();
  assert.equal(after.session, before.session);
  assert.equal(after.feed, before.feed);
  assert.equal(after.voice, before.voice);
  assert.equal(after.phase, 'live');
  assert.equal(rig.voice.ended, false);
});

test('Review: the brain gives the gaps, the teach-back and the map; confirm and correct reach the brain', async () => {
  const brain = new ScriptedBrain();
  brain.reviewOutput = {
    gaps: [{ id: 'g1', topic: 'who_releases', question: 'Who releases the December invoice?', evidenceIds: [] }],
    teachBack: 'You put the delivery data into the body as text when the customer asked for it.',
    map: { steps: [{ id: 'st1', title: 'Open the order', kind: 'step', decision: null, reason: null, guardrails: [], evidenceIds: ['evidence-1'], atMs: 1000 }] },
  };
  const rig = createRig({ brain });
  rig.controller.setMode('review');
  let s = rig.controller.store.getState();
  assert.equal(s.review.gaps.length, 1);
  assert.equal(s.review.teachBack.status, 'pending');
  assert.equal(s.draftMap.steps.length, 1);
  rig.controller.confirmTeachBack();
  s = rig.controller.store.getState();
  assert.equal(s.review.teachBack.status, 'confirmed');
  rig.controller.setMode('learn');
  rig.controller.setMode('review');
  assert.equal(rig.controller.store.getState().review.teachBack.status, 'confirmed', 'a reload does not undo the confirmation');
  rig.controller.correctTeachBack('  Only for customer_07.  ');
  s = rig.controller.store.getState();
  assert.equal(s.review.teachBack.status, 'corrected');
  assert.equal(s.review.teachBack.correction, 'Only for customer_07.');
  assert.deepEqual(brain.answers.map((a) => a.kind), ['confirm', 'correct']);
});

test('the NullBrain Review is empty and its confirm and correct do nothing', async () => {
  const rig = createRig();
  rig.controller.setMode('review');
  rig.controller.confirmTeachBack();
  rig.controller.correctTeachBack('x');
  const s = rig.controller.store.getState();
  assert.equal(s.review.teachBack.status, 'none');
  assert.equal(s.brain.wired, false);
});

test('Teach: a sample checkpoint is judged by the brain and the reply goes back to the workspace', async () => {
  const brain = new ScriptedBrain();
  brain.checkpointStatus = 'warn';
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('teach');
  rig.timers.advance(6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  const s = rig.controller.store.getState();
  assert.equal(must(s.teach.checkpoint).status, 'warn');
  assert.equal(must(s.teach.checkpoint).message, 'scripted warn');
  assert.equal(must(s.teach.checkpoint).deliveryError, null);
  assert.equal(rig.presenter.state, 'warning');
});

test('Teach with the NullBrain answers unknown, never clear', async () => {
  const rig = createRig();
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('teach');
  rig.timers.advance(6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  const card = must(rig.controller.store.getState().teach.checkpoint);
  assert.equal(card.status, 'unknown');
  assert.match(card.message, /no tutor is wired/);
});

test('evidence of a sample observation resolves, and replaying it makes Clipa point', async () => {
  const rig = createRig();
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  rig.timers.advance(2000);
  const evidence = await rig.controller.resolveEvidence('evidence-1');
  assert.match(evidence.assetRef, /^mock:/);
  rig.controller.openEvidence('evidence-1');
  assert.equal(rig.presenter.state, 'pointing');
  rig.controller.closeEvidence();
  assert.notEqual(rig.presenter.state, 'pointing');
  await rig.controller.end();
  assert.ok((await rig.controller.resolveEvidence('evidence-1')).startMs >= 0, 'evidence stays resolvable after the session');
});

test('capture: the panel session exists only while live; end and off the record stop the capture', async () => {
  const rig = createRig();
  rig.controller.registerCapture(rig.capture);
  rig.capture.emit('capturing');
  assert.equal(rig.controller.store.getState().screen.capture.state, 'capturing');
  assert.throws(() => rig.controller.captureSession(), /Start a mode/);
  await rig.controller.start('learn');
  assert.equal(rig.controller.captureSession().sessionId, 'sess-1');
  await rig.controller.end();
  assert.equal(rig.capture.stops, 1);
  assert.equal(rig.controller.store.getState().screen.capture.state, 'stopped');
  assert.throws(() => rig.controller.captureSession(), /Start a mode/);
});

test('persona: stored and read back; unknown values fall back to plain', () => {
  const rig = createRig();
  rig.controller.setPersona('thorough');
  assert.equal(rig.controller.store.getState().persona, 'thorough');
  assert.equal(parsePersona('strict'), 'strict');
  assert.equal(parsePersona('nonsense'), 'plain');
  assert.equal(parsePersona(null), 'plain');
  assert.equal(PERSONA_STORAGE_KEY, 'apprentice.shell.persona');
  assert.equal(parseMode('teach'), 'teach');
  assert.equal(parseMode('x'), 'learn');
});

test('page hide closes the voice at once and sends what is queued', async () => {
  const rig = createRig();
  await rig.controller.start('learn');
  rig.controller.onPageHide();
  await settle();
  assert.equal(rig.voice.ended, true);
  assert.ok(rig.calls.some((c) => c.url.endsWith('/finish')));
});

test('no token or signed URL ever reaches the visible log or the uploaded lines', async () => {
  const brain = new ScriptedBrain();
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  brain.queue = [ask()];
  rig.timers.advance(4000);
  must(rig.voice.events).onError(`socket failed: ${rig.voice.url}`);
  await rig.controller.end();
  const visible = rig.controller.store.getState().events.map((e) => e.text).join('\n');
  assert.ok(!visible.includes(TOKEN));
  assert.ok(!visible.includes('wss://'));
  assert.ok(!uploaded(rig.calls).join('\n').includes('wss://'));
  assert.ok(!JSON.stringify(rig.controller.store.getState()).includes(TOKEN), 'the token is not in the shell state');
});
