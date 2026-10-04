import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VISION_LAG_MS, createPersonaDriver } from '../driver.ts';
import type { DriverLog, PersonaDriver } from '../driver.ts';
import { EXPERT, NEW_HIRE } from '../personas.ts';
import type { Persona } from '../personas.ts';
import { MicStoppedError } from '../synthetic-mic.ts';
import { EXPERT_LEARN, NEW_HIRE_T1, NEW_HIRE_T2, NEW_HIRE_T3, NEW_HIRE_T4 } from '../tasks.ts';
import type { CheckStatus } from '../workspace-actions.ts';
import { FakeWorkspace, VirtualClock } from './helpers.ts';

const PLAY_MS = 2500;

function setup(persona: Persona = EXPERT, options: { checks?: CheckStatus[]; thinkScale?: number; micFails?: boolean; visionLagMs?: number } = {}) {
  const clock = new VirtualClock();
  const workspace = new FakeWorkspace(clock);
  if (options.checks) workspace.checks = options.checks;
  const played: Array<{ clipId: string; startMs: number; endMs: number }> = [];
  const logs: DriverLog[] = [];
  const mic = {
    async say(clipId: string): Promise<void> {
      if (options.micFails) throw new MicStoppedError();
      const entry = { clipId, startMs: clock.now(), endMs: -1 };
      played.push(entry);
      await clock.sleep(PLAY_MS);
      entry.endMs = clock.now();
    },
  };
  const driver = createPersonaDriver({
    persona,
    workspace,
    mic,
    clock,
    onLog: (e) => logs.push(e),
    // Most tests run without the vision lag so their timings stay simple; the lag has its own tests.
    visionLagMs: options.visionLagMs ?? 0,
    ...(options.thinkScale === undefined ? {} : { thinkScale: options.thinkScale }),
  });
  return { clock, workspace, played, logs, driver };
}

/** The agent speaks a question over `speakMs` and then asks it (the shell calls onAgentAsk when the question is spoken). */
async function agentAsks(driver: PersonaDriver, clock: VirtualClock, topic: string, text: string, speakMs = 3000): Promise<void> {
  driver.setAgentSpeaking(true);
  await clock.sleep(speakMs);
  driver.setAgentSpeaking(false);
  await driver.onAgentAsk(topic, text);
}

test('a question is answered with the clip of its topic, after a human think time', async () => {
  const { clock, driver, played } = setup();
  await clock.run(driver.onAgentAsk('reason', 'What made you take the image off?'));
  assert.equal(played.length, 1);
  assert.equal(played[0]?.clipId, 'expert.reason');
  const thinkMs = EXPERT.lines.find((l) => l.id === 'reason')?.thinkMs ?? 0;
  assert.ok((played[0]?.startMs ?? 0) >= thinkMs * 0.75, 'thinks before it speaks');
  assert.ok((played[0]?.startMs ?? 0) <= thinkMs * 1.25);
  assert.equal(driver.answered.length, 1);
  assert.equal(driver.answered[0]?.known, true);
});

test('every topic the brain asks about has its own clip', async () => {
  const { clock, driver, played } = setup();
  const topics = ['reason', 'essentials', 'guardrail', 'scope', 'exception', 'why_stop', 'duration'];
  for (const topic of topics) await clock.run(driver.onAgentAsk(topic, `about ${topic}`));
  assert.deepEqual(
    played.map((p) => p.clipId),
    topics.map((t) => `expert.${t}`),
  );
});

test('a topic the persona has no answer for gets the honest "not sure" clip, never an invented answer', async () => {
  const { clock, driver, played, logs } = setup();
  await clock.run(driver.onAgentAsk('favourite_colour', 'What is your favourite colour?'));
  assert.equal(played[0]?.clipId, 'expert.unsure');
  assert.equal(driver.answered[0]?.known, false);
  assert.ok(logs.some((l) => l.kind === 'note' && /not sure/.test(l.text)));
});

test('the teach-back is answered with a correction first and a confirmation after', async () => {
  const { clock, driver, played } = setup();
  await clock.run(driver.onAgentAsk('teachback', 'Let me play it back. Did I get that right?'));
  await clock.run(driver.onAgentAsk('teachback', 'I corrected it. Did I get that right now?'));
  await clock.run(driver.onAgentAsk('teachback', 'Once more?'));
  assert.deepEqual(
    played.map((p) => p.clipId),
    ['expert.teachback_correct', 'expert.teachback_confirm', 'expert.teachback_confirm'],
  );
});

