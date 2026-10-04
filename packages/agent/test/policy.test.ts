import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScreenObservation } from "@apprentice/contracts";
import {
  ConversationPolicy,
  FakeClock,
  PERSONAS,
  PERSONA_IDS,
  formatAskLine,
  latestConfirmed,
  learnVariants,
  workingMap,
} from "../src/index.ts";
import type { BrainDecision, PersonaId, PolicyOptions, WorkMap } from "../src/index.ts";
import { Feed, bodyFor, buildState, order } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const IMAGE = { kind: "image" as const, ocrText: "order template" };
const ORD = order("ORD-2041");
const C = "customer_07";

/** A policy on a fake clock: time() is session-relative milliseconds, at(ms) moves it there. */
function harness(options: PolicyOptions = {}) {
  const epoch = 5_000_000;
  const clock = new FakeClock(epoch);
  const feed = new Feed("sess-policy");
  const now = (): number => clock.now() - epoch;
  const policy = new ConversationPolicy({ now, ...options });
  const at = (ms: number): void => {
    assert.ok(ms >= now(), "time only moves forward");
    clock.advance(ms - now());
  };
  const see = (o: ScreenObservation): void => policy.observe(o);
  return { policy, clock, feed, now, at, see };
}

/** Order opened, an email with an image attached, then the image removed at removalAt. Returns the removal observation. */
function learnUntilRemoval(h: ReturnType<typeof harness>, removalAt = 1000): ScreenObservation {
  h.see(h.feed.order(0, ORD));
  h.see(h.feed.email(0, C, { attachments: [IMAGE] }));
  const removal = h.feed.email(removalAt, C);
  h.at(removalAt);
  h.see(removal);
  return removal;
}

const asks = (ds: BrainDecision[]): BrainDecision[] => ds.filter((d) => d.decision === "ASK_NOW");

test("never asks while the expert types: the typing channel defers with a reason, then the pause opens", () => {
  const h = harness();
  learnUntilRemoval(h);
  h.at(3400);
  h.see(h.feed.typing(3400, 3400));
  h.at(3600);
  const blocked = h.policy.tick();
  assert.equal(asks(blocked).length, 0);
  const defer = must(blocked.find((d) => d.decision === "DEFER"));
  assert.ok(defer.reasons.includes("typing"));
  assert.equal(defer.quiet.channels.input, false);
  assert.equal(defer.quiet.inputIdleMs, 200);
  assert.equal(defer.deferTo, "next_pause");

  h.at(6300); // 2.9 s of silence: Plain needs 3 s
  assert.equal(asks(h.policy.tick()).length, 0);
  h.at(6400);
  const ask = asks(h.policy.tick());
  assert.equal(ask.length, 1);
  assert.equal(must(ask[0]).quiet.natural, true);
});

test("asks only at a natural pause: each of the four channels blocks on its own, and the pause needs all four", () => {
  // Screen: changed 1.5 s ago, Plain needs 2 s of stability.
  let h = harness();
  const removal = learnUntilRemoval(h);
  h.at(2500);
  assert.ok(must(h.policy.tick().find((d) => d.decision === "DEFER")).reasons.includes("screen_not_stable"));
  h.at(3000);
  const ask = must(asks(h.policy.tick())[0]);
  assert.deepEqual(ask.reasons, ["natural_pause"]);
  assert.deepEqual(ask.evidenceIds, removal.evidenceIds);
  assert.deepEqual(ask.quiet.channels, { input: true, screen: true, human: true, agent: true });

  // The human speaks, and for 1.2 s after the end of the phrase.
  h = harness();
  learnUntilRemoval(h);
  h.at(3500);
  h.policy.humanSpeech(true);
  h.at(4000);
  assert.ok(must(h.policy.tick().find((d) => d.decision === "DEFER")).reasons.includes("human_speaking"));
  h.at(5000);
  h.policy.humanSpeech(false);
  h.at(5500);
  assert.equal(asks(h.policy.tick()).length, 0, "500 ms after the phrase is too soon");
  h.at(6200);
  assert.equal(asks(h.policy.tick()).length, 1);

  // Clipa herself is speaking: quiet again the moment she stops.
  h = harness();
  learnUntilRemoval(h);
  h.policy.agentSpeech(true);
  h.at(5000);
  assert.ok(must(h.policy.tick().find((d) => d.decision === "DEFER")).reasons.includes("agent_speaking"));
  h.policy.agentSpeech(false);
  assert.equal(asks(h.policy.tick()).length, 1);

  // Two channels at once are both named.
  h = harness();
  learnUntilRemoval(h);
  h.at(1500);
  h.see(h.feed.typing(1500, 1500));
  h.policy.agentSpeech(true);
  h.at(1600);
  const both = must(h.policy.tick().find((d) => d.decision === "DEFER"));
  assert.deepEqual(both.reasons.filter((r) => r !== "question_open"), ["typing", "agent_speaking", "screen_not_stable"]);
});

