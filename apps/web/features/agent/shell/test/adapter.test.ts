// The adapter between the shell's Brain seam and packages/agent (AgentBrain), and the model route behind it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlmClient, describeLlmEvent } from '../brain/llm-transport.ts';
import { AgentBrain, NOT_SPOKEN_BACKOFF_MS } from '../brain/agent-brain.ts';
import type { BrainSignals } from '../brain/types.ts';
import { createAgentApi } from '../api.ts';
import { SAMPLE_CUSTOMERS, buildScenario } from '../screen/sample-scenarios.ts';
import { expertAnswer } from './fixtures.ts';
import { productRig } from './product-rig.ts';
import { TOKEN, json, legacyApi, modernApi, must, recordingFetch, settle } from './helpers.ts';
import type { RecordedRequest, Responder } from './helpers.ts';

const signals = (over: Partial<BrainSignals> = {}): BrainSignals => ({
  sessionId: 's', mode: 'learn', persona: 'plain', offRecord: false, voiceConnected: true, agentSpeaking: false, humanSpeaking: false, asked: 0, ...over,
});

/** The Learn script, delivered in time order: `feed(ms)` plays every observation up to that moment, as the screen would. */
function learnBrain(): { brain: AgentBrain; lines: string[]; feed(ms: number): void } {
  const lines: string[] = [];
  const brain = new AgentBrain({ log: (l) => lines.push(l), customers: SAMPLE_CUSTOMERS });
  brain.begin({ sessionId: 's1', mode: 'learn', persona: 'plain', llm: null });
  const pending = [...buildScenario('learn', 's1').observations];
  const feed = (ms: number): void => {
    while (pending.length > 0 && must(pending[0]).timestampMs <= ms) brain.onObservation(must(pending.shift()));
  };
  return { brain, lines, feed };
}

test('the policy decides: ASK_NOW at the first natural pause becomes a BrainDecision with an utterance, evidence and a Clipa target', () => {
  const { brain, feed } = learnBrain();
  feed(10_000);
  assert.deepEqual(brain.tick(10_000, signals()).filter((d) => d.decision === 'ASK_NOW'), [], 'the expert is still working: nothing is asked');
  feed(23_000);
  const decisions = brain.tick(23_000, signals());
  const ask = must(decisions.find((d) => d.decision === 'ASK_NOW'));
  assert.equal(ask.topic, 'reason');
  assert.equal(ask.kind, 'reason');
  assert.ok(must(ask.utterance).text.length > 0);
  assert.ok(must(ask.questionId).startsWith('q-L-'));
  assert.equal(ask.expectsAnswer, true);
  assert.ok(ask.evidenceIds.length > 0, 'about a screen moment');
  assert.deepEqual(ask.clipa?.target, { surface: 'email', hint: 'attachments' }, 'Clipa goes to what changed on screen');
  assert.ok(ask.whyNow.length > 0);
  assert.ok(!/phone|writing/i.test(must(ask.utterance).text), 'the question states no rule');
});

test('while the person speaks or the agent speaks nothing is asked; off the record nothing is asked', () => {
  const { brain, feed } = learnBrain();
  feed(23_000);
  assert.equal(brain.tick(23_000, signals({ humanSpeaking: true })).some((d) => d.decision === 'ASK_NOW'), false);
  assert.equal(brain.tick(23_500, signals({ agentSpeaking: true })).some((d) => d.decision === 'ASK_NOW'), false);
  assert.deepEqual(brain.tick(24_000, signals({ offRecord: true })), []);
});

test('a question that was not spoken goes back to the queue and is asked again', () => {
  const { brain, feed } = learnBrain();
  feed(23_000);
  const first = must(brain.tick(23_000, signals()).find((d) => d.decision === 'ASK_NOW'));
  brain.onNotSpoken(first);
  assert.equal(brain.tick(24_000, signals()).some((d) => d.decision === 'ASK_NOW'), false, 'it waits before it is asked again');
  const again = brain.tick(23_000 + NOT_SPOKEN_BACKOFF_MS + 500, signals()).find((d) => d.decision === 'ASK_NOW');
  assert.equal(again?.topic, first.topic);
});

test('an answer goes to the map with the expert\'s quote; the draft shows steps, a rule and its screen moments', async () => {
  const { brain, feed } = learnBrain();
  feed(23_000);
  const ask = must(brain.tick(23_000, signals()).find((d) => d.decision === 'ASK_NOW'));
  await brain.onAnswer({ questionId: 'd-1', topic: ask.topic, text: expertAnswer('reason'), atMs: 30_000, kind: 'answer' });
  const { map } = brain.review();
  assert.ok(map.steps.length > 0);
  const rule = must(map.guardrails).find((g) => g.text.includes('The expert:'));
  assert.ok(rule);
  assert.ok(must(rule).evidenceIds.length > 0);
  assert.equal(map.version, 1);
  assert.equal(map.confirmed, false);
});

test('an answer with no open question changes nothing', async () => {
  const { brain, lines } = learnBrain();
  const before = brain.review().map;
  await brain.onAnswer({ questionId: null, topic: null, text: 'hello', atMs: 1, kind: 'answer' });
  assert.deepEqual(brain.review().map, before);
  assert.ok(lines.some((l) => /no open question/.test(l)));
});

test('the log lines of the brain carry no answer text', async () => {
  const { brain, lines, feed } = learnBrain();
  feed(23_000);
  const ask = must(brain.tick(23_000, signals()).find((d) => d.decision === 'ASK_NOW'));
  const text = expertAnswer('reason');
  await brain.onAnswer({ questionId: 'd-1', topic: ask.topic, text, atMs: 30_000, kind: 'answer' });
  assert.ok(lines.every((l) => !l.includes('phone') && !l.includes('in writing')));
});

