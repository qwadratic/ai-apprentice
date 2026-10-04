// The model-backed implementations behind the extractor, reply-classifier and entity-resolver seams. The server route
// POST {apiBase}/api/agent/llm/:task is replaced by an injected fetch that replays fixtures/agent/llm/recorded.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeuristicAnswerExtractor,
  LlmAnswerExtractor,
  LlmClient,
  LlmEntityResolver,
  LlmReplyClassifier,
  applyTeachBackReply,
  checkpoint,
  extractionIssues,
  latestConfirmed,
  parseAnswerExtractionOutput,
  parseEntityResolutionOutput,
  parseReplyClassificationOutput,
  planFollowUps,
  reduceMap,
  toFactKey,
  workingMap,
} from "../src/index.ts";
import type { FetchLike, LlmEvent } from "../src/index.ts";
import { arr, buildState, expertAnswer, expertTeachback, readJson, recordedFetch, rec, str, teachCase } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const BASE = "https://api.example.test";
const TOKEN = "tok_session_abc";
const para = rec(readJson("sim/paraphrases.json"));
const reasonParaphrases = arr(para.reasonParaphrases).map((r) => str(rec(r).text));
const confirmations = arr(para.confirmations).map(str);
const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07", knownRefs: ["customer_07"] };

function client(fetchImpl: FetchLike, extra: { timeoutMs?: number } = {}): LlmClient {
  return new LlmClient({ apiBase: BASE, token: TOKEN, fetch: fetchImpl, ...extra });
}

const respond = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function t1(map: Parameters<typeof checkpoint>[0]["map"]): string {
  const c = teachCase("t1");
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map }).status;
}