test("personas set the thresholds: the same silence is a pause for Plain but not for Strict or Quiet", () => {
  const verdicts: Record<string, number> = {};
  for (const persona of ["strict", "plain", "thorough", "quiet"] as PersonaId[]) {
    const h = harness({ persona });
    learnUntilRemoval(h);
    h.see(h.feed.typing(3000, 3000));
    h.at(3000 + PERSONAS[persona].inputPauseMs - 1);
    const before = asks(h.policy.tick()).length;
    h.at(3000 + PERSONAS[persona].inputPauseMs);
    const after = asks(h.policy.tick()).length;
    assert.equal(before, 0, `${persona} waits for ${PERSONAS[persona].inputPauseMs} ms`);
    assert.equal(after, 1, `${persona} asks once the pause is long enough`);
    verdicts[persona] = PERSONAS[persona].inputPauseMs;
  }
  assert.deepEqual(verdicts, { strict: 5000, plain: 3000, thorough: 2500, quiet: 6000 });
});

test("a screen that only repeats itself is quiet: only a real change moves the screen channel", () => {
  const h = harness();
  learnUntilRemoval(h);
  // The same facts again and again (a frame every second) do not count as change.
  for (const t of [1500, 2000, 2500]) {
    h.at(t);
    h.see(h.feed.email(t, C));
  }
  h.at(3000);
  assert.equal(asks(h.policy.tick()).length, 1);
});

test("budget: the question after the budget is held for Review; the rolling window frees it again", () => {
  const h = harness({ budget: 1 });
  learnUntilRemoval(h);
  h.at(3000);
  const first = must(asks(h.policy.tick())[0]);
  assert.equal(first.budget.asked, 1);
  h.policy.finishQuestion(must(first.question).id, 8000);
  h.at(9000);
  h.see(h.feed.email(9000, C, { bodyText: bodyFor(ORD) }));
  h.at(20000);
  const out = h.policy.tick();
  const held = must(out.find((d) => d.decision === "DEFER"));
  assert.deepEqual(held.reasons, ["budget"]);
  assert.equal(held.deferTo, "review");
  assert.ok(held.expiresAtMs !== null && held.expiresAtMs > 20000);
  assert.equal(asks(out).length, 0);
  assert.equal(h.policy.heldForReview().length, 1);
  assert.equal(must(h.policy.heldForReview()[0]).topic, "essentials");
  assert.equal(h.policy.questionsAsked, 1);

  // Held items expire.
  h.at(20000 + 2 * 3600_000 + 1);
  assert.equal(h.policy.heldForReview().length, 0);

  // Ten minutes later a new question fits the window again.
  h.see(h.feed.email(h.now(), C, { bodyText: bodyFor(ORD), previewState: "preview" }));
  h.at(h.now() + 3000);
  assert.equal(asks(h.policy.tick()).length, 1);
});

test("cooldown after a question, and only one question open at a time", () => {
  const h = harness();
  learnUntilRemoval(h);
  h.at(3000);
  const first = must(asks(h.policy.tick())[0]);
  // A second candidate appears while the first question is still open.
  h.see(h.feed.email(3500, C, { bodyText: bodyFor(ORD) }));
  h.at(8000);
  const open = must(h.policy.tick().find((d) => d.decision === "DEFER"));
  assert.ok(open.reasons.includes("question_open"));
  h.policy.finishQuestion(must(first.question).id, 9000);
  h.at(10000);
  const cool = must(h.policy.tick().find((d) => d.decision === "DEFER"));
  assert.deepEqual(cool.reasons, ["cooldown"]);
  assert.equal(cool.budget.cooldownLeftMs, 4000);
  h.at(14000);
  assert.equal(asks(h.policy.tick()).length, 1);
});

