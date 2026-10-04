// The confirmation gate (structural): Teach applies only a rule version the expert confirmed in a teach-back that states that exact
// version. Every extracted or corrected version, heuristic or model, is provisional until then. So whatever a misread utterance does
// to the map, it cannot reach the new hire: the worst a bad parse can do is put a wrong statement into a teach-back the expert
// hears, and corrects.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationPolicy,
  HeuristicAnswerExtractor,
  MAX_UNCLEAR,
  MapValidationError,
  ReviewClarifier,
  applyTeachBackReply,
  buildTeachBack,
  checkpoint,
  createMapState,
  heuristicExtract,
  latestConfirmed,
  planFollowUps,
  pressReviewButton,
  reduceMap,
  reviewStatus,
  teachBackDigest,
  validateWorkMap,
  workingMap,
} from "../src/index.ts";
import type { AnswerExtraction, ReplyClassifier, ReplyVerdict, TutorVerdict, WorkMap } from "../src/index.ts";
import { buildState, expected, expertAnswer, expertTeachback, scenarioCustomers, startLearnSession, teachCase } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();
const IDS = ["t1", "t2", "t3", "t4", "t5", "t6"];
const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07", knownRefs: scenarioCustomers() };

function teach(id: string, map: WorkMap | null): TutorVerdict {
  const c = teachCase(id);
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
}

/** A classifier that always says "confirm", as a model that misreads would. */
const alwaysConfirm: ReplyClassifier = {
  name: "always-confirm",
  classify: (): Promise<ReplyVerdict> => Promise.resolve({ verdict: "confirm", correction: null }),
};

function personalRule(map: WorkMap) {
  return must(map.guardrails.find((g) => g.trigger === "customer" && !g.unexplained));
}

function assertNotConfirmedYet(map: WorkMap | null, why: string): void {
  for (const id of IDS) {
    const got = teach(id, map);
    assert.equal(got.status, "unknown", `${why}: ${id}`);
    assert.match(got.message, /not confirmed by the expert yet/, `${why}: ${id}`);
    assert.equal(got.ruleApplied, false, `${why}: ${id}`);
    assert.deepEqual(got.missingFacts, [], `${why}: ${id}`);
  }
}

// ---------------------------------------------------------------------------

test("before the expert confirms, Teach says 'not confirmed by the expert yet' on every case: never warn, never clear", async () => {
  const state = await buildState({ correction: true, confirm: false });
  assert.equal(latestConfirmed(state), null);
  assertNotConfirmedYet(null, "no confirmed map");
  // Even handed the provisional working version directly, the tutor does not apply it.
  assertNotConfirmedYet(workingMap(state), "provisional working map");
});

