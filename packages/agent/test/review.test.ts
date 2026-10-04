import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeuristicAnswerExtractor,
  applyTeachBackReply,
  buildTeachBack,
  classifyReply,
  extractionIssues,
  gapVariants,
  heuristicExtract,
  latestConfirmed,
  planFollowUps,
  reduceMap,
  reviewStatus,
  teachBackDigest,
  workingMap,
} from "../src/index.ts";
import type { AnswerExtraction, GapTopic } from "../src/index.ts";
import { buildState, expertAnswer, expertTeachback } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();

test("review asks at least three follow-ups for real gaps (scope, exceptions, why, who decides) and none for closed ones", async () => {
  const draft = workingMap(await buildState({ followUps: false, confirm: false }));
  const qs = planFollowUps(draft);
  assert.ok(qs.length >= 3, `${qs.length} follow-ups`);
  assert.deepEqual(new Set(qs.map((q) => q.topic)), new Set(["scope", "exception", "why_stop", "duration"]));
  for (const q of qs) {
    assert.ok(q.evidenceIds.length > 0, "tied to a screen moment");
    assert.ok(q.targetId, "extends a guardrail");
  }
  assert.ok(qs.some((q) => /who decides/.test(q.text)), "asks who decides");
  const closed = workingMap(await buildState({ confirm: false }));
  assert.equal(planFollowUps(closed).length, 0, "nothing left to ask once every gap is closed");
});

test("a 'no' closes a gap too: it is not asked again and adds no exception", async () => {
  let state = await buildState({ answers: ["reason", "essentials", "guardrail", "scope", "why_stop", "duration"], confirm: false });
  assert.deepEqual(planFollowUps(workingMap(state)).map((q) => q.topic), ["exception"]);
  const none = await extractor.extract({ topic: "exception", text: "No, none that I know of.", questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: "g1", entityRef: "customer_07" });
  state = reduceMap(state, { type: "answer", extraction: none });
  assert.equal(workingMap(state).guardrails.find((g) => g.id === "g1")?.exceptions.length, 0);
  assert.equal(planFollowUps(workingMap(state)).length, 0);
});

test("follow-up questions fit the persona's word limit and never state a rule", async () => {
  const draft = workingMap(await buildState({ followUps: false, confirm: false }));
  for (const [persona, words] of [["strict", 12], ["plain", 18], ["thorough", 25], ["quiet", 10]] as const) {
    for (const q of planFollowUps(draft, { persona })) assert.ok(q.text.split(/\s+/).length <= words, `${persona}: ${q.text}`);
  }
  for (const topic of ["scope", "exception", "why_stop", "duration"] as GapTopic[]) {
    const variants = gapVariants(topic, "customer_07");
    assert.ok(must(variants.at(-1)).split(/\s+/).length <= 10, `${topic} has a variant for the quiet persona`);
  }
});

test("held-back Learn questions become Review questions unless the map already has the answer", async () => {
  const draft = workingMap(await buildState({ answers: ["reason"], followUps: false, confirm: false }));
  const held = [
    { candidateId: "c1", topic: "essentials" as const, entityRef: "customer_07", evidenceIds: ["ev-9"], note: "order details were typed into the message", heldAtMs: 1, expiresAtMs: 9 },
    { candidateId: "c2", topic: "reason" as const, entityRef: "customer_07", evidenceIds: ["ev-8"], note: "an attachment was removed", heldAtMs: 1, expiresAtMs: 9 },
  ];
  const qs = planFollowUps(draft, { held, max: 99 });
  assert.ok(qs.some((q) => q.topic === "essentials" && q.evidenceIds.includes("ev-9")));
  assert.ok(!qs.some((q) => q.topic === "reason"), "the reason is already in the map");
});