test("the client calls POST {apiBase}/api/agent/llm/:task with the session token and the request as JSON", async () => {
  const { fetch, calls } = recordedFetch();
  const llm = new LlmClient({ apiBase: `${BASE}/`, token: TOKEN, fetch });
  const extractor = new LlmAnswerExtractor({ client: llm });
  const text = must(reasonParaphrases[0]);
  await extractor.extract({
    ...input,
    topic: "reason",
    text,
    questionText: "What made you do that?",
    orderFields: { orderId: "ORD-2041", deliveryAddress: "14 Sample Lane", deliveryWindow: "2026-10-12 14:00-16:00" },
  });
  const call = must(calls[0]);
  assert.equal(call.url, `${BASE}/api/agent/llm/answer_extraction`);
  assert.equal(call.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(call.body, {
    questionTopic: "reason",
    questionText: "What made you do that?",
    answerText: text,
    visibleFacts: { customerRefs: ["customer_07"], orderFields: { orderId: "ORD-2041", deliveryAddress: "14 Sample Lane", deliveryWindow: "2026-10-12 14:00-16:00" } },
  });
  // Events name the task and the outcome only: no transcript, no token.
  assert.deepEqual(llm.events.map((e) => [e.task, e.outcome]), [["answer_extraction", "llm"]]);
  assert.ok(!JSON.stringify(llm.events).includes(TOKEN) && !JSON.stringify(llm.events).includes("phone"));
});

test("the route may answer with the output itself or wrapped", async () => {
  const output = { rationale: "his phone blocks pictures", quote: "his phone blocks pictures", guardrail: null, exceptions: [], unknowns: [], confidence: 0.8 };
  const text = "He asked for it because his phone blocks pictures.";
  for (const body of [output, { output }, { result: output }]) {
    const x = await new LlmAnswerExtractor({ client: client(respond(200, body)) }).extract({ ...input, topic: "reason", text });
    assert.equal(x.confidence, 0.8);
    assert.equal(x.rationale, "his phone blocks pictures");
  }
});

test("five paraphrased reasons through the model: validated, merged, and the tutor warns T1", async () => {
  const { fetch } = recordedFetch();
  const llm = client(fetch);
  const llmExtractor = new LlmAnswerExtractor({ client: llm });
  const extractor = new LlmAnswerExtractor({ client: llm });
  assert.equal(reasonParaphrases.length, 5);
  for (const text of reasonParaphrases) {
    const x = await llmExtractor.extract({ ...input, topic: "reason", text });
    assert.ok(x.rationale !== null && /phone/i.test(x.rationale), text);
    assert.deepEqual(extractionIssues(x), []);
    assert.ok(x.confidence > 0.7 && x.confidence <= 0.9);

    const state = await buildState({ correction: true, texts: { reason: text }, extractor });
    assert.equal(t1(latestConfirmed(state)), "warn", text);
  }
  assert.ok(llm.events.filter((e) => e.outcome === "llm").length >= 5);
  // The model path used the model's fields: paraphrase 3 named the fields and the customer in the model's words.
  const third = await llmExtractor.extract({ ...input, topic: "reason", text: must(reasonParaphrases[2]) });
  assert.deepEqual(third.requiredFacts, ["deliveryAddress", "deliveryWindow"]);
  assert.deepEqual(third.scope.customers, [], "a reason answer does not widen the rule");
});

test("exceptions come from the model's list, grounded in the expert's words", async () => {
  const { fetch } = recordedFetch();
  const x = await new LlmAnswerExtractor({ client: client(fetch) }).extract({
    ...input,
    topic: "exception",
    text: "Yes, a second attachment is fine, as long as the details are in the message.",
  });
  assert.deepEqual(x.exceptions.map((e) => e.text), ["a second attachment is fine", "as long as the details are in the message"]);
  for (const e of x.exceptions) assert.ok(x.text.includes(e.quote));
});

test("on an HTTP error, a timeout, a network error, bad JSON or an unusable output the heuristic answers, and the fallback is logged", async () => {
  const text = must(reasonParaphrases[1]);
  const heuristic = await new HeuristicAnswerExtractor().extract({ ...input, topic: "reason", text });
  const cases: Array<[string, FetchLike, string]> = [
    ["HTTP 500", respond(500, {}), "http_error"],
    ["HTTP 401", respond(401, {}), "http_error"],
    ["network", async () => { throw new Error("offline"); }, "network"],
    ["bad JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), "invalid_json"],
    ["no output object", respond(200, "nonsense"), "invalid_output"],
    ["missing field", respond(200, { rationale: null, quote: "x" }), "invalid_output"],
    ["confidence out of range", respond(200, { rationale: null, quote: "His phone", guardrail: null, exceptions: [], unknowns: [], confidence: 7 }), "invalid_output"],
    ["quote the expert never said", respond(200, { rationale: "x", quote: "He told me his phone cannot show images", guardrail: null, exceptions: [], unknowns: [], confidence: 0.9 }), "invalid_output"],
  ];
  for (const [name, impl, reason] of cases) {
    const llm = client(impl);
    const seen: LlmEvent[] = [];
    const logged = new LlmClient({ apiBase: BASE, token: TOKEN, fetch: impl, onEvent: (e) => seen.push(e) });
    const x = await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text });
    assert.deepEqual(x, heuristic, `${name}: the heuristic extraction is returned unchanged`);
    assert.deepEqual(llm.events.map((e) => [e.outcome, e.reason]), [["fallback", reason]], name);
    await new LlmAnswerExtractor({ client: logged }).extract({ ...input, topic: "reason", text });
    assert.equal(seen.length, 1, `${name}: onEvent was called`);
    assert.ok(must(seen[0]).elapsedMs >= 0);
  }
  assert.equal(must(client(respond(503, {})).events).length, 0);
});

test("a call that takes too long times out and falls back", async () => {
  const never: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const llm = client(never, { timeoutMs: 20 });
  const text = must(reasonParaphrases[3]);
  const x = await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text });
  assert.ok(x.rationale !== null);
  assert.deepEqual(llm.events.map((e) => [e.outcome, e.reason]), [["fallback", "timeout"]]);

  // A fetch that ignores the abort signal still times out.
  const deaf: FetchLike = () => new Promise(() => undefined);
  const llm2 = client(deaf, { timeoutMs: 20 });
  await new LlmAnswerExtractor({ client: llm2 }).extract({ ...input, topic: "reason", text });
  assert.deepEqual(llm2.events.map((e) => e.reason), ["timeout"]);

  // So does a body that never arrives.
  const slowBody: FetchLike = async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) });
  const llm3 = client(slowBody, { timeoutMs: 20 });
  await new LlmAnswerExtractor({ client: llm3 }).extract({ ...input, topic: "reason", text });
  assert.deepEqual(llm3.events.map((e) => e.reason), ["timeout"]);
});

