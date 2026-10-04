// The heuristic runs only when the model is unreachable (HTTP 429, timeout, error), so it is FAIL-SAFE, not complete.
// Precision over recall: it may only act on plain, affirmative, unhedged statements. A question mark, a negation, a hedge or a
// contrast anywhere in an utterance (the global veto) means: no reason, no field, no widening of the scope, and a reply to the
// teach-back becomes "unclear". The model path or the Confirm / Correct / Skip buttons take over.
//
// Invariant, checked here on tables of adversarial phrasings and end to end:
//   any free-form phrase may yield "unknown", "unclear" or a clarifying question; it must never yield a confirmed reason
//   the expert did not give, a confirmation that drops added content, a field they did not name, or a scope wider than stated.
//
// "veto" marks the cases that carry a veto marker on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeuristicAnswerExtractor,
  MAX_UNCLEAR,
  ReviewClarifier,
  applyTeachBackReply,
  checkpoint,
  extractFacts,
  followUpKey,
  heuristicExtract,
  isVetoed,
  latestConfirmed,
  planFollowUps,
  pressReviewButton,
  readReply,
  workingMap,
} from "../src/index.ts";
import type { FactKey, TeachBackReply } from "../src/index.ts";
import { buildState, scenarioCustomers, teachCase } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();
const known = scenarioCustomers();
const input = { questionId: "q", atMs: 1, evidenceIds: ["e"], targetId: null, entityRef: "customer_07", knownRefs: known };

function checkpointFor(id: string, map: Parameters<typeof checkpoint>[0]["map"]) {
  const c = teachCase(id);
  return checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
}

// ---------------------------------------------------------------------------
// The global veto

