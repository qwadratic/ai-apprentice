// The confirmation gate (structural): Teach applies only a rule version the expert confirmed in a teach-back that states that exact
// version. Every extracted or corrected version, heuristic or model, is provisional until then. The state records the teach-back
// last stated to the expert (lastStatedDigest); a confirmation, by reply or by button, is matched against that record and nothing
// else, and any change to what the map says (a correction, a late answer) clears it. So whatever a misread utterance does to the
// map, it cannot reach the new hire: the worst a bad parse can do is put a wrong statement into a teach-back the expert hears,
// and corrects.
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
  confirmationOf,
  createMapState,
  emailText,
  heuristicExtract,
  latestConfirmed,
  planFollowUps,
  pressReviewButton,
  reduceMap,
  reviewStatus,
  stateTeachBack,
  teachBackDigest,
  validateWorkMap,
  workingMap,
} from "../src/index.ts";
import type { AnswerExtraction, MapState, ReplyClassifier, ReplyVerdict, TutorVerdict, WorkMap } from "../src/index.ts";
import {
  buildState,
  customTeachCase,
  expected,
  expertAnswer,
  expertTeachback,
  order,
  replyAfterTeachBack,
  scenarioCustomers,
  startLearnSession,
  teachCase,
} from "./brain-helpers.ts";
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

/** A late answer to a follow-up, after the teach-back was stated: it changes what the map says. */
async function lateAnswer(state: MapState, text: string): Promise<MapState> {
  const extraction = await extractor.extract({ ...input, topic: "scope", text, knownRefs: scenarioCustomers() });
  return reduceMap(state, { type: "answer", extraction });
}

// ---------------------------------------------------------------------------

test("before the expert confirms, Teach says 'not confirmed by the expert yet' on every case: never warn, never clear", async () => {
  const state = await buildState({ correction: true, confirm: false });
  assert.equal(latestConfirmed(state), null);
  assertNotConfirmedYet(null, "no confirmed map");
  // Even handed the provisional working version directly, the tutor does not apply it.
  assertNotConfirmedYet(workingMap(state), "provisional working map");
});

test("a confirmation needs a stated teach-back: with none, or after it changed, a 'yes' is stale and the new teach-back is returned", async () => {
  const fresh = await buildState({ confirm: false });
  assert.equal(fresh.lastStatedDigest, null);

  // Nothing was stated yet: a reply or a button press confirms nothing, and no `heard` is needed to know it.
  const early = await applyTeachBackReply(fresh, { text: "Yes.", atMs: 1 }, extractor);
  assert.equal(early.outcome, "stale");
  assert.equal(latestConfirmed(early.state), null);
  assert.equal(early.teachBack?.digest, buildTeachBack(workingMap(fresh)).digest, "the current teach-back, to state");
  assert.equal(pressReviewButton(fresh, new ReviewClarifier(), "teachback:1", "confirm", 1).outcome, "stale");
  assert.throws(() => reduceMap(fresh, confirmationOf(fresh, 1, "Yes.")), MapValidationError);
  // A digest of the current version made up by the caller is not a statement either.
  assert.throws(() => reduceMap(fresh, { type: "confirm", atMs: 1, quote: "Yes.", stated: teachBackDigest(workingMap(fresh)) }), MapValidationError);

  // Stating records it, and then "yes" confirms exactly that.
  const spoken = stateTeachBack(fresh);
  assert.equal(spoken.state.lastStatedDigest, spoken.teachBack.digest);
  assert.equal(stateTeachBack(spoken.state).state, spoken.state, "stating the same teach-back again changes nothing");
  const done = await applyTeachBackReply(spoken.state, { text: "Yes.", atMs: 2 }, extractor);
  assert.equal(done.outcome, "confirmed");
  assert.equal(must(latestConfirmed(done.state)).confirmation?.statedDigest, spoken.teachBack.digest);

  // A teach-back of an older version states nothing once the map moved on.
  const moved = await lateAnswer(spoken.state, "Customer twelve as well.");
  assert.notEqual(buildTeachBack(workingMap(moved)).digest, spoken.teachBack.digest);
  assert.equal(reduceMap(moved, { type: "teachback_stated", digest: spoken.teachBack.digest }), moved);
});