test("a question that was never spoken does not count and goes back to the queue", () => {
  const h = harness({ budget: 1 });
  learnUntilRemoval(h);
  h.at(3000);
  const q = must(must(asks(h.policy.tick())[0]).question);
  assert.equal(h.policy.questionsAsked, 1);
  h.policy.cancelQuestion(q.id);
  assert.equal(h.policy.questionsAsked, 0);
  assert.ok(h.policy.log.some((d) => d.reasons.includes("cancelled")));
  h.at(9000);
  assert.equal(asks(h.policy.tick()).length, 1, "asked again at the next pause");
});

test("ranking: of two candidates at the same pause, the guardrail question comes before the detail question", () => {
  const h = harness();
  learnUntilRemoval(h, 500);
  h.at(600);
  h.see(h.feed.typing(600, 600));
  h.see(h.feed.email(700, C, { bodyText: bodyFor(ORD) }));
  h.see(h.feed.email(900, C, { bodyText: bodyFor(ORD), previewState: "preview" }));
  h.at(6000);
  const out = h.policy.tick();
  assert.equal(must(asks(out)[0]).topic, "guardrail");
  const next = h.policy;
  next.finishQuestion(must(must(asks(out)[0]).question).id, 7000);
  h.at(13000);
  assert.equal(must(asks(next.tick())[0]).topic, "reason");
});

test("duplicate topics and answers already in the map are skipped, with the reason logged", async () => {
  // Duplicate: the reason for customer_07 was asked once; a recipient change is the same topic.
  let h = harness();
  learnUntilRemoval(h);
  h.at(3000);
  const q = must(must(asks(h.policy.tick())[0]).question);
  h.policy.finishQuestion(q.id, 4000);
  h.see(h.feed.email(5000, C, { recipientRef: "contact_other" }));
  h.at(12000);
  const out = h.policy.tick();
  assert.equal(asks(out).length, 0);
  assert.deepEqual(must(out.find((d) => d.decision === "SKIP")).reasons, ["duplicate_topic"]);

  // Answered in the map: a map that already holds the reason for customer_07.
  h = harness();
  h.policy.setMap(workingMap(await buildState({ answers: ["reason"], followUps: false, confirm: false })));
  learnUntilRemoval(h);
  h.at(3000);
  const skipped = h.policy.tick();
  assert.equal(asks(skipped).length, 0);
  assert.deepEqual(must(skipped.find((d) => d.decision === "SKIP")).reasons, ["answered_in_map"]);
});

test("routine changes are skipped, and stale candidates are dropped", () => {
  const h = harness();
  h.see(h.feed.order(0, ORD));
  h.see(h.feed.email(0, C));
  h.at(500);
  h.see(h.feed.email(500, C, { attachments: [IMAGE] }));
  h.see(h.feed.ticket(600, C, "done"));
  const kinds = h.policy.log.filter((d) => d.decision === "SKIP").map((d) => d.reasons.join());
  assert.deepEqual(kinds, ["visible_on_screen", "visible_on_screen"]);

  // A candidate that never found a pause within 30 s is dropped.
  const g = harness({ maxAgeMs: 30000 });
  learnUntilRemoval(g);
  g.policy.humanSpeech(true);
  g.at(40000);
  const out = g.policy.tick();
  assert.deepEqual(must(out.find((d) => d.decision === "SKIP")).reasons, ["stale"]);
});