test("a heuristic misparse can never make T3 warn without a confirmed teach-back that states 'every customer'", async () => {
  // 1. The heuristic never reads "everyone" from an answer to the scope question: it is the default, not the rule.
  for (const text of ["Every customer gets the picture.", "Everyone else gets the picture.", "Every customer gets it.", "It is for everyone."]) {
    assert.equal(heuristicExtract({ ...input, topic: "scope", text }).scope.all, false, text);
    const state = await buildState({ texts: { scope: text }, confirm: false });
    assert.notEqual(personalRule(workingMap(state)).scope.kind, "all", text);
    assertNotConfirmedYet(workingMap(state), text);
  }

  // 2. Suppose a parser did misread it (a model, or a future heuristic): the map holds a provisional "every customer".
  let state = await buildState({ confirm: false });
  const before = buildTeachBack(workingMap(state));
  assert.match(before.text, /Scope: only for customer_07\./);
  const misparsed: AnswerExtraction = {
    ...heuristicExtract({ ...input, topic: "scope", text: "Every customer gets the picture." }),
    scope: { customers: [], all: true, explicit: true },
    scopeQuote: "Every customer gets the picture.",
  };
  state = reduceMap(state, { type: "answer", extraction: misparsed });
  assert.equal(personalRule(workingMap(state)).scope.kind, "all", "the misparse is in the working map");

  // 3. It is provisional: T3 does not warn, nor does any case apply it.
  assert.equal(latestConfirmed(state), null);
  assert.equal(teach("t3", latestConfirmed(state)).status, "unknown");
  assertNotConfirmedYet(workingMap(state), "provisional misparse");

  // 4. The teach-back the expert hears states it, in words they cannot miss.
  const tb = buildTeachBack(workingMap(state));
  assert.match(tb.text, /Scope: for every customer\./);
  assert.notEqual(tb.digest, before.digest);

  // 5. A confirmation of the teach-back from before the misparse does not confirm it.
  assert.throws(() => reduceMap(state, { type: "confirm", atMs: 5, quote: "Yes.", stated: before.digest }), MapValidationError);
  const stale = await applyTeachBackReply(state, { text: "Yes.", atMs: 5 }, extractor, undefined, before);
  assert.equal(stale.outcome, "stale");
  assert.equal(latestConfirmed(stale.state), null);
  assert.equal(stale.teachBack?.digest, tb.digest, "the expert is told the current version again");
  assert.equal(pressReviewButton(state, new ReviewClarifier(), "teachback:1", "confirm", 5, before).outcome, "stale");
  assert.equal(teach("t3", latestConfirmed(stale.state)).status, "unknown");

  // 6. A reply that is not only confirmation tokens is not a confirmation, whoever classified it.
  for (const text of ["Yes, but not for everyone.", "Yes, customer twelve too.", "Right, only for customer seven.", "Yes?", "I guess so."]) {
    const out = await applyTeachBackReply(state, { text, atMs: 6 }, extractor, alwaysConfirm, tb);
    assert.notEqual(out.outcome, "confirmed", text);
    assert.equal(latestConfirmed(out.state), null, text);
  }
  assert.equal(teach("t3", latestConfirmed(state)).status, "unknown");

  // 7. Only the expert's confirmation of the teach-back that states "every customer" makes it apply.
  const done = await applyTeachBackReply(state, { text: "Yes, that's right.", atMs: 7 }, extractor, undefined, tb);
  assert.equal(done.outcome, "confirmed");
  const map = must(latestConfirmed(done.state));
  assert.equal(map.confirmation?.statedDigest, tb.digest);
  assert.equal(teach("t3", map).status, "warn");
  assert.equal(teach("t3", map).ruleApplied, true);
});

test("a correction is a new provisional version with a new teach-back; Teach keeps the last confirmed version until it is confirmed", async () => {
  const state = await buildState({ confirm: false });
  const v1 = buildTeachBack(workingMap(state));
  const first = await applyTeachBackReply(state, { text: "Yes.", atMs: 1 }, extractor, undefined, v1);
  assert.equal(first.outcome, "confirmed");
  const map1 = must(latestConfirmed(first.state));
  assert.equal(map1.version, 1);
  assert.equal(map1.confirmation?.statedDigest, v1.digest);
  assert.equal(teach("t5", map1).status, "clear", "the order number is not part of version 1");

  // The expert corrects: the order number goes in as well.
  const corrected = await applyTeachBackReply(first.state, { text: expertTeachback("correction"), atMs: 2 }, extractor, undefined, v1);
  assert.equal(corrected.outcome, "corrected");
  const v2 = must(corrected.teachBack);
  assert.equal(v2.version, 2);
  assert.match(v2.text, /order number, delivery address and delivery window/);
  assert.notEqual(v2.digest, v1.digest);
  // The new version is provisional: Teach still applies version 1 (and says so), and the working map is not applied at all.
  assert.equal(must(latestConfirmed(corrected.state)).version, 1);
  assert.equal(teach("t5", latestConfirmed(corrected.state)).status, "clear");
  assert.equal(teach("t5", latestConfirmed(corrected.state)).mapVersion, 1);
  assertNotConfirmedYet(workingMap(corrected.state), "version 2 before confirmation");

  // A confirmation of the old teach-back does not confirm the new one.
  const old = await applyTeachBackReply(corrected.state, { text: "Yes.", atMs: 3 }, extractor, undefined, v1);
  assert.equal(old.outcome, "stale");
  assert.equal(must(latestConfirmed(old.state)).version, 1);
  assert.throws(() => reduceMap(corrected.state, { type: "confirm", atMs: 3, quote: "Yes.", stated: v1.digest }), MapValidationError);

  // A confirmation of exactly version 2 makes it the one Teach applies.
  const done = await applyTeachBackReply(corrected.state, { text: "Sounds good.", atMs: 4 }, extractor, undefined, v2);
  assert.equal(done.outcome, "confirmed");
  const map2 = must(latestConfirmed(done.state));
  assert.equal(map2.version, 2);
  assert.equal(map2.confirmation?.statedDigest, v2.digest);
  const t5 = teach("t5", map2);
  assert.equal(t5.status, "warn");
  assert.deepEqual(t5.missingFacts, ["orderId"]);
  assert.equal(t5.mapVersion, 2);
});