test("the teach-back quotes the map and ends with a question", async () => {
  const draft = workingMap(await buildState({ confirm: false }));
  const tb = buildTeachBack(draft);
  assert.equal(tb.version, 1);
  assert.match(tb.text, /version 1/);
  // It states the scope, the fields, the exception and the reason explicitly, so the expert confirms exactly that.
  assert.match(tb.text, /Scope: only for customer_07\./);
  assert.match(tb.text, /The email must include the delivery address and delivery window\./);
  assert.match(tb.text, /Exception: Yes, an extra picture is fine/);
  assert.match(tb.text, /Reason: his phone blocks pictures in our emails\./);
  assert.match(tb.text, /Reason: a wrong match sends someone else's delivery details to the wrong person\./);
  assert.equal(tb.digest, teachBackDigest(draft));
  assert.match(tb.text, /you do not know why, so I will not treat it as a rule/);
  assert.match(tb.text, /stop and ask the account manager/);
  assert.match(tb.text, /Did I get that right\?$/);
  assert.ok(tb.evidenceIds.length > 0);
});

test("a confirmation or a correction: classifyReply, then a new version", async () => {
  assert.equal(classifyReply(expertTeachback("correction")), "correct");
  assert.equal(classifyReply(expertTeachback("confirm")), "confirm");
  assert.equal(classifyReply("Yes, but one thing is off."), "unclear", "a contrast: the heuristic leaves it to the model or the buttons");

  const state = await buildState({ confirm: false });
  const corrected = await applyTeachBackReply(state, { text: expertTeachback("correction"), atMs: 90000 }, extractor);
  assert.equal(corrected.outcome, "corrected");
  assert.equal(corrected.state.versions.length, 1, "the version that was played back is kept, superseded");
  assert.equal(corrected.teachBack?.version, 2);
  assert.match(corrected.teachBack?.text ?? "", /order number, delivery address and delivery window/);
  assert.equal(latestConfirmed(corrected.state), null, "a correction is not yet a confirmation");

  const confirmed = await applyTeachBackReply(corrected.state, { text: expertTeachback("confirm"), atMs: 95000 }, extractor);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(must(latestConfirmed(confirmed.state)).version, 2);
});

test("a confirmation the map cannot back is refused and nothing changes", async () => {
  const x: AnswerExtraction = heuristicExtract({ topic: "reason", text: expertAnswer("reason"), questionId: "q", atMs: 1, evidenceIds: [], targetId: null, entityRef: "customer_07" });
  const state = reduceMap((await buildState({ answers: [], followUps: false, confirm: false })), { type: "answer", extraction: x });
  const out = await applyTeachBackReply(state, { text: "Yes, that's right.", atMs: 2 }, extractor);
  assert.equal(out.outcome, "refused");
  assert.equal(out.state, state);
  assert.ok(out.issues.some((i) => i.missing.includes("evidence")));
});

test("review is done when every gap is closed and the confirmed version is the working one", async () => {
  let state = await buildState({ followUps: false, confirm: false });
  let status = reviewStatus(state);
  assert.equal(status.done, false);
  assert.ok(status.openFollowUps.length >= 3);

  for (const q of status.openFollowUps) {
    const extraction = await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 50000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef });
    state = reduceMap(state, { type: "answer", extraction });
  }
  status = reviewStatus(state);
  assert.equal(status.openFollowUps.length, 0);
  assert.equal(status.confirmed, null);
  assert.equal(status.done, false, "no teach-back confirmed yet");

  state = (await applyTeachBackReply(state, { text: expertTeachback("confirm"), atMs: 60000 }, extractor)).state;
  assert.equal(reviewStatus(state).done, true);
  // New information re-opens the review.
  state = reduceMap(state, { type: "answer", extraction: await extractor.extract({ topic: "duration", text: "Until the end of the year.", questionId: "q", atMs: 70000, evidenceIds: ["e"], targetId: "g1", entityRef: "customer_07" }) });
  assert.equal(reviewStatus(state).done, false);
});

test("heuristic extraction: reason, facts, stop condition, scope, exception, unexplained customers", () => {
  const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07" };
  const reason = heuristicExtract({ ...input, topic: "reason", text: expertAnswer("reason") });
  assert.equal(reason.rationale, "his phone blocks pictures in our emails");
  assert.ok(reason.quote.startsWith("Customer_07 asked me"));
  assert.ok(reason.confidence > 0.5 && reason.confidence <= 0.9);

  assert.deepEqual(heuristicExtract({ ...input, topic: "essentials", text: expertAnswer("essentials") }).requiredFacts, ["deliveryAddress", "deliveryWindow"]);

  const stop = heuristicExtract({ ...input, topic: "guardrail", text: expertAnswer("guardrail") });
  assert.equal(stop.stopCondition, "I can't tell which customer an order belongs to");
  assert.equal(stop.escalateTo, "the account manager");

  const scope = heuristicExtract({ ...input, topic: "scope", text: expertAnswer("scope") });
  assert.equal(scope.scope.explicit, true);
  assert.equal(scope.scope.all, false);
  assert.deepEqual(scope.scope.customers, []);
  assert.deepEqual(scope.unexplainedCustomers.map((u) => u.customerRef), ["customer_09"]);
  assert.equal(scope.scopeQuote, "Only for him.");
  assert.equal(scope.reasonUnknown, true);

  const named = heuristicExtract({ ...input, topic: "scope", text: "Customer_07 and customer_03." });
  assert.deepEqual(named.scope.customers, ["customer_07", "customer_03"]);
  assert.equal(named.scope.explicit, true);

  assert.equal(heuristicExtract({ ...input, topic: "scope", text: "Every customer gets it." }).scope.all, false, "a scope answer never widens to everyone");
  assert.equal(heuristicExtract({ ...input, topic: "correction", text: "It is for every customer." }).scope.all, true);
  assert.equal(heuristicExtract({ ...input, topic: "scope", text: "No other customers." }).scope.all, false);

  const exc = heuristicExtract({ ...input, topic: "exception", text: expertAnswer("exception") });
  assert.equal(exc.exceptions.length, 1);
  assert.equal(heuristicExtract({ ...input, topic: "exception", text: "Actually no, ignore that." }).retracts, true);
  assert.equal(heuristicExtract({ ...input, topic: "correction", text: expertTeachback("confirm") }).confirms, true);
});

test("every heuristic extraction is grounded in the expert's words", () => {
  const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07" };
  for (const topic of ["reason", "essentials", "guardrail", "scope", "exception", "why_stop", "duration"] as const) {
    const x = heuristicExtract({ ...input, topic, text: expertAnswer(topic) });
    assert.deepEqual(extractionIssues(x), [], topic);
  }
  assert.ok(extractionIssues({ ...heuristicExtract({ ...input, topic: "reason", text: "Because." }), quote: "something else" }).length > 0);
});