test("off the record: nothing is observed or asked, an open question is cancelled, and the gap is no baseline", () => {
  const h = harness();
  learnUntilRemoval(h);
  h.at(2000);
  h.policy.setOffRecord(true);
  assert.deepEqual(must(h.policy.log.at(-1)).reasons, ["off_record"], "the pending candidate was dropped");
  h.at(3000);
  assert.equal(h.policy.tick().length, 0);
  h.see(h.feed.email(3000, C, { attachments: [IMAGE] })); // ignored while off the record
  h.at(10000);
  h.policy.setOffRecord(false);
  // The first draft after the gap is a new baseline: removing the image is not attributed across it.
  h.see(h.feed.email(10000, C));
  h.at(20000);
  assert.equal(asks(h.policy.tick()).length, 0);
  assert.equal(h.policy.candidates.filter((c) => c.state === "pending").length, 0);
});

test("every decision is logged with its reasons, the four quiet channels, evidence, why now and the budget, and survives JSON", () => {
  const h = harness();
  const decisions: BrainDecision[] = [];
  const p = new ConversationPolicy({ now: h.now, onDecision: (d) => decisions.push(d) });
  const removal = learnUntilRemoval({ ...h, policy: p, see: (o) => p.observe(o) });
  h.at(1500);
  p.observe(h.feed.typing(1500, 1500));
  p.tick();
  h.at(7000);
  p.tick();
  assert.ok(decisions.length >= 2);
  assert.deepEqual(decisions, p.log);
  for (const d of p.log) {
    assert.ok(d.reasons.length > 0, "reasons");
    assert.ok(d.whyNow.length > 10, "whyNow");
    assert.ok(typeof d.quiet.natural === "boolean" && "input" in d.quiet.channels && "screen" in d.quiet.channels && "human" in d.quiet.channels && "agent" in d.quiet.channels);
    assert.ok(Array.isArray(d.evidenceIds));
    assert.ok(d.budget.max >= 1);
    assert.equal(d.mode, "learn");
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d, "JSON-safe (no Infinity or undefined)");
  }
  const ask = must(asks(p.log)[0]);
  assert.deepEqual(ask.evidenceIds, removal.evidenceIds);
  assert.match(ask.whyNow, /attachment was removed/);
  assert.deepEqual(p.log.map((d) => d.seq), p.log.map((_, i) => i + 1));
});

test("Teach: WARN bypasses budget and cooldown; clear stays quiet; off the record and other modes do not warn", () => {
  const h = harness({ mode: "teach", budget: 0, cooldownMs: 3_600_000 });
  const warn = h.policy.decideCheckpoint({ status: "warn", evidenceIds: ["ev-1"] });
  assert.equal(warn.decision, "WARN");
  assert.deepEqual(warn.reasons, ["checkpoint_warn", "bypass_budget", "bypass_cooldown"]);
  assert.deepEqual(warn.evidenceIds, ["ev-1"]);
  assert.equal(warn.deliver, "now");
  assert.equal(h.policy.decideCheckpoint({ status: "unknown", evidenceIds: [] }).decision, "WARN");
  assert.equal(h.policy.decideCheckpoint({ status: "clear", evidenceIds: [] }).decision, "SKIP");

  // Speech in progress: still a WARN, queued behind it.
  h.policy.humanSpeech(true);
  assert.equal(h.policy.decideCheckpoint({ status: "warn", evidenceIds: [] }).deliver, "after_speech");
  h.policy.humanSpeech(false);
  h.policy.setOffRecord(true);
  assert.deepEqual(h.policy.decideCheckpoint({ status: "warn", evidenceIds: [] }).reasons, ["off_record"]);

  // The same budget would stop a Learn question.
  const learn = harness({ budget: 0 });
  learnUntilRemoval(learn);
  learn.at(3000);
  assert.deepEqual(must(learn.policy.tick().find((d) => d.decision === "DEFER")).reasons, ["budget"]);
  assert.equal(learn.policy.decideCheckpoint({ status: "warn", evidenceIds: [] }).decision, "SKIP");
});

async function teachHarness(persona: PersonaId = "plain") {
  const h = harness({ mode: "teach", persona });
  const map: WorkMap = must(latestConfirmed(await buildState({ correction: true })));
  h.policy.setMap(map);
  return { ...h, map };
}

