import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCheckpointReply } from "@apprentice/contracts";
import type { WorkMap } from "../src/index.ts";
import {
  ConversationPolicy,
  HeuristicAnswerExtractor,
  buildPrediction,
  checkpoint,
  checkpointWithState,
  evaluatePrediction,
  getPersona,
  latestConfirmed,
  reduceMap,
  summarizeMastery,
} from "../src/index.ts";
import { buildState, expected, novicePredict, order, teachCase } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const CASES = ["t1", "t2", "t3", "t4", "t5", "t6"] as const;

async function confirmedMap(opts: Parameters<typeof buildState>[0] = { correction: true }): Promise<WorkMap> {
  return must(latestConfirmed(await buildState(opts)), "a confirmed map");
}

function run(id: string, map: WorkMap | null) {
  const c = teachCase(id);
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
}

for (const id of CASES) {
  test(`${id.toUpperCase()}: the checkpoint matches fixtures/agent/expected/${id}.json`, async () => {
    const want = expected(id);
    const map = await confirmedMap();
    const got = run(id, map);
    assert.equal(got.status, want.status);
    assert.equal(got.mapVersion, want.mapVersion);
    assert.deepEqual(got.missingFacts, want.missingFacts);
    assert.equal(got.ruleApplied, want.ruleApplied);
    if (want.mustCiteEvidence === true) assert.ok(got.evidenceIds.length > 0, "cites an evidence id");
    if (want.mustQuoteExpert === true) {
      assert.ok(got.quotes.length > 0, "quotes the expert");
      for (const q of got.quotes) assert.ok(got.message.includes(q), "the message contains the quote");
    }
    // The reply is a valid CheckpointReply and echoes the revisions it judged.
    const reply = parseCheckpointReply({
      schemaVersion: got.schemaVersion,
      checkpointId: got.checkpointId,
      status: got.status,
      message: got.message,
      evidenceIds: got.evidenceIds,
      basedOn: got.basedOn,
    });
    assert.equal(reply.checkpointId, teachCase(id).checkpoint.id);
    assert.deepEqual(got.basedOn, teachCase(id).checkpoint.revisions);
    // Evidence ids are references, not spoken words.
    for (const e of got.evidenceIds) assert.ok(!got.message.includes(e));
    // The policy turns the verdict into the decision the fixture expects.
    const policy = new ConversationPolicy({ mode: "teach", now: () => 0 });
    assert.equal(policy.decideCheckpoint(got).decision, want.policy);
  });
}

test("T5: the latest confirmed version applies; the version before the correction would have cleared the same draft", async () => {
  const corrected = await buildState({ correction: true });
  const [v1, v2] = corrected.versions;
  assert.equal(v1?.version, 1);
  assert.equal(v1?.status, "superseded");
  assert.equal(v2?.version, 2);
  assert.equal(v2?.status, "confirmed");
  assert.equal(run("t5", must(latestConfirmed(corrected))).status, "warn");

  // Without the correction, the confirmed version 1 does not require the order number: the draft would pass.
  const uncorrected = await buildState({ correction: false });
  const v = must(latestConfirmed(uncorrected));
  assert.equal(v.version, 1);
  assert.equal(run("t5", v).status, "clear");
});

test("T5: confirming a later version makes it the one the tutor applies", async () => {
  const state = await buildState({ correction: true });
  const extraction = await new HeuristicAnswerExtractor().extract({
    topic: "correction",
    text: "One more thing: this is for all customers.",
    questionId: null,
    atMs: 99000,
    evidenceIds: [],
    targetId: null,
    entityRef: null,
  });
  let next = reduceMap(state, { type: "correct", extraction });
  assert.equal(must(latestConfirmed(next)).version, 2, "an unconfirmed correction does not govern yet");
  assert.equal(run("t3", must(latestConfirmed(next))).status, "clear");
  next = reduceMap(next, { type: "confirm", atMs: 100000, quote: "Yes." });
  const latest = must(latestConfirmed(next));
  assert.equal(latest.version, 3);
  assert.equal(run("t3", latest).status, "warn", "customer_03 is covered once the expert widened the scope");
});