test("without a fetch at all the heuristic answers", async () => {
  const llm = new LlmClient({ apiBase: BASE, token: TOKEN, fetch: undefined });
  const original = globalThis.fetch;
  try {
    Object.defineProperty(globalThis, "fetch", { value: undefined, configurable: true, writable: true });
    const x = await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text: must(reasonParaphrases[0]) });
    assert.ok(x.rationale !== null);
    assert.equal(must(llm.events[0]).reason, "no_fetch");
  } finally {
    Object.defineProperty(globalThis, "fetch", { value: original, configurable: true, writable: true });
  }
});

test("output validation: shapes, field names and ranges", () => {
  const ok = { rationale: "r", quote: "q", guardrail: { condition: "c", requiredAction: "a", requiredFields: ["address"], scope: { entity: null } }, exceptions: [], unknowns: [], confidence: 0.5 };
  assert.ok(parseAnswerExtractionOutput(ok));
  assert.ok(parseAnswerExtractionOutput({ ...ok, guardrail: null, rationale: null }));
  for (const bad of [null, [], { ...ok, quote: "" }, { ...ok, rationale: 5 }, { ...ok, exceptions: [1] }, { ...ok, guardrail: { condition: "c" } }, { ...ok, guardrail: { ...ok.guardrail, scope: { entity: 3 } } }, { ...ok, confidence: -1 }, { ...ok, confidence: Number.NaN }]) {
    assert.equal(parseAnswerExtractionOutput(bad), null, JSON.stringify(bad));
  }
  assert.equal(toFactKey("delivery address"), "deliveryAddress");
  assert.equal(toFactKey("orderId"), "orderId");
  assert.equal(toFactKey("order number"), "orderId");
  assert.equal(toFactKey("time"), "deliveryWindow");
  assert.equal(toFactKey("phone number"), null);
  assert.deepEqual(parseReplyClassificationOutput({ verdict: "confirm", correction: null }), { verdict: "confirm", correction: null });
  assert.equal(parseReplyClassificationOutput({ verdict: "maybe", correction: null }), null);
  assert.equal(parseReplyClassificationOutput({ verdict: "correct" }), null);
  assert.deepEqual(parseEntityResolutionOutput({ ref: "customer_07" }, ["customer_07"]), { ref: "customer_07" });
  assert.deepEqual(parseEntityResolutionOutput({ ref: null }, ["customer_07"]), { ref: null });
  assert.equal(parseEntityResolutionOutput({ ref: "customer_99" }, ["customer_07"]), null, "a ref that is not on screen is a hallucination");
});

test("a field the map does not track is dropped and noted, not guessed; a customer that is not on screen is noted, not believed", async () => {
  const body = { rationale: null, quote: "Only customer_07 gets it", guardrail: { condition: "c", requiredAction: "a", requiredFields: ["phone number", "address"], scope: { entity: "customer_55" } }, exceptions: [], unknowns: [], confidence: 0.6 };
  const x = await new LlmAnswerExtractor({ client: client(respond(200, body)) }).extract({ ...input, topic: "scope", text: "Only customer_07 gets it." });
  assert.deepEqual(x.requiredFacts, ["deliveryAddress"]);
  assert.ok(x.unknowns.some((u) => /phone number/.test(u)));
  assert.ok(x.unknowns.some((u) => /customer_55/.test(u)));
  assert.deepEqual(x.scope.customers, ["customer_07"]);
});

test("the model cannot put a customer into the rule that the expert set apart", async () => {
  const text = "Customer three is the usual case.";
  const body = { rationale: null, quote: text, guardrail: { condition: "c", requiredAction: "a", requiredFields: [], scope: { entity: "customer_03" } }, exceptions: [], unknowns: [], confidence: 0.7 };
  const known = ["customer_03", "customer_07"];
  const x = await new LlmAnswerExtractor({ client: client(respond(200, body)) }).extract({ ...input, knownRefs: known, topic: "scope", text });
  assert.deepEqual(x.scope.customers, []);
  assert.ok(x.unknowns.some((u) => /customer_03/.test(u)));
  // Said the other way round, the model's customer joins.
  const too = "Customer three too.";
  const y = await new LlmAnswerExtractor({ client: client(respond(200, { ...body, quote: too })) }).extract({ ...input, knownRefs: known, topic: "scope", text: too });
  assert.deepEqual(y.scope.customers, ["customer_03"]);
});