test('the new hire predicts by case: the case it opened picks the answer, an explicit case key overrides it', async () => {
  const { clock, driver, played } = setup(NEW_HIRE);
  await clock.run(driver.onAgentAsk('predict', 'What will you do?'));
  assert.equal(played.at(-1)?.clipId, 'newHire.predict_usual', 'no case yet: the generic prediction');
  driver.setCase('new-image');
  await clock.run(driver.onAgentAsk('predict', 'What will you do?'));
  assert.equal(played.at(-1)?.clipId, 'newHire.predict_t1');
  await clock.run(driver.onAgentAsk('predict', 'What will you do?', { caseKey: 'unknown' }));
  assert.equal(played.at(-1)?.clipId, 'newHire.predict_t4');
});

test('the persona never talks over the agent: the answer waits until the agent has stopped', async () => {
  const { clock, driver, played } = setup(EXPERT, { thinkScale: 0 });
  driver.setAgentSpeaking(true);
  const answered = driver.onAgentAsk('reason', 'Why?');
  await clock.advance(5000);
  assert.equal(played.length, 0, 'the agent is still talking');
  driver.setAgentSpeaking(false);
  await clock.run(answered);
  assert.equal(played.length, 1);
  assert.ok((played[0]?.startMs ?? 0) >= 5000);
});

test('two questions in a row are answered one at a time, in order, without overlap', async () => {
  const { clock, driver, played } = setup();
  const first = driver.onAgentAsk('reason', 'Why?');
  const second = driver.onAgentAsk('scope', 'Only him?');
  await clock.run(Promise.all([first, second]));
  assert.deepEqual(
    played.map((p) => p.clipId),
    ['expert.reason', 'expert.scope'],
  );
  assert.ok((played[1]?.startMs ?? 0) >= (played[0]?.endMs ?? Infinity), 'the second starts after the first ended');
});

test('a stopped mic cancels the answer quietly instead of failing the driver', async () => {
  const { clock, driver, logs } = setup(EXPERT, { micFails: true });
  await clock.run(driver.onAgentAsk('reason', 'Why?'));
  assert.ok(logs.some((l) => l.kind === 'answer_cancelled'));
  assert.equal(driver.answered.length, 0);
});

test('stop() ends the driver: later questions are not answered', async () => {
  const { clock, driver, played } = setup();
  driver.stop();
  await clock.run(driver.onAgentAsk('reason', 'Why?'));
  assert.equal(played.length, 0);
});

// ---- tasks -----------------------------------------------------------------------------------------------------------

test('answers are cued by the agent: a Learn task with a silent agent plays no clip at all', async () => {
  const { clock, driver, played, workspace } = setup();
  const report = await clock.run(driver.run(EXPERT_LEARN));
  assert.equal(played.length, 0);
  assert.equal(report.completed, true);
  assert.ok(workspace.calls.includes('remove_image'));
});

test('Learn: the persona goes quiet at each pause, answers what the agent asks and only then continues', async () => {
  const { clock, driver, played, workspace, logs } = setup();
  // A scripted stand-in for the agent: it notices the quiet after the image was removed and asks why, later asks about the details.
  const agent = (async () => {
    while (!workspace.calls.includes('remove_image')) await clock.sleep(200);
    await clock.sleep(4500); // the agent's quiet detection needs a few seconds
    await agentAsks(driver, clock, 'reason', 'You took the image off. Why?');
    while (!workspace.calls.includes('type:body')) await clock.sleep(200);
    while (workspace.email.body === 'Hello,\n\nPlease see the attached delivery summary.') await clock.sleep(200);
    await clock.sleep(5000);
    await agentAsks(driver, clock, 'essentials', 'Which details matter most?');
  })();
  const report = await clock.run(Promise.all([driver.run(EXPERT_LEARN), agent]).then(([r]) => r));
  assert.deepEqual(
    played.map((p) => p.clipId),
    ['expert.reason', 'expert.essentials'],
  );
  assert.equal(report.completed, true);
  assert.equal(report.sent, true);
  // The persona did not act while its answer was being played.
  for (const p of played) {
    const acted = logs.filter((l) => l.kind === 'step' && l.atMs > p.startMs && l.atMs < p.endMs);
    assert.deepEqual(acted, [], `no workspace step during the answer ${p.clipId}`);
  }
  // The text it typed was read from the screen, not scripted.
  const body = workspace.typed.find((t) => t.target === 'body');
  assert.ok(body?.text.includes('14 Sample Lane, 1010 Exampletown'));
  assert.ok(body?.text.includes('2026-10-12 14:00-16:00'));
  assert.ok(!body?.text.includes('{'), 'every placeholder was filled in');
});