// ---- the model route ---------------------------------------------------------------------------------------------------------------

test('the LLM client of a session posts to /api/agent/llm/:task with the session token; the placeholder API has none', async () => {
  const { fetch, calls } = recordingFetch(modernApi(), (req) => (req.url.includes('/llm/') ? json(200, { ok: true, output: { ref: null } }) : null));
  const api = createAgentApi({ base: 'https://api.example.invalid', fetch, now: () => 1, newId: () => 'x' });
  const session = await api.createSession();
  const lines: string[] = [];
  const client = must(createLlmClient({ session, fetch, log: (l) => lines.push(l) }));
  const out = await client.call('entity_resolution', { spoken: 'customer Sample', knownRefs: ['customer_07'] });
  assert.equal(out.result.ok, true);
  const call = must(calls.find((c) => c.url.includes('/llm/')));
  assert.equal(call.url, 'https://api.example.invalid/api/agent/llm/entity_resolution');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['authorization'], `Bearer ${TOKEN}`);
  assert.deepEqual(call.body, { spoken: 'customer Sample', knownRefs: ['customer_07'] });

  const legacy = recordingFetch(legacyApi());
  const old = await createAgentApi({ base: 'https://api.example.invalid', fetch: legacy.fetch, now: () => 1, newId: () => 'old' }).createSession();
  assert.equal(createLlmClient({ session: old, fetch: legacy.fetch, log: () => {} }), null);
});

test('describeLlmEvent names the task and the outcome and nothing else', () => {
  assert.equal(describeLlmEvent({ task: 'answer_extraction', outcome: 'llm', elapsedMs: 812 }), 'LLM answer_extraction: model answered in 812 ms.');
  assert.equal(
    describeLlmEvent({ task: 'reply_classification', outcome: 'fallback', reason: 'busy', status: 429, elapsedMs: 5 }),
    'LLM reply_classification: fell back to heuristics (busy, HTTP 429) after 5 ms.',
  );
});

const extractionOutput = {
  rationale: 'his phone blocks pictures in our emails', quote: 'his phone blocks pictures in our emails',
  guardrail: { condition: 'order of customer_07', requiredAction: 'include the order details in the message', requiredFields: ['delivery address', 'delivery window'], scope: { entity: 'customer_07' } },
  exceptions: [], unknowns: [], confidence: 0.86,
};

async function answerOnce(llm: Responder): Promise<{ rig: ReturnType<typeof productRig>; calls: RecordedRequest[]; log: string }> {
  const calls: RecordedRequest[] = [];
  const rig = productRig([modernApi(), (req) => { if (req.url.includes('/llm/')) calls.push(req); return llm(req); }]);
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  for (let i = 0; i < 60; i++) { rig.timers.advance(500); await settle(3); }
  const asked = rig.voice.userMessages.length;
  assert.ok(asked >= 1);
  rig.voice.mode('speaking');
  rig.voice.say('ai', 'question');
  rig.voice.mode('listening');
  rig.voice.say('user', 'He asked for it in writing, his phone blocks pictures in our emails.');
  await settle(60);
  // The transcript lines (type USER / AGENT) are the session log by design; the brain's and the model route's lines carry no text.
  const lines = rig.controller.store.getState().events.filter((e) => e.type === 'LLM' || e.type === 'BRAIN' || e.type === 'ERR' || e.type === 'SYS');
  return { rig, calls, log: lines.map((e) => e.text).join('\n') };
}

test('with the route, the model reads the answer; the log says so and carries neither the token nor the answer', async () => {
  const { calls, log, rig } = await answerOnce((req) => (req.url.endsWith('/answer_extraction') ? json(200, { ok: true, output: extractionOutput }) : json(404, {})));
  const extraction = must(calls.find((c) => c.url.endsWith('/answer_extraction')));
  assert.equal(extraction.headers['authorization'], `Bearer ${TOKEN}`);
  const body = extraction.body as { questionTopic: string; answerText: string; visibleFacts: { orderFields: Record<string, string> } };
  assert.equal(body.questionTopic, 'reason');
  assert.equal(body.visibleFacts.orderFields['orderId'], 'ORD-2041', 'the visible order fields go with the request');
  assert.match(log, /LLM answer_extraction: model answered in \d+ ms\./);
  assert.ok(!log.includes(TOKEN));
  assert.ok(!log.includes('phone blocks'));
  assert.ok(!JSON.stringify(rig.controller.store.getState()).includes(TOKEN));
});

test('when the route fails the heuristics take over, visibly, and the answer still reaches the map', async () => {
  const { log, rig } = await answerOnce(() => json(503, { ok: false, error: 'runner_unavailable' }));
  assert.match(log, /LLM answer_extraction: fell back to heuristics \(http error, HTTP 503\)/);
  assert.ok(must(rig.controller.store.getState().draftMap.guardrails).length >= 1, 'the heuristic read the answer');
  assert.ok(!log.includes(TOKEN));
});

test('a busy route (429) falls back without losing the turn', async () => {
  const { log, rig } = await answerOnce(() => json(429, { ok: false, error: 'busy' }));
  assert.match(log, /fell back to heuristics \(busy, HTTP 429\)/);
  assert.equal(rig.controller.store.getState().feed.some((f) => f.status === 'answered'), true);
});

test('on the placeholder API the brain says it has no LLM route and uses heuristics', async () => {
  const rig = productRig([legacyApi()]);
  await rig.controller.start('learn');
  const log = rig.controller.store.getState().events.map((e) => e.text).join('\n');
  assert.match(log, /No LLM route/);
});