test("a confirmation is a reply of confirmation tokens only, or the Confirm button; after two unclear replies the buttons appear and the rule stays provisional", async () => {
  const state = await buildState({ confirm: false });
  const tb = buildTeachBack(workingMap(state));
  for (const text of ["Yes, but for every customer.", "Yes, and customer twelve too.", "Right, but put the order number in as well.", "Yes, if he asks.", "Sure, why not?"]) {
    const out = await applyTeachBackReply(state, { text, atMs: 1 }, extractor, alwaysConfirm, tb);
    assert.notEqual(out.outcome, "confirmed", text);
    assert.equal(latestConfirmed(out.state), null, text);
  }
  assertNotConfirmedYet(latestConfirmed(state), "nothing confirmed");

  // Unclear replies: ask again once, then the buttons; the item stays unresolved and Teach still says "not confirmed".
  const clarifier = new ReviewClarifier();
  let latest = state;
  const id = `teachback:${tb.version}`;
  let steps = 0;
  for (const text of ["Hmm.", "Uh...", "I'm not sure.", "What?"]) {
    const out = await applyTeachBackReply(latest, { text, atMs: 2 }, extractor, undefined, tb);
    assert.equal(out.outcome, "unclear", text);
    latest = out.state;
    if (steps < MAX_UNCLEAR) clarifier.unclear(id);
    steps++;
  }
  assert.ok(clarifier.isUnresolved(id));
  assert.equal(latestConfirmed(latest), null);
  assertNotConfirmedYet(latestConfirmed(latest), "unclear replies");

  // The Confirm button states the version the expert sees: it confirms that, and only that.
  const pressed = pressReviewButton(latest, clarifier, id, "confirm", 9, tb);
  assert.equal(pressed.outcome, "confirmed");
  const map = must(latestConfirmed(pressed.state));
  assert.equal(map.confirmation?.statedDigest, tb.digest);
  assert.equal(teach("t1", map).status, "warn");
});

test("the teach-back states the scope, the fields, the exception and the reason (or that they are unknown)", async () => {
  const full = buildTeachBack(workingMap(await buildState({ confirm: false })));
  assert.match(full.text, /Scope: only for customer_07\. The email must include the delivery address and delivery window\. Exception: .* Reason: his phone blocks pictures in our emails\./);

  // The scope and the exception were not stated: the teach-back says so instead of staying silent. The fields come from what the
  // expert typed on screen, and are stated too, so that the expert confirms or corrects them.
  const thin = buildTeachBack(workingMap(await buildState({ answers: ["reason", "guardrail"], followUps: false, confirm: false })));
  assert.match(thin.text, /Scope: only for customer_07 \(you did not say; I assume it from the screen\)\. The email must include the delivery address and delivery window\. No exception stated\. Reason: his phone blocks pictures in our emails\./);

  // Nothing seen on screen and no essentials answer: it says it does not know what the email must include.
  const reason = heuristicExtract({ ...input, topic: "reason", text: expertAnswer("reason") });
  const bare = buildTeachBack(workingMap(reduceMap(createMapState(scenarioCustomers()), { type: "answer", extraction: reason })));
  assert.match(bare.text, /I do not know yet what the email must include\. No exception stated\./);

  // No reason: "Reason unknown."
  const unexplained = buildTeachBack(workingMap(await buildState({ answers: ["essentials", "guardrail"], followUps: false, confirm: false })));
  assert.match(unexplained.text, /Scope: only for customer_07 .*Reason unknown\./);

  // "Every customer" is stated as such, in a different sentence from "only for".
  const wide = await applyTeachBackReply(await buildState({ confirm: false }), { text: "It is for every customer.", atMs: 1 }, extractor);
  assert.equal(wide.outcome, "corrected");
  assert.match(must(wide.teachBack).text, /Scope: for every customer\./);
  assert.doesNotMatch(must(wide.teachBack).text, /only for customer_07/);
});