test('Learn: a warning or an unknown check is acknowledged before Send, a clear one is not', async () => {
  const warned = setup(EXPERT, { checks: ['unknown'] });
  await warned.clock.run(warned.driver.run(EXPERT_LEARN));
  assert.ok(warned.workspace.calls.includes('ack'));
  const clear = setup(EXPERT, { checks: ['clear'] });
  await clear.clock.run(clear.driver.run(EXPERT_LEARN));
  assert.ok(!clear.workspace.calls.includes('ack'));
});

test('Teach T1: predicts when asked, tries the image only, gets the warning, reacts, fixes the email and sends it', async () => {
  const { clock, driver, played, workspace } = setup(NEW_HIRE, { checks: ['warn', 'clear'] });
  workspace.order = { orderId: 'ORD-2057', customer: 'customer_07', address: '82 Sample Walk, 1010 Exampletown', window: '2026-10-13 09:00-11:00' };
  const tutor = (async () => {
    while (!workspace.calls.includes('open:new-image')) await clock.sleep(200);
    await clock.sleep(3500);
    await agentAsks(driver, clock, 'predict', 'What will you do with the email for ORD-2057?');
    while (!workspace.calls.includes('preview')) await clock.sleep(200);
    await clock.sleep(2500);
    // The tutor holds the new hire before Send, quotes the expert and asks why.
    await agentAsks(driver, clock, 'why_hold', 'The expert would stop here. Why do you think?', 6000);
  })();
  const report = await clock.run(Promise.all([driver.run(NEW_HIRE_T1), tutor]).then(([r]) => r));
  assert.deepEqual(
    played.map((p) => p.clipId),
    ['newHire.predict_t1', 'newHire.why_hold', 'newHire.ack'],
  );
  assert.deepEqual(report.checks, ['warn', 'clear']);
  assert.equal(report.sent, true);
  const fix = workspace.typed.find((t) => t.target === 'body');
  assert.equal(fix?.mode, 'replace');
  assert.match(fix?.text ?? '', /ORD-2057/);
  assert.match(fix?.text ?? '', /82 Sample Walk, 1010 Exampletown/);
  assert.match(fix?.text ?? '', /2026-10-13 09:00-11:00/);
  // Order of events: open, preview (warn), fix, preview (clear), send.
  assert.deepEqual(
    workspace.calls.filter((c) => /^(open|preview|type|send)/.test(c)),
    ['open:new-image', 'preview', 'type:body', 'preview', 'send'],
  );
});

test('Teach T1 with a silent tutor: the new hire still fixes the email after the warning but does not invent a reaction', async () => {
  const { clock, driver, played, workspace } = setup(NEW_HIRE, { checks: ['warn', 'clear'] });
  const report = await clock.run(driver.run(NEW_HIRE_T1));
  assert.equal(played.length, 0, 'nobody asked, nobody is answered');
  assert.ok(workspace.calls.includes('type:body'));
  assert.equal(report.sent, true);
});

test('Teach T2 and T3: a clear check is sent as it is; T4: an unknown check is not sent', async () => {
  for (const task of [NEW_HIRE_T2, NEW_HIRE_T3]) {
    const t = setup(NEW_HIRE, { checks: ['clear'] });
    const report = await t.clock.run(t.driver.run(task));
    assert.equal(report.sent, true, task.id);
    assert.ok(!t.workspace.calls.includes('type:body'), `${task.id}: nothing to fix`);
  }
  const t4 = setup(NEW_HIRE, { checks: ['unknown'] });
  const report = await t4.clock.run(t4.driver.run(NEW_HIRE_T4));
  assert.equal(report.sent, false);
  assert.ok(!t4.workspace.calls.includes('send'));
});