test("v1 stated, then 'One correction: the order number goes in as well.', then 'Yes.' with no `heard`: v2 is not confirmed", async () => {
  const stated = stateTeachBack(await buildState({ confirm: false }));
  const v1 = stated.teachBack;

  const corrected = await applyTeachBackReply(stated.state, { text: "One correction: the order number goes in as well.", atMs: 2 }, extractor);
  assert.equal(corrected.outcome, "corrected");
  const v2 = must(corrected.teachBack);
  assert.equal(v2.version, 2);
  assert.match(v2.text, /order number, delivery address and delivery window/);
  assert.equal(corrected.state.lastStatedDigest, null, "the new version has not been stated yet");

  // By reply: stale, with the new teach-back to state. Nothing is confirmed.
  const yes = await applyTeachBackReply(corrected.state, { text: "Yes.", atMs: 3 }, extractor);
  assert.equal(yes.outcome, "stale");
  assert.equal(yes.teachBack?.digest, v2.digest);
  assert.equal(latestConfirmed(yes.state), null);
  // By button: the same.
  const button = pressReviewButton(corrected.state, new ReviewClarifier(), `teachback:${v2.version}`, "confirm", 3);
  assert.equal(button.outcome, "stale");
  assert.equal(latestConfirmed(button.state), null);
  assert.equal(teach("t5", latestConfirmed(button.state)).status, "unknown");

  // `heard` is redundant, never a way around the record: a stale `heard` is stale, and so is a `heard` that is not what was stated.
  const respoken = stateTeachBack(corrected.state);
  assert.equal((await applyTeachBackReply(respoken.state, { text: "Yes.", atMs: 4 }, extractor, undefined, v1)).outcome, "stale");
  assert.equal(pressReviewButton(respoken.state, new ReviewClarifier(), "teachback:2", "confirm", 4, v1).outcome, "stale");
  assert.equal(latestConfirmed(respoken.state), null);

  // Once v2 is stated, "yes" confirms v2 (and `heard`, if given, agrees).
  const done = await applyTeachBackReply(respoken.state, { text: "Sounds good.", atMs: 5 }, extractor, undefined, respoken.teachBack);
  assert.equal(done.outcome, "confirmed");
  const map2 = must(latestConfirmed(done.state));
  assert.equal(map2.version, 2);
  assert.equal(map2.confirmation?.statedDigest, v2.digest);
  assert.deepEqual(teach("t5", map2).missingFacts, ["orderId"]);
});