test("a map whose confirmation does not state its content is refused by the tutor", async () => {
  const map = must(latestConfirmed(await buildState({ correction: true })));
  assert.deepEqual(validateWorkMap(map), []);
  assert.equal(map.confirmation?.statedDigest, teachBackDigest(map));
  assert.equal(teach("t1", map).status, "warn");

  // The same confirmation put on a map that says something else (here: "every customer") is not valid.
  const forged: WorkMap = {
    ...map,
    guardrails: map.guardrails.map((g) => (g.trigger === "customer" && !g.unexplained ? { ...g, scope: { kind: "all" as const, customers: [], explicit: true } } : g)),
  };
  assert.ok(validateWorkMap(forged).some((p) => /does not state this version/.test(p)));
  const got = teach("t3", forged);
  assert.equal(got.status, "unknown");
  assert.equal(got.ruleApplied, false);
});

test("full flow: Learn, Review (follow-ups, teach-back, correction, confirmation of the exact version), then Teach T1-T6", async () => {
  // Learn: the expert works and answers at pauses. Nothing is confirmed, so Teach would say "not confirmed yet" on every case.
  const session = startLearnSession();
  await session.run(60_000);
  let state = session.state();
  assert.ok(session.questions.length >= 3);
  assert.equal(latestConfirmed(state), null);
  assertNotConfirmedYet(null, "after Learn");

  // Review: the follow-ups the task did not answer.
  const followUps = planFollowUps(workingMap(state));
  assert.ok(followUps.length >= 3, `${followUps.length} follow-ups`);
  for (const q of followUps) {
    const extraction = await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 70_000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef, knownRefs: scenarioCustomers() });
    state = reduceMap(state, { type: "answer", extraction });
  }
  assert.equal(reviewStatus(state).openFollowUps.length, 0);
  assert.equal(reviewStatus(state).done, false, "no teach-back confirmed yet");

  // The teach-back states the rule; the expert answers unclearly first, then corrects it.
  const first = buildTeachBack(workingMap(state));
  assert.match(first.text, /Scope: only for customer_07\. The email must include the delivery address and delivery window\./);
  const unclear = await applyTeachBackReply(state, { text: "Hmm, yes, but.", atMs: 80_000 }, extractor, undefined, first);
  assert.equal(unclear.outcome, "unclear");
  assertNotConfirmedYet(latestConfirmed(unclear.state), "unclear reply");
  const corrected = await applyTeachBackReply(state, { text: expertTeachback("correction"), atMs: 90_000 }, extractor, undefined, first);
  assert.equal(corrected.outcome, "corrected");
  const second = must(corrected.teachBack);
  assert.match(second.text, /Scope: only for customer_07\. The email must include the order number, delivery address and delivery window\./);
  assertNotConfirmedYet(latestConfirmed(corrected.state), "the corrected version is provisional");

  // The expert confirms exactly the second teach-back; a late confirmation of the first one would have been refused.
  const late = await applyTeachBackReply(corrected.state, { text: expertTeachback("confirm"), atMs: 95_000 }, extractor, undefined, first);
  assert.equal(late.outcome, "stale");
  const confirmed = await applyTeachBackReply(corrected.state, { text: expertTeachback("confirm"), atMs: 100_000 }, extractor, undefined, second);
  assert.equal(confirmed.outcome, "confirmed");
  state = confirmed.state;
  assert.equal(reviewStatus(state).done, true);
  const map = must(latestConfirmed(state));
  assert.equal(map.version, 2);
  assert.equal(map.confirmation?.statedDigest, second.digest);
  assert.deepEqual(validateWorkMap(map), []);

  // Teach: every new case as in fixtures/agent/expected, on the confirmed version only.
  for (const id of IDS) {
    const want = expected(id);
    const got = teach(id, map);
    assert.equal(got.status, want.status, id);
    assert.deepEqual(got.missingFacts, want.missingFacts, id);
    assert.equal(got.mapVersion, want.mapVersion, id);
    assert.equal(got.ruleApplied, want.ruleApplied, id);
    if (want.mustQuoteExpert === true) assert.ok(got.quotes.length > 0, `${id} quotes the expert`);
    if (want.mustCiteEvidence === true) assert.ok(got.evidenceIds.length > 0, `${id} cites a screen moment`);
    assert.equal(new ConversationPolicy({ mode: "teach", now: () => 0 }).decideCheckpoint(got).decision, want.policy, id);
  }
});