test('pauses are real: the persona stays still for the whole pause so the agent can see a natural quiet', async () => {
  const { clock, driver, workspace, logs } = setup();
  await clock.run(driver.run(EXPERT_LEARN));
  // After the image is removed there is no workspace action for at least 6 s (the pause is 7 s +-10%).
  const removed = logs.find((l) => l.kind === 'step' && l.text === 'remove_image');
  const nextAction = logs.find((l) => l.kind === 'step' && l.text === 'type' && l.atMs > (removed?.atMs ?? 0));
  assert.ok(removed && nextAction);
  assert.ok(nextAction.atMs - removed.atMs >= 6000, `${nextAction.atMs - removed.atMs} ms`);
  assert.ok(workspace.calls.length > 0);
});

// ---- vision lag --------------------------------------------------------------------------------------------------------

/** The time between two logged steps (by their first occurrence after `after`). */
function gap(logs: DriverLog[], from: string, to: string): number {
  const a = logs.find((l) => l.kind === 'step' && l.text === from);
  const b = logs.find((l) => l.kind === 'step' && l.text === to && l.atMs > (a?.atMs ?? 0));
  assert.ok(a && b, `${from} then ${to}`);
  return b.atMs - a.atMs;
}

test('vision lag: a pause lasts the vision lag longer, so the agent has seen the change before the quiet starts', async () => {
  const none = setup(EXPERT, { visionLagMs: 0 });
  await none.clock.run(none.driver.run(EXPERT_LEARN));
  const lagged = setup(EXPERT, { visionLagMs: 5000 });
  await lagged.clock.run(lagged.driver.run(EXPERT_LEARN));
  const base = gap(none.logs, 'remove_image', 'type');
  const slow = gap(lagged.logs, 'remove_image', 'type');
  assert.ok(slow - base >= 4000, `${base} ms without the lag, ${slow} ms with it`);
  assert.ok(slow >= 11_000, 'at least the pause (7 s) plus the lag (5 s), minus the jitter');
});

test('vision lag: a change that no pause follows is given settle time before the next action', async () => {
  const { clock, driver, logs } = setup(NEW_HIRE, { checks: ['clear'], visionLagMs: 5000 });
  await clock.run(driver.run(NEW_HIRE_T3));
  // open -> look: the order has to be seen first; send -> look: the sent state has to be seen first.
  assert.ok(gap(logs, 'open', 'look') >= 4500, `open to look ${gap(logs, 'open', 'look')} ms`);
  assert.ok(gap(logs, 'send', 'look') >= 4500, `send to look ${gap(logs, 'send', 'look')} ms`);
});

test('vision lag: typing that is followed straight by Preview is settled before the Preview, and without a lag it is not', async () => {
  const lagged = setup(NEW_HIRE, { checks: ['warn', 'clear'], visionLagMs: 5000 });
  await lagged.clock.run(lagged.driver.run(NEW_HIRE_T1));
  const typedAt = lagged.logs.filter((l) => l.kind === 'step' && l.text === 'type').at(-1);
  const previewAfter = lagged.logs.filter((l) => l.kind === 'step' && l.text === 'preview' && l.atMs > (typedAt?.atMs ?? 0))[0];
  assert.ok(typedAt && previewAfter);
  // The step is logged when it starts: the gap holds the typing itself (2 s in the fake) plus the settle time.
  assert.ok(previewAfter.atMs - typedAt.atMs >= 2000 + 4500, `${previewAfter.atMs - typedAt.atMs} ms`);
  const plain = setup(NEW_HIRE, { checks: ['warn', 'clear'], visionLagMs: 0 });
  await plain.clock.run(plain.driver.run(NEW_HIRE_T1));
  const typed0 = plain.logs.filter((l) => l.kind === 'step' && l.text === 'type').at(-1);
  const preview0 = plain.logs.filter((l) => l.kind === 'step' && l.text === 'preview' && l.atMs > (typed0?.atMs ?? 0))[0];
  assert.ok(typed0 && preview0);
  assert.ok(preview0.atMs - typed0.atMs < 3000);
});

test('the default vision lag matches what was measured on the live stack (4 to 6 s per frame)', () => {
  assert.ok(DEFAULT_VISION_LAG_MS >= 4000 && DEFAULT_VISION_LAG_MS <= 7000);
});