test("reply classification through the model: three confirmations, a correction and an unclear reply", async () => {
  const { fetch, calls } = recordedFetch();
  const llm = client(fetch);
  const classifier = new LlmReplyClassifier({ client: llm });
  const state = await buildState({ confirm: false });
  for (const reply of confirmations) assert.deepEqual(await classifier.classify("teach-back text", reply), { verdict: "confirm", correction: null }, reply);
  assert.deepEqual(await classifier.classify("teach-back text", expertTeachback("correction")), {
    verdict: "correct",
    correction: "the order number goes in as well as the address and the delivery window",
  });
  assert.equal((await classifier.classify("t", "Hmm.")).verdict, "unclear");
  assert.deepEqual(must(calls[0]).body, { teachBack: "teach-back text", reply: must(confirmations[0]) });
  assert.equal(must(calls[0]).url, `${BASE}/api/agent/llm/reply_classification`);

  // In the review: the model's verdicts drive confirm and correct, and the isolated correction is the text extracted.
  const extractor = new HeuristicAnswerExtractor();
  for (const reply of confirmations) assert.equal((await applyTeachBackReply(state, { text: reply, atMs: 5 }, extractor, classifier)).outcome, "confirmed", reply);
  const corrected = await applyTeachBackReply(state, { text: expertTeachback("correction"), atMs: 6 }, extractor, classifier);
  assert.equal(corrected.outcome, "corrected");
  assert.match(corrected.teachBack?.text ?? "", /order number, delivery address and delivery window/);
  assert.equal((await applyTeachBackReply(state, { text: "Hmm.", atMs: 7 }, extractor, classifier)).outcome, "unclear");
  assert.ok(llm.events.every((e) => e.outcome === "llm"));
});

test("reply classification falls back to the heuristic on errors, with the fallback logged", async () => {
  for (const [impl, reason] of [
    [respond(502, {}), "http_error"],
    [respond(200, { verdict: "maybe", correction: null }), "invalid_output"],
    [async () => { throw new Error("down"); }, "network"],
  ] as Array<[FetchLike, string]>) {
    const llm = client(impl);
    const classifier = new LlmReplyClassifier({ client: llm });
    assert.equal((await classifier.classify("t", "Sounds good.")).verdict, "confirm");
    assert.equal((await classifier.classify("t", "Yes, and the order number too.")).verdict, "correct");
    assert.deepEqual(llm.events.map((e) => [e.task, e.outcome, e.reason]), [
      ["reply_classification", "fallback", reason],
      ["reply_classification", "fallback", reason],
    ]);
  }
});

test("entity resolution: the numeric scheme is answered locally, other phrases go to the model, a hallucinated ref falls back", async () => {
  const { fetch, calls } = recordedFetch();
  const llm = client(fetch);
  const resolver = new LlmEntityResolver({ client: llm });
  const known = ["customer_07", "customer_09"];
  assert.equal(await resolver.resolve("customer seven", known), "customer_07");
  assert.equal(calls.length, 0, "no call for what the numbers say");
  assert.equal(await resolver.resolve("customer Sample", known), "customer_07");
  assert.deepEqual(must(calls[0]).body, { spoken: "customer Sample", knownRefs: known });
  assert.equal(must(calls[0]).url, `${BASE}/api/agent/llm/entity_resolution`);
  assert.equal(await resolver.resolve("customer Nobody", known), null);
  assert.equal(await resolver.resolve("customer Invented", known), null, "customer_99 is not on screen");
  assert.deepEqual(llm.events.map((e) => [e.outcome, e.reason]), [["llm", undefined], ["llm", undefined], ["fallback", "invalid_output"]]);
  // A broken route: the heuristic has nothing for a name, so the answer is null, and it is logged.
  const down = client(respond(500, {}));
  assert.equal(await new LlmEntityResolver({ client: down }).resolve("customer Sample", known), null);
  assert.equal(must(down.events[0]).reason, "http_error");
});

