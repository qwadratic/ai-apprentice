// The heuristic runs only when the model is unreachable (HTTP 429, timeout, error), so it is FAIL-SAFE, not complete.
// The invariant, checked here on tables of adversarial phrasings (the reviewers' exact cases first, then more):
//
//   any free-form phrase may yield "unknown", "unclear" or a clarifying question; it must never yield a confirmed reason
//   the expert did not give, a confirmation that drops added content, or a scope wider than the expert stated.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeuristicAnswerExtractor,
  applyTeachBackReply,
  checkpoint,
  extractFacts,
  heuristicExtract,
  latestConfirmed,
  planFollowUps,
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
// 1. Reasons: only a positive causal statement is a reason

interface ReasonCase {
  text: string;
  /** none: no reason may come out. reason: a reason that contains `mentions` (lower case). */
  expect: "none" | "reason";
  mentions?: string;
  /** The expert said outright that they do not know: Review must not ask again. */
  saidUnknown?: boolean;
  /** The reviewers' exact phrase. */
  reviewer?: boolean;
}

const REASONS: ReasonCase[] = [
  // Non-answers and non-reasons (reviewers first).
  { text: "I'm not really sure, honestly.", expect: "none", saidUnknown: true, reviewer: true },
  { text: "I don't remember anymore.", expect: "none", saidUnknown: true, reviewer: true },
  { text: "Not a hundred percent sure, to be honest.", expect: "none", saidUnknown: true, reviewer: true },
  { text: "Good question, I'd have to think about that.", expect: "none", saidUnknown: true, reviewer: true },
  { text: "Beats me. It was like that when I started.", expect: "none", saidUnknown: true, reviewer: true },
  { text: "That's just how we do it here.", expect: "none", reviewer: true },
  // Mine.
  { text: "Hmm, hard to say.", expect: "none" },
  { text: "It's complicated.", expect: "none" },
  { text: "Long story.", expect: "none" },
  { text: "Habit, I suppose.", expect: "none" },
  { text: "I'd rather not say.", expect: "none" },
  { text: "Ask the account manager, she knows.", expect: "none" },
  { text: "I was told to do it, I don't remember by whom.", expect: "none", saidUnknown: true },
  { text: "Probably nothing.", expect: "none" },
  { text: "Why do you ask?", expect: "none" },
  { text: "Sorry, I lost my train of thought.", expect: "none" },
  { text: "I don't know, because nobody ever told me.", expect: "none", saidUnknown: true },
  { text: "Who knows why anyone does anything.", expect: "none", saidUnknown: true },
  { text: "It was like that before me.", expect: "none" },
  { text: "Since forever.", expect: "none" },
  { text: "Because.", expect: "none" },
  { text: "No comment.", expect: "none" },
  { text: "I can't see the point of the question.", expect: "none", saidUnknown: true },
  { text: "It doesn't matter.", expect: "none" },
  { text: "He is a nice guy.", expect: "none" },
  { text: "Maybe, maybe not.", expect: "none" },
  { text: "He said he doesn't know why either.", expect: "none", saidUnknown: true },
  { text: "That's what he told me, I never questioned it.", expect: "none" },
  { text: "My boss said so.", expect: "none" },
  { text: "He wants it, no idea why.", expect: "none", saidUnknown: true },
  { text: "Do I really have to explain?", expect: "none" },
  // Real reasons, stated in different ways (reviewer's keeper first).
  { text: "I'm not sure. I think his phone blocks pictures.", expect: "reason", mentions: "phone", reviewer: true },
  { text: "Their mail client can't open images.", expect: "reason", mentions: "mail client" },
  { text: "Customer_07 prefers plain messages.", expect: "reason", mentions: "prefers" },
  { text: "The company policy says orders go out in writing.", expect: "reason", mentions: "policy" },
  { text: "Otherwise he can't read the address.", expect: "reason", mentions: "read the address" },
  { text: "Because the printer in his office only handles text.", expect: "reason", mentions: "printer" },
  { text: "He needs it for his own records.", expect: "reason", mentions: "records" },
  { text: "We do it so that nobody has to open an attachment.", expect: "reason", mentions: "attachment" },
  { text: "To make sure the driver sees the address on his phone.", expect: "reason", mentions: "driver" },
  { text: "I think it's because his spam filter strips images.", expect: "reason", mentions: "spam filter" },
  { text: "Not sure, but his firewall blocks attachments.", expect: "reason", mentions: "firewall" },
];