test("T3: another customer gets no personal rule", async () => {
  const got = run("t3", await confirmedMap());
  assert.equal(got.status, "clear");
  assert.equal(got.ruleApplied, false);
  assert.match(got.message, /no personal rule for customer_03/);
});

test("T4 and T6: an unrecognised customer and an unexplained habit are unknown, never a guess", async () => {
  const map = await confirmedMap();
  const t4 = run("t4", map);
  assert.equal(t4.status, "unknown");
  assert.match(t4.message, /will not guess/);
  const t6 = run("t6", map);
  assert.equal(t6.status, "unknown");
  assert.match(t6.message, /do not know why/);
});

test("with no expert answers the map is empty: no personal rule is applied (T1), an unknown customer is still unknown (T4)", async () => {
  const map = await confirmedMap({ answers: [], confirm: true, followUps: false });
  assert.equal(map.guardrails.length, 0);
  const t1 = run("t1", map);
  assert.equal(t1.status, "clear", "an empty map has no rule and says so");
  assert.equal(t1.ruleApplied, false);
  assert.equal(run("t4", map).status, "unknown");
});

test("a rule without a reason, and a retracted rule, are unknown", async () => {
  const noReason = await confirmedMap({ answers: ["essentials"], followUps: false });
  const g = must(noReason.guardrails[0]);
  assert.equal(g.reason, null);
  assert.equal(g.status, "proposed");
  assert.equal(run("t1", noReason).status, "unknown");
  assert.match(run("t1", noReason).message, /never explained/);

  const base = await buildState({ confirm: false });
  const extraction = await new HeuristicAnswerExtractor().extract({
    topic: "exception",
    text: "Actually no, ignore that, he does not need it any more.",
    questionId: "q-x",
    atMs: 90000,
    evidenceIds: [],
    targetId: null,
    entityRef: "customer_07",
  });
  const conflicted = reduceMap(base, { type: "answer", extraction });
  const confirmed = reduceMap(conflicted, { type: "confirm", atMs: 91000, quote: "Yes." });
  const map = must(latestConfirmed(confirmed));
  assert.equal(map.guardrails.find((x) => x.id === "g1")?.status, "conflicted");
  const got = run("t1", map);
  assert.equal(got.status, "unknown");
  assert.match(got.message, /conflicting/);
});

test("an unconfirmed or missing map is never applied", async () => {
  const draft = await buildState({ confirm: false });
  assert.equal(latestConfirmed(draft), null);
  const none = run("t1", null);
  assert.equal(none.status, "unknown");
  assert.equal(none.mapVersion, null);
  assert.match(none.message, /no confirmed Work Map/);
  assert.equal(checkpointWithState(draft, { checkpoint: teachCase("t1").checkpoint, observations: teachCase("t1").observations }).status, "unknown");
});

test("a checkpoint that does not match the observations is unknown, never clear", async () => {
  const map = await confirmedMap();
  const c = teachCase("t2");
  // The draft changed after the checkpoint: the checkpoint no longer names the latest draft observation.
  const newer = { ...c.email, id: "newer", sequence: c.email.sequence + 1, timestampMs: c.email.timestampMs + 500 };
  const stale = checkpoint({ checkpoint: c.checkpoint, observations: [...c.observations, newer], map });
  assert.equal(stale.status, "unknown");
  assert.match(stale.message, /will not judge/);
  // A checkpoint from another session is refused.
  const other = checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map, sessionId: "another-session" });
  assert.equal(other.status, "unknown");
});

test("a required field the order does not show cannot be checked: unknown, not a false warning", async () => {
  const map = await confirmedMap();
  const c = teachCase("t1");
  const orderObs = c.order;
  assert.equal(orderObs.kind, "order_view");
  if (orderObs.kind !== "order_view") return;
  const blind = { ...orderObs, facts: { ...orderObs.facts, deliveryWindow: null } };
  const got = checkpoint({ checkpoint: c.checkpoint, observations: [blind, c.email], map });
  assert.equal(got.status, "unknown");
  assert.match(got.message, /cannot read the delivery window/);
});