test("Teach: PREDICT at a decision point of the map, quietly, once per order; nothing to predict where the map is silent", async () => {
  const h = await teachHarness();
  h.see(h.feed.order(0, order("ORD-2057")));
  h.at(1000);
  const early = h.policy.tick();
  assert.equal(early.filter((d) => d.decision === "PREDICT").length, 0);
  assert.ok(must(early.find((d) => d.decision === "DEFER")).reasons.includes("screen_not_stable"));
  h.at(2100);
  const out = h.policy.tick();
  const predict = must(out.find((d) => d.decision === "PREDICT"));
  assert.deepEqual(predict.reasons, ["natural_pause", "bypass_budget"]);
  assert.equal(predict.prediction?.expect, "write_out");
  assert.ok(predict.evidenceIds.length > 0, "points at the expert's moment");
  assert.equal(predict.topic, "predict_next");
  assert.equal(predict.utterance?.text, predict.prediction?.question);
  assert.equal(predict.mode, "teach");

  // The same order again, or while the question is open, adds nothing.
  h.see(h.feed.order(2200, order("ORD-2057")));
  h.at(9000);
  assert.equal(h.policy.tick().filter((d) => d.decision === "PREDICT").length, 0);

  // Another customer: the map has nothing to decide.
  h.see(h.feed.order(9500, order("ORD-1902")));
  h.at(12000);
  assert.deepEqual(must(h.policy.tick().find((d) => d.decision === "SKIP")).reasons, ["no_decision_point"]);

  // An unrecognised customer is a decision point too: do not guess.
  h.policy.finishQuestion(must(predict.questionId));
  h.see(h.feed.order(13000, order("ORD-4410")));
  h.at(15500);
  const unknown = must(h.policy.tick().find((d) => d.decision === "PREDICT"));
  assert.equal(unknown.prediction?.expect, "ask");
});

test("Teach: PREDICT waits while the new hire types or speaks; the quiet persona predicts only before Send", async () => {
  const h = await teachHarness();
  h.see(h.feed.order(0, order("ORD-2057")));
  h.at(2500);
  h.see(h.feed.typing(2500, 2500));
  h.at(3000);
  assert.ok(must(h.policy.tick().find((d) => d.decision === "DEFER")).reasons.includes("typing"));
  h.at(5600);
  assert.equal(h.policy.tick().filter((d) => d.decision === "PREDICT").length, 1);

  const q = await teachHarness("quiet");
  q.see(q.feed.order(0, order("ORD-2057")));
  q.at(8000);
  assert.deepEqual(must(q.policy.tick().find((d) => d.decision === "SKIP")).reasons, ["persona_predicts_before_send"]);
});

test("question text comes from topic templates within the persona's word limit and never states a rule", () => {
  for (const id of PERSONA_IDS) {
    const persona = PERSONAS[id];
    const h = harness({ persona: id });
    learnUntilRemoval(h);
    h.at(persona.screenStableMs + persona.inputPauseMs + 1100);
    const q = must(must(asks(h.policy.tick())[0]).question);
    assert.ok(q.text.split(/\s+/).length <= persona.maxWords, `${id}: ${q.text}`);
    assert.equal(q.topic, "reason");
    assert.ok(q.evidenceIds.length > 0);
    const decision = must(h.policy.log.find((d) => d.decision === "ASK_NOW"));
    assert.deepEqual(decision.utterance?.delivery, persona.deliveryTags);
    assert.equal(decision.utterance?.maxWords, persona.maxWords);
  }
  for (const kind of ["attachment_removed", "body_text_added", "recipient_changed", "preview_opened"] as const) {
    const variants = learnVariants(kind, { entityRef: C, orderId: "ORD-2041", detail: "image" });
    assert.ok(variants.length >= 3);
    assert.ok(must(variants.at(-1)).split(/\s+/).length <= PERSONAS.quiet.maxWords, `${kind} has a short variant`);
    for (let i = 1; i < variants.length; i++) assert.ok(must(variants[i]).length <= must(variants[i - 1]).length, `${kind}: longest first`);
  }
  assert.equal(formatAskLine({ text: "Why?", delivery: ["warmly", "curious"], maxWords: 18 }), "[ASK] [warmly] [curious] Why?");
  assert.equal(formatAskLine({ text: "Why?", delivery: [], maxWords: 10 }), "[ASK] Why?");
});
