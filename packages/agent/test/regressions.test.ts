// Regression tests for the findings of the second review of the brain, with the exact phrases that broke it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrderFacts, ScreenObservation } from "@apprentice/contracts";
import {
  HeuristicAnswerExtractor,
  checkpoint,
  extractFacts,
  heuristicExtract,
  knownCustomerRefs,
  latestConfirmed,
  mentionedRefs,
  planFollowUps,
  readReply,
  reduceMap,
  workingMap,
} from "../src/index.ts";
import { Feed, IMAGE, bodyFor, buildState, customTeachCase, expertAnswer, expertTeachback, order, scenarioCustomers, startLearnSession, teachCase, replyAfterTeachBack } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();
const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07", knownRefs: scenarioCustomers() };

function verdict(id: string, map: Parameters<typeof checkpoint>[0]["map"]) {
  const c = teachCase(id);
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
}

// ---------------------------------------------------------------------------
// 1. Non-answers are not reasons

test("'I'm not really sure, honestly.' and 'I don't remember anymore.' are not reasons: the reason stays unknown", async () => {
  for (const text of ["I'm not really sure, honestly.", "I don't remember anymore."]) {
    for (const topic of ["reason", "why_stop"] as const) {
      const x = heuristicExtract({ ...input, topic, text });
      assert.equal(x.rationale, null, `${topic}: ${text}`);
      assert.equal(x.reasonUnknown, true, `${topic}: ${text}`);
      assert.match(x.unknowns.join(" "), /does not know why/);
    }
    // In the map: the rule is not confirmed, the tutor says it does not know, and Review does not ask again.
    const state = await buildState({ correction: true, followUps: false, texts: { reason: text } });
    const g = must(workingMap(state).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
    assert.equal(g.reason, null);
    assert.equal(g.reasonUnknown, true);
    assert.notEqual(g.status, "confirmed");
    const t1 = verdict("t1", latestConfirmed(state));
    assert.equal(t1.status, "unknown", text);
    assert.match(t1.message, /do not know why/);
    assert.deepEqual(planFollowUps(workingMap(state)).filter((q) => q.topic === "reason"), []);
  }
});

test("a hedge anywhere in the answer vetoes the reason: the model or the buttons take over", () => {
  for (const text of ["I'm not sure. I think his phone blocks pictures.", "I don't know exactly, but because his phone blocks pictures, I think."]) {
    const x = heuristicExtract({ ...input, topic: "reason", text });
    assert.equal(x.rationale, null, text);
  }
});

// ---------------------------------------------------------------------------
// 2. Replies that confirm, and replies that add something

test("'No, that's right.' confirms", async () => {
  assert.equal(readReply("No, that's right.").verdict, "confirm");
  assert.equal(readReply("No, that is correct.").verdict, "confirm");
  assert.equal(readReply("No, that's not right.").verdict, "unclear", "a denial with nothing said: ask what to change");
  assert.equal(readReply("No, the order number goes in too.").verdict, "unclear", "a negation: left to the model or the buttons");
  const state = await buildState({ confirm: false });
  assert.equal((await replyAfterTeachBack(state, { text: "No, that's right.", atMs: 9 }, extractor)).outcome, "confirmed");
});

test("'Correct, he wants the order number in there as well.' is a correction that carries the addition", async () => {
  const reply = "Correct, he wants the order number in there as well.";
  const read = readReply(reply);
  assert.equal(read.verdict, "correct");
  assert.match(read.correction ?? "", /order number/);
  assert.ok(reply.includes(must(read.correction)));

  // Only the address and the window were named, so the rule starts without the order number.
  const state = await buildState({ confirm: false });
  assert.deepEqual(must(workingMap(state).guardrails[0]).requiredFacts, ["deliveryAddress", "deliveryWindow"]);
  const out = await replyAfterTeachBack(state, { text: reply, atMs: 9 }, extractor);
  assert.equal(out.outcome, "corrected");
  assert.deepEqual(must(workingMap(out.state).guardrails[0]).requiredFacts, ["orderId", "deliveryAddress", "deliveryWindow"]);
  assert.match(out.teachBack?.text ?? "", /order number, delivery address and delivery window/);
  const done = await replyAfterTeachBack(out.state, { text: "Sounds good.", atMs: 10 }, extractor);
  assert.equal(done.outcome, "confirmed");
  assert.deepEqual(verdict("t5", latestConfirmed(done.state)).missingFacts, ["orderId"]);
});

test("'Yes. Customer twelve too.' is a correction that brings customer_12 into the rule", async () => {
  const reply = "Yes. Customer twelve too.";
  const read = readReply(reply);
  assert.equal(read.verdict, "correct");
  assert.equal(read.correction, "Customer twelve too.");

  const state = await buildState({ correction: true });
  const twelve = order("ORD-2041");
  const draft: OrderFacts = { ...twelve, customerRef: "customer_12" };
  const case12 = customTeachCase("c12", draft, "", true);
  const before = checkpoint({ checkpoint: case12.checkpoint, observations: case12.observations, map: latestConfirmed(state) });
  assert.equal(before.status, "clear", "the rule is limited to customer_07 until the expert says otherwise");

  const out = await replyAfterTeachBack(state, { text: reply, atMs: 99 }, extractor);
  assert.equal(out.outcome, "corrected");
  const g = must(workingMap(out.state).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
  assert.deepEqual(g.scope.customers, ["customer_07", "customer_12"]);
  assert.equal(g.scope.explicit, true);
  assert.match(out.teachBack?.text ?? "", /Scope: only for customer_07 and customer_12\./);
  const done = await replyAfterTeachBack(out.state, { text: "Yes, that's right.", atMs: 100 }, extractor);
  const after = checkpoint({ checkpoint: case12.checkpoint, observations: case12.observations, map: latestConfirmed(done.state) });
  assert.equal(after.status, "warn");
  // Other customers are still not covered.
  assert.equal(verdict("t3", latestConfirmed(done.state)).status, "clear");
});

// ---------------------------------------------------------------------------
// 3. Only a customer put into the rule's scope joins it, and refs are never minted

test("'Customer three is the usual case.' does not put customer_03 into the rule", async () => {
  const known = scenarioCustomers();
  for (const text of ["Customer three is the usual case.", "Only for him. Customer three is the usual case."]) {
    const x = heuristicExtract({ ...input, topic: "scope", text, knownRefs: known });
    assert.deepEqual(x.scope.customers, [], text);
    const state = await buildState({ correction: true, texts: { scope: text } });
    assert.equal(verdict("t3", latestConfirmed(state)).status, "clear", `T3 after: ${text}`);
    assert.equal(verdict("t3", latestConfirmed(state)).ruleApplied, false);
    assert.deepEqual(must(latestConfirmed(state)).guardrails.find((g) => g.trigger === "customer" && !g.unexplained)?.scope.customers, ["customer_07"]);
  }
  // Customers the expert does put into the scope still join it.
  assert.deepEqual(heuristicExtract({ ...input, topic: "scope", text: "Customer three too.", knownRefs: known }).scope.customers, ["customer_03"]);
  assert.deepEqual(heuristicExtract({ ...input, topic: "scope", text: "Only customer seven gets it.", knownRefs: known }).scope.customers, ["customer_07"]);
  assert.deepEqual(heuristicExtract({ ...input, topic: "scope", text: "Customer three.", knownRefs: known }).scope.customers, [], "a bare name is not an explicit inclusion");
  // Naming a customer in another answer is not a scope statement.
  assert.deepEqual(heuristicExtract({ ...input, topic: "reason", text: "Customer three asked for it because of his phone.", knownRefs: known }).scope.customers, []);
});

test("'customers two weeks ago' names no customer, and no ref is made up from a number word", () => {
  const known = scenarioCustomers();
  assert.ok(!known.includes("customer_02"));
  assert.deepEqual(mentionedRefs("We got complaints from customers two weeks ago.", { knownRefs: known }), []);
  assert.deepEqual(mentionedRefs("A customer two weeks ago asked for it.", { knownRefs: known }), []);
  assert.deepEqual(mentionedRefs("customers two weeks ago", { knownRefs: [...known, "customer_02"] }), [], "not even when customer_02 exists");
  assert.deepEqual(mentionedRefs("customer two orders", { knownRefs: [...known, "customer_02"] }), []);
  assert.deepEqual(mentionedRefs("customer two", { knownRefs: known }), [], "a number that matches no known customer is not invented");
  assert.deepEqual(mentionedRefs("customer two", { knownRefs: [...known, "customer_02"] }), ["customer_02"]);
  const x = heuristicExtract({ ...input, topic: "scope", text: "Only for him. It started with customers two weeks ago.", knownRefs: known });
  assert.deepEqual(x.scope.customers, []);
  assert.deepEqual(x.unexplainedCustomers, []);
  assert.deepEqual(heuristicExtract({ ...input, topic: "scope", text: "Customer nine asks for something similar, but I never found out why.", knownRefs: ["customer_07"] }).unexplainedCustomers, [], "customer_09 is not a known customer here");
});

// ---------------------------------------------------------------------------
// Minor: a bare "time" is not always the delivery window

test("'The time doesn't matter' does not make the delivery window required", async () => {
  assert.deepEqual(extractFacts("The time doesn't matter."), []);
  assert.deepEqual(extractFacts("The address and the order number. The time doesn't matter."), ["orderId", "deliveryAddress"]);
  assert.deepEqual(extractFacts("The address, not the delivery time."), ["deliveryAddress"]);
  assert.deepEqual(extractFacts("The address and the delivery time."), ["deliveryAddress", "deliveryWindow"]);
  // With the global veto the whole answer yields no field at all: never half of it.
  const state = await buildState({ followUps: false, confirm: false, texts: { essentials: "The address. The time doesn't matter." } });
  assert.deepEqual(must(workingMap(state).guardrails[0]).requiredFacts, ["deliveryAddress", "deliveryWindow"], "falls back to what the expert typed");
});

// ---------------------------------------------------------------------------
// Minor: a long burst of typing must not eat the third question

function typingTimeline(typingEnd: number): ScreenObservation[] {
  const feed = new Feed("sess-long");
  const o = order("ORD-2041");
  const c = o.customerRef;
  const body = bodyFor(o);
  return [
    feed.order(0, o),
    feed.email(0, c),
    feed.email(2800, c, { attachments: [IMAGE] }),
    feed.email(4600, c),
    feed.email(typingEnd, c, { bodyText: body }),
    feed.email(typingEnd + 11000, c, { bodyText: body, previewState: "preview" }),
    feed.email(typingEnd + 23000, c, { bodyText: body, previewState: "sent" }),
  ];
}

test("the expert types for 35 s and the 10-minute demo flow still gets its three questions, none lost to Review", async () => {
  // Typing starts at once after the attachment is removed, so the first question has to wait out the whole burst.
  const session = startLearnSession({ timeline: typingTimeline(41000), typing: [[5000, 41000]] });
  await session.run(600_000);
  const topics = session.questions.map((q) => q.question.topic);
  assert.deepEqual([...topics].sort(), ["essentials", "guardrail", "reason"]);
  assert.ok(must(session.questions[0]).askedAtMs >= 43000, "the first question waited for the pause after the typing");
  for (const { askedAtMs } of session.questions) assert.ok(askedAtMs < 5000 || askedAtMs >= 43000, `asked at ${askedAtMs}, while typing`);
  assert.deepEqual(session.policy.heldForReview(), []);
  assert.ok(!session.decisions().some((d) => d.reasons.includes("stale") || d.reasons.includes("budget")));
  for (const d of session.decisions().filter((x) => x.decision === "ASK_NOW")) assert.equal(d.quiet.natural, true);

  // Even a 55 s burst stays inside the 60 s a question may wait.
  const long = startLearnSession({ timeline: typingTimeline(61000), typing: [[5000, 61000]] });
  await long.run(600_000);
  assert.deepEqual(long.questions.map((q) => q.question.topic).sort(), ["essentials", "guardrail", "reason"]);
});

test("a question is still held for Review when it waited longer than the limit", async () => {
  const session = startLearnSession({ timeline: typingTimeline(81000), typing: [[5000, 81000]] });
  await session.run(200_000);
  assert.ok(session.decisions().some((d) => d.decision === "DEFER" && d.reasons.includes("stale") && d.deferTo === "review"));
  assert.ok(session.questions.length >= 2, "the later questions are still asked live");
});

// A short check that the scripted answers of this file are the ones the other tests use.
test("the extractor and the map agree on a spoken, known customer", async () => {
  const state = await buildState({ confirm: false });
  assert.ok(knownCustomerRefs(state).includes("customer_12"));
  assert.ok(expertAnswer("scope").includes("Customer_09"));
  assert.ok(expertTeachback("confirm").length > 0);
  const again = reduceMap(state, { type: "known_customers", refs: ["customer_20"] });
  assert.ok(knownCustomerRefs(again).includes("customer_20"));
});
