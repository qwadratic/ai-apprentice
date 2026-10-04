// What a live voice demo throws at the brain: answers worded differently, replies like "Sounds good", customers named in
// speech, a screen that jitters with OCR noise, an address typed on two lines, an expert who never attaches an image, and
// who names no fields. All with the heuristic implementations; llm.test.ts covers the model-backed ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FakeClock,
  HeuristicAnswerExtractor,
  HeuristicEntityResolver,
  QuietTracker,
  checkpoint,
  classifyReply,
  factsFingerprint,
  heuristicExtract,
  knownCustomerRefs,
  latestConfirmed,
  mentionedRefs,
  planFollowUps,
  reduceMap,
  reviewStatus,
  spokenNumber,
  valueMentioned,
  stateTeachBack,
  workingMap,
} from "../src/index.ts";
import type { ScreenObservation } from "@apprentice/contracts";
import { Feed, arr, bodyFor, buildState, expertAnswer, expertTeachback, order, readJson, realisticObservations, rec, startLearnSession, str, teachCase, replyAfterTeachBack } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const para = rec(readJson("sim/paraphrases.json"));
const reasonParaphrases = arr(para.reasonParaphrases).map(rec);
const strings = (key: string): string[] => arr(para[key]).map(str);
const extractor = new HeuristicAnswerExtractor();
const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07" };

function t1Status(map: Parameters<typeof checkpoint>[0]["map"]): string {
  const c = teachCase("t1");
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map }).status;
}

test("the reason survives five ways of saying it, with or without 'because'", () => {
  assert.equal(reasonParaphrases.length, 5);
  for (const p of reasonParaphrases) {
    const x = heuristicExtract({ ...input, topic: "reason", text: str(p.text) });
    assert.ok(x.rationale !== null, `no reason found in: ${str(p.text)}`);
    assert.ok(x.rationale.toLowerCase().includes(str(p.mentions)), `${x.rationale}`);
    assert.ok(str(p.text).includes(x.quote), "the quote is the expert's own words");
    assert.equal(x.reasonUnknown, false);
  }
  // "that's why" puts the reason before the cue, not after it.
  assert.equal(heuristicExtract({ ...input, topic: "reason", text: "Customer_07 phone hides pictures in our emails, that's why I handle it myself." }).rationale, "Customer_07 phone hides pictures in our emails");
});