test("the extractor uses the entity resolver for spoken names: the answer is attributed to the right customer", async () => {
  const { fetch } = recordedFetch();
  const llm = client(fetch);
  const resolver = new LlmEntityResolver({ client: llm });
  const text = "Only customer Sample gets it. Customer nine asks for something similar, but I never found out why.";
  const x = await new HeuristicAnswerExtractor(resolver).extract({ ...input, topic: "scope", text, knownRefs: ["customer_07", "customer_09"] });
  assert.deepEqual(x.scope.customers, ["customer_07"]);
  assert.deepEqual(x.unexplainedCustomers.map((u) => u.customerRef), ["customer_09"]);
  const viaLlm = await new LlmAnswerExtractor({ client: llm, resolver }).extract({ ...input, topic: "scope", text, knownRefs: ["customer_07", "customer_09"] });
  assert.deepEqual(viaLlm.scope.customers, ["customer_07"], "recorded extraction missing for this text: the heuristic with the resolved name");
  assert.ok(llm.events.some((e) => e.task === "entity_resolution" && e.outcome === "llm"));
});

test("a whole Review on model-backed parts: paraphrases in, confirmed map out, T1 warns", async () => {
  const { fetch } = recordedFetch();
  const llm = client(fetch);
  const extractor = new LlmAnswerExtractor({ client: llm });
  const classifier = new LlmReplyClassifier({ client: llm });
  let state = await buildState({ followUps: false, confirm: false, texts: { reason: must(reasonParaphrases[0]) }, extractor });
  for (const q of planFollowUps(workingMap(state))) {
    const extraction = await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 60000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef, knownRefs: ["customer_07"] });
    state = reduceMap(state, { type: "answer", extraction });
  }
  const corrected = await applyTeachBackReply(state, { text: expertTeachback("correction"), atMs: 90000 }, extractor, classifier);
  assert.equal(corrected.outcome, "corrected");
  const confirmed = await applyTeachBackReply(corrected.state, { text: "Uh, yes, that's right.", atMs: 95000 }, extractor, classifier);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(t1(latestConfirmed(confirmed.state)), "warn");
  const used = llm.events.filter((e) => e.outcome === "llm").map((e) => e.task);
  assert.ok(used.includes("answer_extraction") && used.includes("reply_classification"));
  // Answers with no recording (404) were read by the heuristic, and logged as such.
  assert.ok(llm.events.some((e) => e.outcome === "fallback" && e.reason === "http_error"));
});

// ---------------------------------------------------------------------------
// The server allows one call in flight per session and answers 429 "busy" otherwise.

const busy: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error: "busy" }) });

test("HTTP 429 busy: every model-backed part falls back to the heuristic without losing the turn, and says so", async () => {
  const text = must(reasonParaphrases[0]);
  const heuristic = await new HeuristicAnswerExtractor().extract({ ...input, topic: "reason", text });
  const llm = client(busy);
  assert.deepEqual(await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text }), heuristic);
  assert.equal((await new LlmReplyClassifier({ client: llm }).classify("t", "Sounds good.")).verdict, "confirm");
  assert.equal((await new LlmReplyClassifier({ client: llm }).classify("t", "Correct, he wants the order number in there as well.")).verdict, "correct");
  assert.equal(await new LlmEntityResolver({ client: llm }).resolve("customer Sample", ["customer_07"]), null);
  assert.deepEqual(llm.events.map((e) => [e.task, e.outcome, e.reason, e.status]), [
    ["answer_extraction", "fallback", "busy", 429],
    ["reply_classification", "fallback", "busy", 429],
    ["reply_classification", "fallback", "busy", 429],
    ["entity_resolution", "fallback", "busy", 429],
  ]);

  // A whole review on a busy server still ends with a confirmed map.
  const extractor = new LlmAnswerExtractor({ client: llm });
  const classifier = new LlmReplyClassifier({ client: llm });
  let state = await buildState({ followUps: false, confirm: false, texts: { reason: text }, extractor });
  for (const q of planFollowUps(workingMap(state))) {
    const extraction = await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 60000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef, knownRefs: ["customer_07"] });
    state = reduceMap(state, { type: "answer", extraction });
  }
  const confirmed = await applyTeachBackReply(state, { text: "Uh, yes, that's right.", atMs: 95000 }, extractor, classifier);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(t1(latestConfirmed(confirmed.state)), "warn");
  assert.ok(llm.events.every((e) => e.outcome === "fallback" && e.reason === "busy"));
});