test("a late 'Customer twelve as well.' after the teach-back un-states it: a 'yes' then is stale, by reply and by button", async () => {
  const stated = stateTeachBack(await buildState({ confirm: false }));

  // As a reply to the teach-back (a correction), and as a late answer to a follow-up: both make a new version.
  const asReply = await applyTeachBackReply(stated.state, { text: "Customer twelve as well.", atMs: 2 }, extractor);
  assert.equal(asReply.outcome, "corrected");
  const asAnswer = await lateAnswer(stated.state, "Customer twelve as well.");
  for (const [name, state] of [["reply", asReply.state], ["late answer", asAnswer]] as const) {
    assert.equal(state.lastStatedDigest, null, name);
    assert.deepEqual(personalRule(workingMap(state)).scope.customers, ["customer_07", "customer_12"], name);
    const yes = await applyTeachBackReply(state, { text: "Yes.", atMs: 3 }, extractor);
    assert.equal(yes.outcome, "stale", name);
    assert.match(must(yes.teachBack).text, /Scope: only for customer_07 and customer_12\./, name);
    assert.equal(pressReviewButton(state, new ReviewClarifier(), "teachback:1", "confirm", 3).outcome, "stale", name);
    assert.equal(latestConfirmed(state), null, name);
    assertNotConfirmedYet(latestConfirmed(state), name);
  }
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
  const before = stateTeachBack(await buildState({ confirm: false }));
  assert.match(before.teachBack.text, /Scope: only for customer_07\./);
  const misparsed: AnswerExtraction = {
    ...heuristicExtract({ ...input, topic: "scope", text: "Every customer gets the picture." }),
    scope: { customers: [], all: true, explicit: true },
    scopeQuote: "Every customer gets the picture.",
  };
  const state = reduceMap(before.state, { type: "answer", extraction: misparsed });
  assert.equal(personalRule(workingMap(state)).scope.kind, "all", "the misparse is in the working map");
  assert.equal(state.lastStatedDigest, null, "and the teach-back the expert heard no longer says what the map says");

  // 3. It is provisional: T3 does not warn, nor does any case apply it.
  assert.equal(latestConfirmed(state), null);
  assert.equal(teach("t3", latestConfirmed(state)).status, "unknown");
  assertNotConfirmedYet(workingMap(state), "provisional misparse");

  // 4. The expert's "yes" to the teach-back they heard does not confirm it, by reply, button or direct event.
  const stale = await applyTeachBackReply(state, { text: "Yes.", atMs: 5 }, extractor);
  assert.equal(stale.outcome, "stale");
  assert.equal(latestConfirmed(stale.state), null);
  assert.match(must(stale.teachBack).text, /Scope: for every customer\./, "the expert is told what the map now says");
  assert.equal(pressReviewButton(state, new ReviewClarifier(), "teachback:1", "confirm", 5).outcome, "stale");
  assert.throws(() => reduceMap(state, { type: "confirm", atMs: 5, quote: "Yes.", stated: before.teachBack.digest }), MapValidationError);
  assert.equal(teach("t3", latestConfirmed(stale.state)).status, "unknown");

  // 5. Stated, it is still no confirmation unless the reply is only confirmation tokens, whoever classified it.
  const tb = stateTeachBack(state);
  assert.match(tb.teachBack.text, /Scope: for every customer\./);
  assert.notEqual(tb.teachBack.digest, before.teachBack.digest);
  for (const text of ["Yes, but not for everyone.", "Yes, customer twelve too.", "Right, only for customer seven.", "Yes?", "I guess so."]) {
    const out = await applyTeachBackReply(tb.state, { text, atMs: 6 }, extractor, alwaysConfirm);
    assert.notEqual(out.outcome, "confirmed", text);
    assert.equal(latestConfirmed(out.state), null, text);
  }
  assert.equal(teach("t3", latestConfirmed(tb.state)).status, "unknown");

  // 6. Only the expert's confirmation of the teach-back that states "every customer" makes it apply.
  const done = await applyTeachBackReply(tb.state, { text: "Yes, that's right.", atMs: 7 }, extractor);
  assert.equal(done.outcome, "confirmed");
  const map = must(latestConfirmed(done.state));
  assert.equal(map.confirmation?.statedDigest, tb.teachBack.digest);
  assert.equal(teach("t3", map).status, "warn");
  assert.equal(teach("t3", map).ruleApplied, true);
});