test("a paraphrased reason ends in a warning at the checkpoint, not in unknown", async () => {
  for (const p of reasonParaphrases) {
    const state = await buildState({ correction: true, texts: { reason: str(p.text) } });
    const map = must(latestConfirmed(state));
    const g = must(map.guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
    assert.ok(g.reason !== null && g.status === "confirmed", str(p.text));
    assert.equal(t1Status(map), "warn", str(p.text));
  }
});

test("an answer that gives no reason is asked again in Review; 'I don't know' is not", async () => {
  for (const text of strings("noReasonAnswers")) {
    const state = await buildState({ followUps: false, confirm: false, texts: { reason: text } });
    const g = must(workingMap(state).guardrails.find((x) => x.trigger === "customer"));
    assert.equal(g.reason, null, text);
    const asked = planFollowUps(workingMap(state)).filter((q) => q.topic === "reason");
    if (g.reasonUnknown) {
      assert.equal(asked.length, 0, `${text}: the expert already said they do not know`);
      assert.match(g.unknowns.join(" "), /does not know why/);
    } else {
      assert.equal(asked.length, 1, text);
      assert.equal(must(asked[0]).targetId, g.id);
      assert.ok(must(asked[0]).evidenceIds.length > 0);
    }
  }

  // The follow-up recovers the reason: answered in other words, the rule is confirmed and enforced.
  let state = await buildState({ followUps: false, confirm: false, texts: { reason: "Hm." } });
  assert.equal(workingMap(state).guardrails.find((g) => g.trigger === "customer")?.reason, null);
  const questions = planFollowUps(workingMap(state));
  assert.equal(must(questions[0]).topic, "reason", "the reason comes first");
  assert.ok(questions.length >= 3);
  for (const q of questions) {
    const text = q.topic === "reason" ? str(must(reasonParaphrases[3]).text) : expertAnswer(q.topic);
    state = reduceMap(state, { type: "answer", extraction: await extractor.extract({ topic: q.topic, text, questionId: q.id, atMs: 60000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef }) });
  }
  assert.equal(planFollowUps(workingMap(state)).length, 0);
  const done = await replyAfterTeachBack(state, { text: expertTeachback("correction"), atMs: 90000 }, extractor);
  const confirmed = await replyAfterTeachBack(done.state, { text: "Sounds good.", atMs: 95000 }, extractor);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(t1Status(latestConfirmed(confirmed.state)), "warn");
});

test("confirmations in any natural wording are confirmations; additions, negations and mumbling are not", async () => {
  for (const reply of strings("confirmations")) assert.equal(classifyReply(reply), "confirm", reply);
  for (const reply of ["Yes, that's right.", "Yes.", "Correct.", "Yep, you got it right.", "Perfect, thank you."]) {
    assert.equal(classifyReply(reply), "confirm", reply);
  }
  assert.equal(classifyReply("Also add the phone number."), "correct");
  assert.equal(classifyReply("Yes, but one thing is off."), "unclear", "a contrast: left to the model or the buttons");
  for (const reply of strings("corrections")) assert.equal(classifyReply(reply), "correct", reply);
  for (const reply of ["That's not right.", "Not quite.", "No."]) assert.equal(classifyReply(reply), "unclear", `${reply}: a denial with nothing said`);
  for (const reply of strings("unclear")) assert.equal(classifyReply(reply), "unclear", reply);

  // Through the review: a spoken confirmation confirms, a mumble changes nothing.
  const state = stateTeachBack(await buildState({ confirm: false })).state;
  const unclear = await replyAfterTeachBack(state, { text: "Hmm.", atMs: 1 }, extractor);
  assert.equal(unclear.outcome, "unclear");
  assert.equal(unclear.state, state);
  for (const reply of strings("confirmations")) {
    assert.equal((await replyAfterTeachBack(state, { text: reply, atMs: 2 }, extractor)).outcome, "confirmed", reply);
  }
});

test("customers named in speech map onto the refs seen on screen, and are never invented", () => {
  const known = ["customer_03", "customer_07", "customer_09"];
  for (const spoken of strings("spokenCustomers")) assert.deepEqual(mentionedRefs(`Only ${spoken} gets it.`, { knownRefs: known }), ["customer_07"], spoken);
  assert.deepEqual(mentionedRefs("Customer nine asks for the same.", { knownRefs: known }), ["customer_09"]);
  assert.deepEqual(mentionedRefs("customer twenty one", { knownRefs: ["customer_21"] }), ["customer_21"]);
  assert.deepEqual(mentionedRefs("customer seven", { knownRefs: ["customer_03"] }), [], "not a known customer: never invented");
  assert.deepEqual(mentionedRefs("customer seven"), [], "no known customers: nothing to resolve to");
  assert.deepEqual(mentionedRefs("customer_55 is new", { knownRefs: known }), ["customer_55"], "a ref written out stands as written");
  assert.deepEqual(mentionedRefs("customer service is slow", { knownRefs: known }), []);
  assert.equal(spokenNumber(["zero", "seven"]), 7);
  assert.equal(spokenNumber(["twelve"]), 12);
  assert.equal(spokenNumber(["07", "and"]), 7);
  assert.equal(spokenNumber(["service"]), null);

  const scope = heuristicExtract({ ...input, topic: "scope", text: str(para.spokenScope), knownRefs: known });
  assert.deepEqual(scope.scope.customers, ["customer_07"]);
  assert.deepEqual(scope.unexplainedCustomers.map((u) => u.customerRef), ["customer_09"]);
  assert.equal(scope.scope.explicit, true);
});

test("a spoken scope answer builds the same map as the typed one", async () => {
  const state = await buildState({ texts: { scope: str(para.spokenScope) }, correction: true });
  const map = must(latestConfirmed(state));
  assert.deepEqual(map.guardrails.find((g) => g.unexplained)?.scope.customers, ["customer_09"]);
  const c = teachCase("t6");
  assert.equal(checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map }).status, "unknown");
  assert.deepEqual(knownCustomerRefs(state).slice(0, 1), ["customer_07"]);
  assert.equal(await new HeuristicEntityResolver().resolve("customer seven", ["customer_07"]), "customer_07");
  assert.equal(await new HeuristicEntityResolver().resolve("customer Sample", ["customer_07"]), null);
});