test("the global veto: question, negation, hedge or contrast, and nothing else", () => {
  for (const text of [
    "Why?", "He does not want it.", "He doesn't want it.", "Never.", "Nobody knows.", "Nothing special.", "Maybe.", "Perhaps.", "Probably.", "I think so.",
    "I guess.", "I suppose.", "I assume so.", "It was assumed.", "I'm not sure.", "I doubt it.", "I wish.", "It might.", "It could.", "It would.", "It should.",
    "If so.", "Eventually.", "He used to.", "Not anymore.", "Mostly.", "Honestly.", "Yes, but.", "Although.", "Actually.",
  ]) assert.ok(isVetoed(text), text);
  for (const text of ["He prefers plain messages.", "The address and the delivery window.", "Customer three too.", "Yes, that's right.", "Every customer gets it."]) {
    assert.equal(isVetoed(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// 1. Reasons: only a plain, affirmative causal statement is a reason

interface ReasonCase {
  text: string;
  expect: "none" | "reason";
  mentions?: string;
  saidUnknown?: boolean;
  veto?: boolean;
}

const REASONS: ReasonCase[] = [
  // Non-answers and non-reasons.
  { text: "I'm not really sure, honestly.", expect: "none", saidUnknown: true, veto: true },
  { text: "I don't remember anymore.", expect: "none", saidUnknown: true, veto: true },
  { text: "Not a hundred percent sure, to be honest.", expect: "none", saidUnknown: true, veto: true },
  { text: "Good question, I'd have to think about that.", expect: "none", saidUnknown: true, veto: true },
  { text: "Beats me. It was like that when I started.", expect: "none", saidUnknown: true },
  { text: "That's just how we do it here.", expect: "none" },
  { text: "Hmm, hard to say.", expect: "none" },
  { text: "It's complicated.", expect: "none" },
  { text: "Long story.", expect: "none" },
  { text: "Habit, I suppose.", expect: "none", veto: true },
  { text: "I'd rather not say.", expect: "none", veto: true },
  { text: "Ask the account manager, she knows.", expect: "none" },
  { text: "I was told to do it, I don't remember by whom.", expect: "none", saidUnknown: true, veto: true },
  { text: "Why do you ask?", expect: "none", veto: true },
  { text: "I don't know, because nobody ever told me.", expect: "none", saidUnknown: true, veto: true },
  { text: "Who knows why anyone does anything.", expect: "none", saidUnknown: true },
  { text: "Since forever.", expect: "none" },
  { text: "Because.", expect: "none" },
  { text: "He said he doesn't know why either.", expect: "none", saidUnknown: true, veto: true },
  { text: "That's what he told me, I never questioned it.", expect: "none", veto: true },
  { text: "My boss said so.", expect: "none" },
  // Hedged, negated, questioned or contrasted reasons: the veto leaves them to the model.
  { text: "Maybe because his phone blocks pictures.", expect: "none", veto: true },
  { text: "He probably needs it for his records.", expect: "none", veto: true },
  { text: "I guess it is because of the printer.", expect: "none", veto: true },
  { text: "He asked for it, although I never checked why.", expect: "none", veto: true },
  { text: "It might be his firewall.", expect: "none", veto: true },
  { text: "Because his phone would block pictures.", expect: "none", veto: true },
  { text: "Why? Because his phone blocks pictures.", expect: "none", veto: true },
  { text: "If the phone blocks pictures, he needs text.", expect: "none", veto: true },
  { text: "He used to ask for it in writing.", expect: "none", veto: true },
  { text: "Mostly because of his phone.", expect: "none", veto: true },
  { text: "Honestly, his phone blocks pictures.", expect: "none", veto: true },
  { text: "He does not like attachments.", expect: "none", veto: true },
  { text: "It was assumed that he needs it.", expect: "none", veto: true },
  { text: "I'm not sure. I think his phone blocks pictures.", expect: "none", saidUnknown: true, veto: true },
  { text: "Their mail client can't open images.", expect: "none", veto: true },
  { text: "Not sure, but his firewall blocks attachments.", expect: "none", saidUnknown: true, veto: true },
  { text: "He needs it, actually no, I mean she needs it.", expect: "none", veto: true },
  // Plain, affirmative statements are kept.
  { text: "He asked for it in writing, his phone blocks pictures in our emails.", expect: "reason", mentions: "phone" },
  { text: "It's his phone. It blocks pictures in our emails.", expect: "reason", mentions: "phone" },
  { text: "Customer_07 prefers plain messages.", expect: "reason", mentions: "prefers" },
  { text: "The company policy says orders go out in writing.", expect: "reason", mentions: "policy" },
  { text: "Because the printer in his office only handles text.", expect: "reason", mentions: "printer" },
  { text: "He needs it for his own records.", expect: "reason", mentions: "records" },
  { text: "To make sure the driver sees the address on his phone.", expect: "reason", mentions: "driver" },
  { text: "Their system rejects attachments.", expect: "reason", mentions: "rejects" },
];

test("reasons: no reason without a plain causal statement, and T1 says unknown; stated reasons are kept and T1 warns", async () => {
  assert.ok(REASONS.length >= 45);
  assert.ok(REASONS.filter((c) => c.veto).length >= 15);
  for (const c of REASONS) {
    for (const topic of ["reason", "why_stop"] as const) {
      const x = heuristicExtract({ ...input, topic, text: c.text });
      if (x.rationale !== null) assert.ok(x.text.includes(must(x.reasonQuote)), `${c.text}: the reason is backed by the expert's own words`);
      if (c.expect === "none") {
        assert.equal(x.rationale, null, `${topic}: "${c.text}" must not give a reason, got "${x.rationale}"`);
        assert.equal(x.reasonUnknown, c.saidUnknown === true, `${topic}: "${c.text}" reasonUnknown`);
      } else {
        assert.ok(x.rationale !== null, `${topic}: "${c.text}" states a reason`);
        assert.ok(x.rationale.toLowerCase().includes(must(c.mentions)), `${topic}: "${c.text}" -> "${x.rationale}"`);
      }
      if (c.veto) assert.ok(isVetoed(c.text), `${c.text} carries a veto marker`);
      else if (c.expect === "reason") assert.equal(isVetoed(c.text), false, `${c.text} is plain`);
    }
    // End to end: the rule is enforced only when the expert gave a plain reason.
    const state = await buildState({ correction: true, followUps: false, texts: { reason: c.text } });
    const g = must(workingMap(state).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
    const verdict = checkpointFor("t1", latestConfirmed(state));
    if (c.expect === "none") {
      assert.equal(g.reason, null, c.text);
      assert.notEqual(g.status, "confirmed", c.text);
      assert.equal(verdict.status, "unknown", `T1 must not warn on a rule without a reason: "${c.text}"`);
      const again = planFollowUps(workingMap(state)).filter((q) => q.topic === "reason");
      assert.equal(again.length, c.saidUnknown === true ? 0 : 1, `Review asks again unless the expert said they do not know: "${c.text}"`);
    } else {
      assert.equal(g.status, "confirmed", c.text);
      assert.equal(verdict.status, "warn", c.text);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Replies: confirm only when nothing is added; anything hedged or contrasted is unclear

interface ReplyCase {
  reply: string;
  expect: TeachBackReply;
  /** Content the reply adds (lower case): the verdict is never "confirm", and a correction carries it. */
  adds?: string;
  veto?: boolean;
}

const REPLIES: ReplyCase[] = [
  // Confirmations.
  { reply: "Yes.", expect: "confirm" },
  { reply: "Yeah, exactly.", expect: "confirm" },
  { reply: "That's right.", expect: "confirm" },
  { reply: "Right.", expect: "confirm" },
  { reply: "Absolutely, thank you.", expect: "confirm" },
  { reply: "Sounds good to me.", expect: "confirm" },
  { reply: "Yes it is.", expect: "confirm" },
  { reply: "Yep, spot on.", expect: "confirm" },
  { reply: "No, that's right.", expect: "confirm" },
  { reply: "Okay, that's correct.", expect: "confirm" },
  { reply: "Sounds good.", expect: "confirm" },
  { reply: "Uh, yes, that's right.", expect: "confirm" },
  { reply: "Yes, that's right, and thanks.", expect: "confirm" },
  { reply: "Sure.", expect: "confirm" },
  // Plain additions: a correction that carries them. Scope words are content, not filler.
  { reply: "Yes, it is for all.", expect: "correct", adds: "for all" },
  { reply: "Right, it is for every customer.", expect: "correct", adds: "every customer" },
  { reply: "That's right, and put the order number in it.", expect: "correct", adds: "order number" },
  { reply: "Yeah. Customer twelve is the same.", expect: "correct", adds: "customer twelve" },
  { reply: "Correct, he wants the order number in there as well.", expect: "correct", adds: "order number" },
  { reply: "Yes. Customer twelve too.", expect: "correct", adds: "customer twelve" },
  { reply: "Exactly. Add the phone number.", expect: "correct", adds: "phone number" },
  { reply: "Yes, and ask the account manager first.", expect: "correct", adds: "account manager" },
  { reply: "Okay, one more thing: send me a copy.", expect: "correct", adds: "send me a copy" },
  { reply: "Yeah, you missed one thing.", expect: "correct", adds: "missed one thing" },
  // Question, negation, hedge or contrast: unclear, never a confirmation and never a half-applied correction.
  { reply: "Sounds good, but also include the delivery window.", expect: "unclear", veto: true },
  { reply: "Right, except for orders over five hundred euros.", expect: "unclear", veto: true },
  { reply: "Yes, but the order number is needed too.", expect: "unclear", veto: true },
  { reply: "I think that's right, although the reason is his IT policy.", expect: "unclear", veto: true },
  { reply: "That's right, the order number is not needed.", expect: "unclear", veto: true },
  { reply: "Yes, if you add the window.", expect: "unclear", veto: true },
  { reply: "Right, maybe also the phone number.", expect: "unclear", veto: true },
  { reply: "Yes, that is right, I guess.", expect: "unclear", veto: true },
  { reply: "Correct, he would want the order number too.", expect: "unclear", veto: true },
  { reply: "Yes?", expect: "unclear", veto: true },
  { reply: "Is that right?", expect: "unclear", veto: true },
  { reply: "Okay, but no.", expect: "unclear", veto: true },
  { reply: "Yes and no.", expect: "unclear", veto: true },
  { reply: "Hmm.", expect: "unclear" },
  { reply: "I'm not sure.", expect: "unclear", veto: true },
  { reply: "No.", expect: "unclear", veto: true },
  { reply: "That's not right.", expect: "unclear", veto: true },
  { reply: "Not quite.", expect: "unclear", veto: true },
  { reply: "What?", expect: "unclear", veto: true },
  { reply: "Can you repeat that?", expect: "unclear", veto: true },
  { reply: "Yes, and.", expect: "unclear" },
  { reply: "Uh...", expect: "unclear" },
];

test("replies: a confirmation only when nothing is added; additions carry their content; anything vetoed is unclear", async () => {
  assert.ok(REPLIES.length >= 40);
  assert.ok(REPLIES.filter((c) => c.veto).length >= 15);
  for (const c of REPLIES) {
    const read = readReply(c.reply);
    assert.equal(read.verdict, c.expect, `"${c.reply}"`);
    if (c.adds !== undefined) {
      assert.notEqual(read.verdict, "confirm", `"${c.reply}" adds something and must never confirm`);
      const carried = read.correction ?? c.reply;
      assert.ok(carried.toLowerCase().includes(c.adds), `"${c.reply}" -> correction ${JSON.stringify(read.correction)}`);
      assert.ok(c.reply.includes(carried), "the correction is the expert's own wording");
    }
    if (c.veto && c.expect === "unclear" && !/^(?:no|that's not right|not quite)\b/i.test(c.reply)) assert.notEqual(read.verdict, "confirm", c.reply);
    if (c.expect !== "correct") assert.equal(read.correction, null);
  }
});

test("replies end to end: additions move the map to a new version, nothing is lost, an unclear reply changes nothing", async () => {
  const state = await buildState({ confirm: false });
  for (const c of REPLIES) {
    const out = await applyTeachBackReply(state, { text: c.reply, atMs: 90 }, extractor);
    if (c.expect === "confirm") assert.equal(out.outcome, "confirmed", c.reply);
    else assert.notEqual(out.outcome, "confirmed", `"${c.reply}" must not confirm`);
    if (c.expect === "unclear") assert.equal(out.state, state, `"${c.reply}" changes nothing`);
    if (out.outcome === "unclear") assert.equal(out.state, state);
  }

  // The order number really moves T5 to version 2, and T5 warns.
  const addition = await applyTeachBackReply(state, { text: "That's right, and put the order number in it.", atMs: 91 }, extractor);
  assert.equal(addition.outcome, "corrected");
  const done = await applyTeachBackReply(addition.state, { text: "Sounds good.", atMs: 92 }, extractor);
  assert.equal(done.outcome, "confirmed");
  const map = must(latestConfirmed(done.state));
  assert.equal(map.version, 2);
  const v5 = checkpointFor("t5", map);
  assert.equal(v5.status, "warn");
  assert.deepEqual(v5.missingFacts, ["orderId"]);

  // "Yes, it is for all." brings every customer into the rule: a correction carrying the scope.
  const all = await applyTeachBackReply(state, { text: "Yes, it is for all.", atMs: 93 }, extractor);
  assert.equal(all.outcome, "corrected");
  assert.equal(must(workingMap(all.state).guardrails.find((g) => g.trigger === "customer" && !g.unexplained)).scope.kind, "all");

  // Customer twelve is the same: the rule now covers customer_12.
  const twelve = await applyTeachBackReply(state, { text: "Yeah. Customer twelve is the same.", atMs: 94 }, extractor);
  assert.equal(twelve.outcome, "corrected");
  assert.deepEqual(must(workingMap(twelve.state).guardrails.find((g) => g.trigger === "customer" && !g.unexplained)).scope.customers, ["customer_07", "customer_12"]);

  // A "correction" the heuristic cannot hold is asked about again, not applied as a no-op version.
  const noop = await applyTeachBackReply(state, { text: "Okay, one more thing: send me a copy.", atMs: 95 }, extractor);
  assert.equal(noop.outcome, "unclear");
  assert.equal(noop.state, state);
});

// ---------------------------------------------------------------------------
// 3. Field removal: never half of it

test("field removal ('not the window, just the address and the order number') is unclear, never half applied", async () => {
  const texts = ["Not the window, just the address and the order number.", "The window is not required, only the address and the order number."];
  const state = await buildState({ confirm: false });
  const before = must(workingMap(state).guardrails[0]).requiredFacts;
  assert.deepEqual(before, ["deliveryAddress", "deliveryWindow"]);
  for (const text of texts) {
    // As a correction of the rule: no field is added, none is removed.
    const x = heuristicExtract({ ...input, topic: "correction", text });
    assert.deepEqual(x.requiredFacts, [], text);
    // As a reply to the teach-back: unclear, the map is untouched.
    assert.equal(readReply(text).verdict, "unclear", text);
    const out = await applyTeachBackReply(state, { text, atMs: 90 }, extractor);
    assert.equal(out.outcome, "unclear", text);
    assert.equal(out.state, state);
    assert.deepEqual(must(workingMap(out.state).guardrails[0]).requiredFacts, before, "nothing removed, nothing added");
  }
});

// ---------------------------------------------------------------------------
// 4. Scope: widened only on explicit, plain inclusion

interface ScopeCase {
  text: string;
  topic?: "scope" | "correction";
  /** Customers that may join the rule (exactly these, no others). */
  joins?: string[];
  /** The rule may become "every customer". */
  all?: boolean;
  veto?: boolean;
}

const SCOPES: ScopeCase[] = [
  // Exclusion and contrast never widen.
  { text: "Only him, everyone else gets the template." },
  { text: "Just him. Every other customer is fine with the image." },
  { text: "Only him. Customer 3, for example, still gets the picture." },
  { text: "Only customer seven. Customer three wants the picture, always has.", joins: ["customer_07"] },
  { text: "Customer three is the usual case." },
  { text: "Only for him, nobody else." },
  { text: "Just him; the rest keep the template." },
  { text: "Only him. Other customers are fine as they are." },
  { text: "Everyone else still gets the image." },
  { text: "He is the exception, customer three gets the picture." },
  { text: "Customer nine is different." },
  { text: "Customer three still wants the picture." },
  { text: "Customer nine is the same as always." },
  { text: "Customer three always gets the picture." },
  { text: "He and customer twelve." },
  { text: "Only for customer seven and customer nine.", joins: ["customer_07"] },
  // Veto markers: hedged, negated, questioned or contrasted inclusions do not widen.
  { text: "Not for everyone, only him.", veto: true },
  { text: "Only customer seven, not customer three.", joins: ["customer_07"], veto: true },
  { text: "Every customer gets it, except customer three.", veto: true },
  { text: "Customer three, maybe.", veto: true },
  { text: "Customer twelve? I'm not sure.", veto: true },
  { text: "Only him, and customer three too, I think.", veto: true },
  { text: "No, not for every customer.", veto: true },
  { text: "Customer three is not the same.", veto: true },
  { text: "Customer nine as well, but customer three not.", veto: true },
  { text: "Maybe customer three too.", veto: true },
  { text: "Customer twelve too, I guess.", veto: true },
  { text: "Every customer gets it, if I remember right.", veto: true },
  { text: "Perhaps everyone gets it.", veto: true },
  { text: "Customer nine would get it too.", veto: true },
  { text: "Customer three too, actually only customer seven.", joins: ["customer_07"], veto: true },
  { text: "All customers should get it.", veto: true },
  { text: "Is it for everyone?", veto: true },
  // Explicit, plain inclusion widens, and only as far as stated.
  { text: "Customer three too.", joins: ["customer_03"] },
  { text: "Also customer nine.", joins: ["customer_09"] },
  { text: "Customer twelve and customer three as well.", joins: ["customer_12", "customer_03"] },
  { text: "Customer nine is the same.", joins: ["customer_09"] },
  { text: "Same for customer twelve.", joins: ["customer_12"] },
  { text: "Every customer gets it.", all: true },
  { text: "It is for everyone.", all: true },
  { text: "All customers need it.", all: true },
  // As a correction of the teach-back.
  { text: "Customer twelve is the same.", topic: "correction", joins: ["customer_12"] },
  { text: "Customer twelve too.", topic: "correction", joins: ["customer_12"] },
  { text: "It is for all.", topic: "correction", all: true },
  { text: "It is for every customer.", topic: "correction", all: true },
  { text: "Not quite, it is for every customer.", topic: "correction", veto: true },
  { text: "Everyone else still gets the template.", topic: "correction" },
];

test("scope: only a plain, explicit inclusion widens the rule, and never wider than stated", () => {
  assert.ok(SCOPES.length >= 40);
  assert.ok(SCOPES.filter((c) => c.veto).length >= 10);
  for (const c of SCOPES) {
    const topic = c.topic ?? "scope";
    const x = heuristicExtract({ ...input, topic, text: c.text });
    assert.deepEqual([...x.scope.customers].sort(), [...(c.joins ?? [])].sort(), `${topic}: "${c.text}" customers`);
    assert.equal(x.scope.all, c.all === true, `${topic}: "${c.text}" all customers`);
    for (const ref of x.scope.customers) assert.ok((c.joins ?? []).includes(ref), `"${c.text}" must not add ${ref}`);
    if (c.all !== true) assert.equal(x.scope.all, false, `"${c.text}" must not widen to everyone`);
    if (c.veto) assert.ok(isVetoed(c.text), `${c.text} carries a veto marker`);
    // A vetoed answer never widens beyond the rule's own customer.
    if (c.veto) assert.ok(x.scope.customers.every((r) => r === "customer_07") && !x.scope.all, `vetoed: "${c.text}"`);
  }
});

test("scope end to end: customer_03 is covered by the rule only when the expert included them, plainly", async () => {
  for (const c of SCOPES.filter((s) => (s.topic ?? "scope") === "scope")) {
    const state = await buildState({ correction: true, texts: { scope: c.text } });
    const map = latestConfirmed(state);
    const g = must(must(map).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
    assert.ok(g.scope.customers.includes("customer_07") || g.scope.kind === "all", c.text);
    const t3 = checkpointFor("t3", map);
    const covered = c.all === true || (c.joins ?? []).includes("customer_03");
    assert.equal(t3.ruleApplied, covered, `T3 for "${c.text}"`);
    if (!covered) assert.equal(t3.status, "clear", `T3 for "${c.text}"`);
  }
});

// ---------------------------------------------------------------------------
// 5. Fields: only the full name or an exact synonym

const FIELDS: Array<{ text: string; expect: FactKey[] }> = [
  // Qualified or partial names name no field.
  { text: "The billing address.", expect: [] },
  { text: "The return address and the order number.", expect: ["orderId"] },
  { text: "The invoice address.", expect: [] },
  { text: "His email address is on file.", expect: [] },
  { text: "The shipping address.", expect: [] },
  { text: "The purchase order number.", expect: [] },
  { text: "The date.", expect: [] },
  { text: "The time.", expect: [] },
  { text: "The window.", expect: [] },
  { text: "The date and time.", expect: [] },
  { text: "Every time, the address.", expect: ["deliveryAddress"] },
  { text: "Next time include the address.", expect: ["deliveryAddress"] },
  { text: "Whenever, the date.", expect: [] },
  // Full names and exact synonyms.
  { text: "The delivery address.", expect: ["deliveryAddress"] },
  { text: "The address.", expect: ["deliveryAddress"] },
  { text: "The delivery window and the address.", expect: ["deliveryAddress", "deliveryWindow"] },
  { text: "The delivery time.", expect: ["deliveryWindow"] },
  { text: "The time slot.", expect: ["deliveryWindow"] },
  { text: "The order number, the order ID and the order reference.", expect: ["orderId"] },
  { text: "Just the address, every time.", expect: ["deliveryAddress"] },
  { text: "Only the order number.", expect: ["orderId"] },
  { text: "The address and the delivery time.", expect: ["deliveryAddress", "deliveryWindow"] },
  // Clauses that do not want it.
  { text: "The time doesn't matter.", expect: [] },
  { text: "The address, not the delivery window.", expect: ["deliveryAddress"] },
  { text: "Everything I need for the delivery.", expect: [] },
  { text: "Nothing special.", expect: [] },
];

test("fields: a field is required only when its full name or exact synonym is named in a clause that wants it", async () => {
  for (const c of FIELDS) assert.deepEqual(extractFacts(c.text), c.expect, c.text);
  // And through the extractor, a vetoed answer names no field at all.
  for (const text of ["The address, but not the window.", "Maybe the address and the order number.", "The delivery address? And the order number?"]) {
    assert.deepEqual(heuristicExtract({ ...input, topic: "essentials", text }).requiredFacts, [], text);
  }
  assert.deepEqual(heuristicExtract({ ...input, topic: "essentials", text: "The address and the delivery window." }).requiredFacts, ["deliveryAddress", "deliveryWindow"]);
});

// ---------------------------------------------------------------------------
// 6. The review does not loop on an expert the heuristic cannot read

test("five unclear replies produce at most two re-asks, then buttons: Confirm / Correct / Skip", async () => {
  let state = await buildState({ confirm: false });
  const clarifier = new ReviewClarifier();
  const itemId = "teachback:1";
  let reAsks = 0;
  let sawButtons = false;
  for (const reply of ["Hmm.", "Yes, but...", "I'm not sure.", "What?", "Uh..."]) {
    const out = await applyTeachBackReply(state, { text: reply, atMs: 90 }, extractor);
    assert.equal(out.outcome, "unclear", reply);
    assert.equal(out.state, state);
    const step = clarifier.unclear(itemId);
    if (step.kind === "ask_again") {
      assert.ok(!sawButtons, "no re-ask after the buttons");
      reAsks++;
    } else {
      sawButtons = true;
      assert.deepEqual([...step.options], ["confirm", "correct", "skip"]);
    }
  }
  assert.ok(reAsks <= 2, `${reAsks} re-asks`);
  assert.equal(reAsks, MAX_UNCLEAR - 1);
  assert.ok(sawButtons);
  assert.ok(clarifier.isUnresolved(itemId));

  // Confirm (the button) confirms the working map and the review moves on.
  const pressed = pressReviewButton(state, clarifier, itemId, "confirm", 99);
  assert.equal(pressed.outcome, "confirmed");
  state = pressed.state;
  assert.equal(must(latestConfirmed(state)).version, 1);
  assert.equal(clarifier.isUnresolved(itemId), false);
});

test("a follow-up the expert could not be understood on is skipped, listed as unresolved and never asked again", async () => {
  const state = await buildState({ followUps: false, confirm: false });
  const clarifier = new ReviewClarifier();
  const first = must(planFollowUps(workingMap(state))[0]);
  const id = followUpKey(first);
  assert.equal(clarifier.unclear(id).kind, "ask_again");
  assert.equal(clarifier.unclear(id).kind, "buttons");
  assert.equal(pressReviewButton(state, clarifier, id, "correct", 1).outcome, "needs_words");
  assert.equal(pressReviewButton(state, clarifier, id, "skip", 2).outcome, "skipped");
  assert.deepEqual(clarifier.unresolved(), [id]);
  const next = planFollowUps(workingMap(state), { unresolved: clarifier.unresolved() });
  assert.ok(!next.some((q) => followUpKey(q) === id), "the skipped follow-up is not asked again");
  assert.ok(next.length >= 2, "the others are still asked");
  // A reply that can be read starts the count again.
  clarifier.understood(id);
  assert.equal(clarifier.unclear(id).kind, "ask_again");
});