test("reasons: non-answers and non-reasons yield no reason and T1 says unknown; stated reasons are kept and T1 warns", async () => {
  assert.ok(REASONS.length >= 30);
  for (const c of REASONS) {
    const topics = ["reason", "why_stop"] as const;
    for (const topic of topics) {
      const x = heuristicExtract({ ...input, topic, text: c.text });
      if (x.rationale !== null) assert.ok(x.text.includes(must(x.reasonQuote)), `${c.text}: the reason is backed by the expert's own words`);
      if (c.expect === "none") {
        assert.equal(x.rationale, null, `${topic}: "${c.text}" must not give a reason, got "${x.rationale}"`);
        assert.equal(x.reasonUnknown, c.saidUnknown === true, `${topic}: "${c.text}" reasonUnknown`);
      } else {
        assert.ok(x.rationale !== null, `${topic}: "${c.text}" states a reason`);
        assert.ok(x.rationale.toLowerCase().includes(must(c.mentions)), `${topic}: "${c.text}" -> "${x.rationale}"`);
      }
    }

    // End to end: the rule is enforced only when the expert gave a reason.
    const state = await buildState({ correction: true, followUps: false, texts: { reason: c.text } });
    const map = latestConfirmed(state);
    const g = must(workingMap(state).guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
    const verdict = checkpointFor("t1", map);
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
// 2. Replies: confirm only when nothing is added

interface ReplyCase {
  reply: string;
  expect: TeachBackReply;
  /** Content the reply adds (lower case): the verdict is never "confirm", and a correction carries it. */
  adds?: string;
  reviewer?: boolean;
}

const REPLIES: ReplyCase[] = [
  // The reviewers' exact cases.
  { reply: "That's right, and put the order number in it.", expect: "correct", adds: "order number", reviewer: true },
  { reply: "Yeah. Customer twelve is the same.", expect: "correct", adds: "customer twelve", reviewer: true },
  { reply: "Correct, he wants the order number in there as well.", expect: "correct", adds: "order number", reviewer: true },
  { reply: "Yes. Customer twelve too.", expect: "correct", adds: "customer twelve", reviewer: true },
  { reply: "No, that's right.", expect: "confirm", reviewer: true },
  { reply: "Okay, that's correct.", expect: "confirm", reviewer: true },
  { reply: "Sounds good.", expect: "confirm", reviewer: true },
  { reply: "Uh, yes, that's right.", expect: "confirm", reviewer: true },
  // Mine: confirmations.
  { reply: "Yes.", expect: "confirm" },
  { reply: "Yeah, exactly.", expect: "confirm" },
  { reply: "That's right.", expect: "confirm" },
  { reply: "Right.", expect: "confirm" },
  { reply: "Absolutely, thank you.", expect: "confirm" },
  { reply: "Sounds good to me.", expect: "confirm" },
  { reply: "Yes it is.", expect: "confirm" },
  { reply: "Yep, spot on.", expect: "confirm" },
  // Mine: additions, in different positions and words.
  { reply: "Sounds good, but also include the delivery window.", expect: "correct", adds: "delivery window" },
  { reply: "Right, except for orders over five hundred euros.", expect: "correct", adds: "five hundred euros" },
  { reply: "Okay, one more thing: send me a copy.", expect: "correct", adds: "send me a copy" },
  { reply: "Yes, and ask the account manager first.", expect: "correct", adds: "account manager" },
  { reply: "Exactly. Add the phone number.", expect: "correct", adds: "phone number" },
  { reply: "That's right apart from the window, which is optional.", expect: "correct", adds: "window" },
  { reply: "Yes, but the order number is needed too.", expect: "correct", adds: "order number" },
  { reply: "I think that's right, although the reason is his IT policy.", expect: "correct", adds: "it policy" },
  { reply: "Perfect. Oh, and it is only for deliveries in the city.", expect: "correct", adds: "deliveries in the city" },
  { reply: "Yeah, you missed one thing.", expect: "correct", adds: "missed one thing" },
  { reply: "That's right, the order number is not needed.", expect: "correct", adds: "order number" },
  { reply: "Yes, that's right, and thanks.", expect: "confirm" },
  { reply: "Sure.", expect: "confirm" },
  { reply: "Okay, but no.", expect: "unclear" },
  { reply: "Yes and no.", expect: "unclear" },
  // Mine: cannot be parsed or says nothing: unclear, Review asks again.
  { reply: "Hmm.", expect: "unclear" },
  { reply: "I'm not sure.", expect: "unclear" },
  { reply: "No.", expect: "unclear" },
  { reply: "That's not right.", expect: "unclear" },
  { reply: "Not quite.", expect: "unclear" },
  { reply: "What?", expect: "unclear" },
  { reply: "Can you repeat that?", expect: "unclear" },
  { reply: "Yes, and.", expect: "unclear" },
  { reply: "Uh...", expect: "unclear" },
];

test("replies: a confirmation only when nothing substantive is added; additions are corrections that carry them", async () => {
  assert.ok(REPLIES.length >= 30);
  for (const c of REPLIES) {
    const read = readReply(c.reply);
    assert.equal(read.verdict, c.expect, `"${c.reply}"`);
    if (c.adds !== undefined) {
      assert.notEqual(read.verdict, "confirm", `"${c.reply}" adds something and must never confirm`);
      // The correction is cut out of the reply when the reply opens with agreement; otherwise the whole reply carries it.
      const carried = read.correction ?? c.reply;
      assert.ok(carried.toLowerCase().includes(c.adds), `"${c.reply}" -> correction ${JSON.stringify(read.correction)}`);
      assert.ok(c.reply.includes(carried), "the correction is the expert's own wording");
    }
    if (c.expect !== "correct") assert.equal(read.correction, null);
  }
});

test("replies end to end: additions move the map to a new version, nothing is lost, and an unclear reply changes nothing", async () => {
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

  // Customer twelve is the same: the rule now covers customer_12.
  const twelve = await applyTeachBackReply(state, { text: "Yeah. Customer twelve is the same.", atMs: 93 }, extractor);
  assert.equal(twelve.outcome, "corrected");
  assert.deepEqual(must(workingMap(twelve.state).guardrails.find((g) => g.trigger === "customer" && !g.unexplained)).scope.customers, ["customer_07", "customer_12"]);

  // A "correction" the heuristic cannot hold is asked about again, not applied as a no-op version.
  const noop = await applyTeachBackReply(state, { text: "Right, except for orders over five hundred euros.", atMs: 94 }, extractor);
  assert.equal(noop.outcome, "unclear");
  assert.equal(noop.state, state);
});

// ---------------------------------------------------------------------------
// 3. Scope: widened only on explicit inclusion

interface ScopeCase {
  text: string;
  topic?: "scope" | "correction";
  /** Customers that may join the rule (exactly these, no others). */
  joins?: string[];
  /** The rule may become "every customer". */
  all?: boolean;
  reviewer?: boolean;
}

const SCOPES: ScopeCase[] = [
  // The reviewers' exact cases.
  { text: "Only him, everyone else gets the template.", reviewer: true },
  { text: "Just him. Every other customer is fine with the image.", reviewer: true },
  { text: "Only him. Customer 3, for example, still gets the picture.", reviewer: true },
  { text: "Only customer seven. Customer three wants the picture, always has.", joins: ["customer_07"], reviewer: true },
  { text: "Customer three is the usual case.", reviewer: true },
  // Mine: exclusion and contrast never widen.
  { text: "Only for him, nobody else." },
  { text: "Just him; the rest keep the template." },
  { text: "Only him. Other customers are fine as they are." },
  { text: "Not for everyone, only him." },
  { text: "Everyone else still gets the image." },
  { text: "He is the exception, customer three gets the picture." },
  { text: "Customer nine is different." },
  { text: "Only customer seven, not customer three." , joins: ["customer_07"] },
  { text: "Every customer gets it, except customer three." },
  { text: "Customer three, maybe." },
  { text: "Customer twelve? I'm not sure." },
  { text: "Customer three still wants the picture." },
  { text: "Only him, and customer three too." },
  { text: "No, not for every customer." },
  { text: "Customer three is not the same." },
  { text: "Customer nine is the same as always." },
  { text: "Customer nine as well, but customer three not.", joins: ["customer_09"] },
  { text: "Customer three always gets the picture." },
  { text: "He and customer twelve." },
  { text: "Only for customer seven and customer nine.", joins: ["customer_07"] },
  // Mine: explicit inclusion widens, and only as far as stated.
  { text: "Customer three too.", joins: ["customer_03"] },
  { text: "Also customer nine.", joins: ["customer_09"] },
  { text: "Customer twelve and customer three as well.", joins: ["customer_12", "customer_03"] },
  { text: "Customer nine is the same.", joins: ["customer_09"] },
  { text: "Same for customer twelve.", joins: ["customer_12"] },
  { text: "Every customer gets it.", all: true },
  { text: "It is for everyone.", all: true },
  { text: "All customers need it.", all: true },
  // Said as a correction of the teach-back.
  { text: "Customer twelve is the same.", topic: "correction", joins: ["customer_12"] },
  { text: "Customer twelve too.", topic: "correction", joins: ["customer_12"] },
  { text: "Not quite, it is for every customer.", topic: "correction", all: true },
  { text: "Everyone else still gets the template.", topic: "correction" },
];

test("scope: only an explicit inclusion widens the rule, and never wider than stated", async () => {
  assert.ok(SCOPES.length >= 30);
  for (const c of SCOPES) {
    const topic = c.topic ?? "scope";
    const x = heuristicExtract({ ...input, topic, text: c.text });
    assert.deepEqual([...x.scope.customers].sort(), [...(c.joins ?? [])].sort(), `${topic}: "${c.text}" customers`);
    assert.equal(x.scope.all, c.all === true, `${topic}: "${c.text}" all customers`);
    // Never wider than the case allows, whatever the exact output.
    for (const ref of x.scope.customers) assert.ok((c.joins ?? []).includes(ref), `"${c.text}" must not add ${ref}`);
    if (c.all !== true) assert.equal(x.scope.all, false, `"${c.text}" must not widen to everyone`);
  }
});

test("scope end to end: customer_03 and customer_09 are covered by the rule only when the expert included them", async () => {
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
// 4. Fields: a field is required only when it is named

const FIELDS: Array<{ text: string; expect: FactKey[]; reviewer?: boolean }> = [
  { text: "Just the address, every time.", expect: ["deliveryAddress"], reviewer: true },
  { text: "The time doesn't matter.", expect: [] },
  { text: "The address and the time.", expect: ["deliveryAddress", "deliveryWindow"] },
  { text: "Next time include the address.", expect: ["deliveryAddress"] },
  { text: "At the time I did it for the address.", expect: ["deliveryAddress"] },
  { text: "Only the order number, one time or another.", expect: ["orderId"] },
  { text: "His email address is on file, I need the delivery address.", expect: ["deliveryAddress"] },
  { text: "The address, not the window.", expect: ["deliveryAddress"] },
  { text: "Everything I need for the delivery.", expect: [] },
  { text: "Nothing special.", expect: [] },
];

test("fields: a field is required only when it is named, in a clause that wants it", () => {
  for (const c of FIELDS) assert.deepEqual(extractFacts(c.text), c.expect, c.text);
});