test("fields the expert names in other words are still found", () => {
  assert.deepEqual(heuristicExtract({ ...input, topic: "essentials", text: str(para.essentialsInOtherWords) }).requiredFacts, ["deliveryAddress", "deliveryWindow"]);
});

test("when the expert names no fields, what the screen showed typed stays the rule through the next order", async () => {
  const feed = new Feed("sess-two");
  const first = order("ORD-2041");
  const second = order("ORD-2057");
  const c = first.customerRef;
  const events: ScreenObservation[] = [
    feed.order(0, first),
    feed.email(100, c),
    feed.email(9000, c, { bodyText: bodyFor(first) }),
    feed.email(15000, c, { bodyText: bodyFor(first), previewState: "preview" }),
  ];
  let state = (await buildState({ answers: [], followUps: false, confirm: false }));
  state = events.reduce((s, observation) => reduceMap(s, { type: "observation", observation }), state);
  const evidence = must(events[2]).evidenceIds;
  const answers: Array<[Parameters<typeof extractor.extract>[0]["topic"], string]> = [
    ["reason", str(must(reasonParaphrases[0]).text)],
    ["essentials", str(para.essentialsWithoutFields)],
    ["guardrail", expertAnswer("guardrail")],
  ];
  for (const [topic, text] of answers) {
    state = reduceMap(state, { type: "answer", extraction: await extractor.extract({ ...input, topic, text, evidenceIds: [...evidence], knownRefs: knownCustomerRefs(state) }) });
  }
  const g = () => must(workingMap(state).guardrails.find((x) => x.trigger === "customer"));
  assert.deepEqual(g().requiredFacts, ["deliveryAddress", "deliveryWindow"], "inferred from what the expert typed");

  // The next order opens, nothing typed yet: the rule must not change or vanish.
  state = reduceMap(state, { type: "observation", observation: feed.order(30000, second) });
  state = reduceMap(state, { type: "observation", observation: feed.email(30100, c) });
  assert.deepEqual(g().requiredFacts, ["deliveryAddress", "deliveryWindow"]);

  // A later order where the expert also types the order number does not widen the rule silently.
  state = reduceMap(state, { type: "observation", observation: feed.email(36000, c, { bodyText: bodyFor(second, true) }) });
  assert.deepEqual(g().requiredFacts, ["deliveryAddress", "deliveryWindow"]);

  // Confirmed, the rule is enforced: T1 warns for the fields typed, it does not give up with unknown.
  for (const q of planFollowUps(workingMap(state))) {
    state = reduceMap(state, { type: "answer", extraction: await extractor.extract({ ...input, topic: q.topic, text: expertAnswer(q.topic), targetId: q.targetId, evidenceIds: q.evidenceIds }) });
  }
  const confirmed = await replyAfterTeachBack(state, { text: "Sounds good.", atMs: 99000 }, extractor);
  assert.equal(confirmed.outcome, "confirmed");
  const map = must(latestConfirmed(confirmed.state));
  assert.deepEqual(must(map.guardrails.find((x) => x.trigger === "customer" && !x.unexplained)).requiredFacts, ["deliveryAddress", "deliveryWindow"]);
  assert.equal(t1Status(map), "warn");
  assert.deepEqual(reviewStatus(confirmed.state).openFollowUps, []);
});