test("a correction is a new provisional version with a new teach-back; Teach keeps the last confirmed version until it is confirmed", async () => {
  const first = await replyAfterTeachBack(await buildState({ confirm: false }), { text: "Yes.", atMs: 1 }, extractor);
  assert.equal(first.outcome, "confirmed");
  const map1 = must(latestConfirmed(first.state));
  assert.equal(map1.version, 1);
  assert.equal(teach("t5", map1).status, "clear", "the order number is not part of version 1");

  // The expert corrects: the order number goes in as well. The confirmed teach-back v1 was the last one stated.
  const corrected = await applyTeachBackReply(first.state, { text: expertTeachback("correction"), atMs: 2 }, extractor);
  assert.equal(corrected.outcome, "corrected");
  const v2 = must(corrected.teachBack);
  assert.equal(v2.version, 2);
  assert.match(v2.text, /order number, delivery address and delivery window/);
  assert.notEqual(v2.digest, map1.confirmation?.statedDigest);
  // The new version is provisional: Teach still applies version 1, and the working map is not applied at all.
  assert.equal(must(latestConfirmed(corrected.state)).version, 1);
  assert.equal(teach("t5", latestConfirmed(corrected.state)).status, "clear");
  assert.equal(teach("t5", latestConfirmed(corrected.state)).mapVersion, 1);
  assertNotConfirmedYet(workingMap(corrected.state), "version 2 before confirmation");

  // A "yes" before v2 is stated is stale; so is one that carries an older teach-back.
  assert.equal((await applyTeachBackReply(corrected.state, { text: "Yes.", atMs: 3 }, extractor)).outcome, "stale");
  assert.equal(must(latestConfirmed(corrected.state)).version, 1);

  // v2 stated and confirmed makes it the one Teach applies.
  const done = await replyAfterTeachBack(corrected.state, { text: "Sounds good.", atMs: 4 }, extractor);
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
  const stated = stateTeachBack(await buildState({ confirm: false }));
  const tb = stated.teachBack;
  for (const text of ["Yes, but for every customer.", "Yes, and customer twelve too.", "Right, but put the order number in as well.", "Yes, if he asks.", "Sure, why not?"]) {
    const out = await applyTeachBackReply(stated.state, { text, atMs: 1 }, extractor, alwaysConfirm);
    assert.notEqual(out.outcome, "confirmed", text);
    assert.equal(latestConfirmed(out.state), null, text);
  }
  assertNotConfirmedYet(latestConfirmed(stated.state), "nothing confirmed");

  // Unclear replies: ask again once, then the buttons; the item stays unresolved and Teach still says "not confirmed".
  const clarifier = new ReviewClarifier();
  let latest = stated.state;
  const id = `teachback:${tb.version}`;
  let steps = 0;
  for (const text of ["Hmm.", "Uh...", "I'm not sure.", "What?"]) {
    const out = await applyTeachBackReply(latest, { text, atMs: 2 }, extractor);
    assert.equal(out.outcome, "unclear", text);
    assert.equal(out.state, latest, "an unclear reply changes nothing, the stated teach-back stays the one to confirm");
    latest = out.state;
    if (steps < MAX_UNCLEAR) clarifier.unclear(id);
    steps++;
  }
  assert.ok(clarifier.isUnresolved(id));
  assert.equal(latestConfirmed(latest), null);
  assertNotConfirmedYet(latestConfirmed(latest), "unclear replies");

  // The Confirm button confirms the teach-back the expert was told, and only that.
  const pressed = pressReviewButton(latest, clarifier, id, "confirm", 9, tb);
  assert.equal(pressed.outcome, "confirmed");
  const map = must(latestConfirmed(pressed.state));
  assert.equal(map.confirmation?.statedDigest, tb.digest);
  assert.equal(teach("t1", map).status, "warn");
});

test("the teach-back states the scope, the fields (and whether they are assumed from the screen), the exception and the reason", async () => {
  const full = buildTeachBack(workingMap(await buildState({ confirm: false })));
  assert.match(full.text, /Scope: only for customer_07\. The email must include the delivery address and delivery window\. Exception: .* Reason: his phone blocks pictures in our emails\./);
  assert.doesNotMatch(full.text, /from the screen/, "the expert named the fields, nothing is assumed");

  // The scope and the exception were not stated: the teach-back says so. The fields come from what the expert typed on screen,
  // and the teach-back says that it assumes them, the way it does for the scope.
  const thinState = await buildState({ answers: ["reason", "guardrail"], followUps: false, confirm: false });
  const thin = buildTeachBack(workingMap(thinState));
  assert.match(thin.text, /Scope: only for customer_07 \(you did not say; I assume it from the screen\)\. The email must include the delivery address and delivery window \(I assume it from the screen\)\. No exception stated\. Reason: his phone blocks pictures in our emails\./);
  assert.notEqual(thin.digest, full.digest);

  // A correction names one field itself; the other two are still assumed, and the teach-back says which.
  const mixed = await replyAfterTeachBack(thinState, { text: "Please include the order number in the email.", atMs: 1 }, extractor);
  assert.equal(mixed.outcome, "corrected");
  assert.match(must(mixed.teachBack).text, /The email must include the order number, delivery address and delivery window \(I assume the delivery address and delivery window from the screen\)\./);

  // Nothing seen on screen and no essentials answer: it says it does not know what the email must include.
  const reason = heuristicExtract({ ...input, topic: "reason", text: expertAnswer("reason") });
  const bare = buildTeachBack(workingMap(reduceMap(createMapState(scenarioCustomers()), { type: "answer", extraction: reason })));
  assert.match(bare.text, /I do not know yet what the email must include\. No exception stated\./);

  // No reason: "Reason unknown."
  const unexplained = buildTeachBack(workingMap(await buildState({ answers: ["essentials", "guardrail"], followUps: false, confirm: false })));
  assert.match(unexplained.text, /Scope: only for customer_07 .*Reason unknown\./);

  // "Every customer" is stated as such, in a different sentence from "only for".
  const wide = await replyAfterTeachBack(await buildState({ confirm: false }), { text: "It is for every customer.", atMs: 1 }, extractor);
  assert.equal(wide.outcome, "corrected");
  assert.match(must(wide.teachBack).text, /Scope: for every customer\./);
  assert.doesNotMatch(must(wide.teachBack).text, /only for customer_07/);
});