test("calls are queued and sent one at a time", async () => {
  let inFlight = 0;
  let peak = 0;
  const urls: string[] = [];
  const slow: FetchLike = async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    urls.push(url.slice(url.lastIndexOf("/") + 1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight--;
    return { ok: true, status: 200, json: async () => ({ ok: true, output: { verdict: "confirm", correction: null } }) };
  };
  const llm = client(slow);
  const classifier = new LlmReplyClassifier({ client: llm });
  const results = await Promise.all([1, 2, 3, 4].map((n) => classifier.classify("t", `Sounds good, number ${n}.`)));
  assert.equal(peak, 1, "never two calls in flight");
  assert.equal(urls.length, 4);
  assert.ok(results.every((r) => r.verdict === "confirm"));
  assert.ok(llm.events.every((e) => e.outcome === "llm"));

  // Different tasks share the queue too: an extraction and a classification do not overlap.
  inFlight = 0;
  peak = 0;
  await Promise.all([
    new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text: must(reasonParaphrases[0]) }),
    classifier.classify("t", "Sounds good."),
  ]);
  assert.equal(peak, 1);
});

test("a call that waits too long in the queue falls back without being sent, and the queue goes on", async () => {
  let sent = 0;
  const gate: { open: () => void } = { open: () => undefined };
  const held = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const impl: FetchLike = async () => {
    sent++;
    if (sent === 1) await held;
    return { ok: true, status: 200, json: async () => ({ ok: true, output: { verdict: "confirm", correction: null } }) };
  };
  const llm = new LlmClient({ apiBase: BASE, token: TOKEN, fetch: impl, timeoutMs: 500, maxQueueWaitMs: 20 });
  const classifier = new LlmReplyClassifier({ client: llm });
  const first = classifier.classify("t", "Sounds good.");
  const second = await classifier.classify("t", "Okay, that's correct.");
  assert.equal(second.verdict, "confirm", "the heuristic answered the turn");
  assert.equal(sent, 1, "the second call never reached the server");
  assert.equal(must(llm.events.at(-1)).reason, "queue_timeout");
  gate.open();
  assert.equal((await first).verdict, "confirm");
  assert.equal((await classifier.classify("t", "Sounds good.")).verdict, "confirm");
  assert.equal(sent, 2, "a later call is sent normally");
  assert.equal(must(llm.events.at(-1)).outcome, "llm");
});

test("what is sent matches what the server accepts: exact keys, a non-empty question, order fields by name with values", async () => {
  const bodies: Record<string, Record<string, unknown>> = {};
  const spy: FetchLike = async (url, init) => {
    bodies[url.slice(url.lastIndexOf("/") + 1)] = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const llm = client(spy);
  await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "reason", text: "He asked for it." });
  await new LlmAnswerExtractor({ client: llm }).extract({ ...input, topic: "correction", text: "Yes. Customer twelve too." });
  await new LlmReplyClassifier({ client: llm }).classify("Let me play it back.", "Sounds good.");
  await new LlmEntityResolver({ client: llm }).resolve("customer Sample", ["customer_07"]);
  const extraction = must(bodies.answer_extraction);
  assert.deepEqual(Object.keys(extraction).sort(), ["answerText", "questionText", "questionTopic", "visibleFacts"]);
  assert.ok(typeof extraction.questionText === "string" && extraction.questionText.length > 0, "the route refuses an empty question");
  const facts = rec(extraction.visibleFacts);
  assert.deepEqual(Object.keys(facts).sort(), ["customerRefs", "orderFields"]);
  assert.deepEqual(facts.orderFields, {}, "no order fields given: an empty map, not a list");
  assert.deepEqual(Object.keys(must(bodies.reply_classification)).sort(), ["reply", "teachBack"]);
  assert.deepEqual(Object.keys(must(bodies.entity_resolution)).sort(), ["knownRefs", "spoken"]);

  // Inputs the route would refuse are not sent.
  const calls: string[] = [];
  const counting: FetchLike = async (url) => {
    calls.push(url);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const llm2 = client(counting);
  await new LlmAnswerExtractor({ client: llm2 }).extract({ ...input, topic: "reason", text: "x".repeat(4001) });
  await new LlmReplyClassifier({ client: llm2 }).classify("t", "y".repeat(2001));
  await new LlmEntityResolver({ client: llm2 }).resolve("customer Sample", []);
  assert.deepEqual(calls, []);
  assert.deepEqual(llm2.events.map((e) => [e.outcome, e.reason]), [["fallback", "invalid_input"], ["fallback", "invalid_input"], ["fallback", "invalid_input"]]);
});