test("what the expert names as essential wins over what the screen showed", async () => {
  const state = await buildState({ correction: false });
  const g = must(must(latestConfirmed(state)).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
  assert.deepEqual(g.requiredFacts, ["deliveryAddress", "deliveryWindow"]);
});

test("OCR noise is not a change on screen: whitespace, case, punctuation and attachment text are ignored", () => {
  const feed = new Feed("sess-noise");
  const o = order("ORD-2041");
  const c = o.customerRef;
  const q = new QuietTracker();
  const th = { inputPauseMs: 3000, screenStableMs: 2000, humanQuietMs: 1200 };
  q.observe(feed.email(1000, c, { bodyText: "Delivery: 14 Sample Lane" }));
  // The same text read differently every frame.
  q.observe(feed.email(1500, c, { bodyText: "delivery:  14 sample lane " }));
  q.observe(feed.email(2000, c, { bodyText: "Delivery 14 Sample Lane." }));
  q.observe(feed.email(2500, c, { bodyText: "Delivery:\n14 Sample Lane", attachments: [] }));
  assert.equal(q.snapshot(3100, th).screenStableMs, 2100, "the screen has been still since 1.0 s");
  // A real change moves it.
  q.observe(feed.email(3200, c, { bodyText: "Delivery: 14 Sample Lane, 1010 Exampletown" }));
  assert.equal(q.snapshot(3300, th).screenStableMs, 100);
  assert.equal(factsFingerprint({ a: "X  y", ocrText: "n0ise" }), factsFingerprint({ a: "x y", ocrText: "noise!" }));
});

test("a screen that jitters with OCR noise still gets its questions in a minute and a half", async () => {
  const feed = new Feed("sess-jitter", 200);
  const base = realisticObservations("sess-real-jitter");
  const o = order("ORD-2041");
  const c = o.customerRef;
  const noise: ScreenObservation[] = [];
  const body = bodyFor(o);
  // Every half second, the same screen read with different whitespace and case.
  for (let t = 15500; t < 80000; t += 500) {
    const state = t < 30000 ? "editing" : t < 42000 ? "preview" : "sent";
    const jitter = (t / 500) % 2 === 0 ? body : body.toUpperCase().replace(/\n/g, "\n ");
    noise.push(feed.email(t, c, { bodyText: jitter, previewState: state }));
  }
  const timeline = [...base.filter((x) => x.timestampMs < 15000 || x.kind !== "email_draft"), ...noise];
  const session = startLearnSession({ timeline, typing: [[5000, 14500]] });
  await session.run(90_000);
  assert.ok(session.questions.length >= 3, `${session.questions.length} questions with a noisy screen`);
});

test("an address typed on two lines still counts as the order's details", async () => {
  assert.equal(valueMentioned("Address: 14 Sample Lane,\n1010 Exampletown", "14 Sample Lane, 1010 Exampletown"), true);
  assert.equal(valueMentioned("see 14 sample lane", "14 Sample Lane, 1010 Exampletown"), true, "the street part alone is enough");
  assert.equal(valueMentioned("see 14 elm road", "14 Sample Lane, 1010 Exampletown"), false);
  const session = startLearnSession({ timeline: realisticObservations("sess-two-lines"), typing: [[5000, 14500]] });
  await session.run(80_000);
  assert.ok(session.questions.some((q) => q.question.topic === "essentials"), "the essentials question was asked for the two-line address");
});

test("a realistic run, typing the text and never attaching an image, yields at least three questions, one about a guardrail", async () => {
  const session = startLearnSession({ timeline: realisticObservations(), typing: [[5000, 14500]] });
  await session.run(80_000);
  const topics = session.questions.map((q) => q.question.topic);
  assert.ok(session.questions.length >= 3, `${topics.join(", ")}`);
  assert.deepEqual(topics.slice(0, 3), ["reason", "essentials", "guardrail"]);
  for (const d of session.decisions().filter((x) => x.decision === "ASK_NOW")) {
    assert.equal(d.quiet.natural, true);
    assert.ok(d.evidenceIds.length > 0);
  }
  for (const { askedAtMs } of session.questions) assert.ok(askedAtMs < 5000 || askedAtMs >= 17000, `asked at ${askedAtMs}, while typing`);
  const map = workingMap(session.state());
  assert.ok(map.guardrails.some((g) => g.trigger === "customer" && g.reason !== null), "the reason was learned");
  assert.ok(map.guardrails.some((g) => g.trigger === "unknown_entity"), "the stop-and-ask guardrail was learned");
  assert.ok(map.steps.filter((s) => s.kind === "judgment" && s.decision?.quote).length >= 2);
});

test("a realistic run with a paraphrased reason still ends in the tutor warning T1", async () => {
  const session = startLearnSession({
    timeline: realisticObservations(),
    typing: [[5000, 14500]],
    answerText: (topic) => (topic === "reason" ? str(must(reasonParaphrases[3]).text) : expertAnswer(topic)),
  });
  await session.run(80_000);
  let state = session.state();
  for (const q of planFollowUps(workingMap(state))) {
    state = reduceMap(state, { type: "answer", extraction: await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 90000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef }) });
  }
  const done = await replyAfterTeachBack(state, { text: "Okay, that's correct.", atMs: 99000 }, extractor);
  assert.equal(done.outcome, "confirmed");
  assert.equal(t1Status(latestConfirmed(done.state)), "warn");
});

test("time is injected: the clock used by a session is the fake one", () => {
  const clock = new FakeClock(1000);
  assert.equal(clock.now(), 1000);
});