test("the email is its subject and its body, for the teach-back and for the tutor: T5 with the order number in the subject is clear", async () => {
  assert.equal(emailText({ subject: "Subject", bodyText: "Body" }), "Subject\nBody");
  const map = must(latestConfirmed(await buildState({ correction: true })));
  assert.match(buildTeachBack(map).text, /The email must include the order number, delivery address and delivery window/);

  // Version 2 requires the order number in the email. The body has the address and the window, the subject has the number.
  const t5 = teachCase("t5");
  const body = (t5.email.kind === "email_draft" ? t5.email.facts.bodyText : "");
  const withSubject = customTeachCase("t5s", order("ORD-2071"), body, true, "Delivery details for order ORD-2071");
  const got = checkpoint({ checkpoint: withSubject.checkpoint, observations: withSubject.observations, map });
  assert.equal(got.status, "clear");
  assert.deepEqual(got.missingFacts, []);
  assert.match(got.message, /in your email/);

  // The same draft with the number nowhere (the fixture's subject has none) still warns, as before.
  const without = checkpoint({ checkpoint: t5.checkpoint, observations: t5.observations, map });
  assert.equal(without.status, "warn");
  assert.deepEqual(without.missingFacts, ["orderId"]);
  assert.match(without.message, /Your email is still missing the order number/);

  // A subject that names a different order does not count.
  const other = customTeachCase("t5x", order("ORD-2071"), body, true, "Delivery details for order ORD-9999");
  assert.deepEqual(checkpoint({ checkpoint: other.checkpoint, observations: other.observations, map }).missingFacts, ["orderId"]);
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

  // The first teach-back is stated; the expert replies with a "yes" before it was (it is not): stale, nothing confirmed.
  assert.equal((await applyTeachBackReply(state, { text: "Yes.", atMs: 71_000 }, extractor)).outcome, "stale");
  const first = stateTeachBack(state);
  assert.match(first.teachBack.text, /Scope: only for customer_07\. The email must include the delivery address and delivery window\./);
  const unclear = await applyTeachBackReply(first.state, { text: "Hmm, yes, but.", atMs: 80_000 }, extractor);
  assert.equal(unclear.outcome, "unclear");
  assertNotConfirmedYet(latestConfirmed(unclear.state), "unclear reply");
  const corrected = await applyTeachBackReply(first.state, { text: expertTeachback("correction"), atMs: 90_000 }, extractor);
  assert.equal(corrected.outcome, "corrected");
  const second = must(corrected.teachBack);
  assert.match(second.text, /Scope: only for customer_07\. The email must include the order number, delivery address and delivery window\./);
  assertNotConfirmedYet(latestConfirmed(corrected.state), "the corrected version is provisional");

  // The expert's "yes" before the second teach-back was spoken is stale; after it was, it confirms exactly that version.
  const late = await applyTeachBackReply(corrected.state, { text: expertTeachback("confirm"), atMs: 95_000 }, extractor);
  assert.equal(late.outcome, "stale");
  const confirmed = await replyAfterTeachBack(corrected.state, { text: expertTeachback("confirm"), atMs: 100_000 }, extractor, undefined, second);
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