test("the same inputs always give the same verdict", async () => {
  const map = await confirmedMap();
  assert.deepEqual(run("t1", map), run("t1", map));
});

test("T2 without a stated exception: clear, and says it does not know about the extra attachment", async () => {
  const map = await confirmedMap({ correction: true, answers: ["reason", "essentials", "guardrail", "scope", "why_stop", "duration"] });
  const got = run("t2", map);
  assert.equal(got.status, "clear");
  assert.match(got.message, /does not say whether an extra attachment is fine/);
});

test("predict-next compares the new hire with the map", async () => {
  const map = await confirmedMap();
  const plain = getPersona("plain");
  const t1 = buildPrediction(order("ORD-2057"), map, getPersona("thorough"));
  assert.equal(t1.expect, "write_out");
  assert.deepEqual(t1.facts, ["orderId", "deliveryAddress", "deliveryWindow"]);
  assert.ok(t1.evidenceIds.length > 0);
  assert.equal(evaluatePrediction(t1, novicePredict("t1")).verdict, "miss");
  assert.ok(evaluatePrediction(t1, novicePredict("t1")).quotes.length > 0, "a miss comes with the expert's words");
  assert.equal(evaluatePrediction(t1, "I would write the address and the delivery window out.").verdict, "partial");
  assert.equal(evaluatePrediction(t1, "Write the order number, address and delivery window out.").verdict, "match");
  assert.equal(evaluatePrediction(t1, novicePredict("t2")).verdict, "match");

  assert.equal(buildPrediction(order("ORD-1902"), map, plain).expect, "usual");
  assert.equal(evaluatePrediction(buildPrediction(order("ORD-1902"), map, plain), novicePredict("t3")).verdict, "match");
  const unknown = buildPrediction(order("ORD-4410"), map, plain);
  assert.equal(unknown.expect, "ask");
  assert.equal(evaluatePrediction(unknown, novicePredict("t4")).verdict, "match");
  assert.equal(buildPrediction(order("ORD-3305"), map, plain).expect, "ask", "an unexplained habit is not predicted as a rule");
  assert.equal(buildPrediction(order("ORD-4410"), null, plain).expect, "ask", "an unrecognised customer is never guessed, with or without a map");
});

test("predict-next speaks in the persona's style and within its word limit", async () => {
  const map = await confirmedMap();
  const o = order("ORD-2057");
  for (const id of ["strict", "plain", "thorough", "quiet"] as const) {
    const persona = getPersona(id);
    const p = buildPrediction(o, map, persona);
    assert.ok(p.question.split(/\s+/).length <= persona.maxWords, `${id}: ${p.question}`);
  }
  const plain = buildPrediction(o, map, getPersona("plain"));
  assert.ok(plain.options !== null, "two choices");
  assert.match(plain.question, /, or /);
  const correct = must(plain.correctOption);
  assert.equal(evaluatePrediction(plain, correct === 0 ? "the first one" : "the second one").verdict, "match");
  assert.equal(evaluatePrediction(plain, correct === 0 ? "the second one" : "the first one").verdict, "miss");
  assert.match(buildPrediction(o, map, getPersona("strict")).question, /^What next/);
  assert.match(buildPrediction(o, map, getPersona("thorough")).question, /and why\?$/);
});

test("mastery summary separates mastered from practise", () => {
  const m = summarizeMastery([
    { caseId: "t1", title: "a", verdict: "miss", firstStatus: "warn", sent: true },
    { caseId: "t2", title: "b", verdict: "match", firstStatus: "clear", sent: true },
    { caseId: "t4", title: "c", verdict: "match", firstStatus: "unknown", sent: false },
  ]);
  assert.deepEqual(m.practise, ["t1"]);
  assert.deepEqual(m.mastered, ["t2", "t4"]);
  assert.equal(m.lines.length, 3);
});
