// The whole loop on a fake clock: the scripted expert works (Learn), is asked at pauses, answers; Review closes the gaps
// and the expert corrects and confirms the teach-back; the tutor then handles the new cases T1-T6 and the new hire's
// predictions. Nothing about the customer_07 rule is written in the agent code: it all comes from the expert's answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationPolicy,
  HeuristicAnswerExtractor,
  applyTeachBackReply,
  buildPrediction,
  buildTeachBack,
  checkpoint,
  evaluatePrediction,
  latestConfirmed,
  planFollowUps,
  reduceMap,
  reviewStatus,
  summarizeMastery,
  workingMap,
} from "../src/index.ts";
import type { CaseOutcome } from "../src/index.ts";
import { arr, buildState, expected, expertAnswer, expertTeachback, novicePredict, readJson, rec, startLearnSession, str, teachCase } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();

test("Learn: at least three questions, each at a natural pause and about something on screen, one about a guardrail; never while typing", async () => {
  const session = startLearnSession();
  await session.run(60_000);

  const asked = session.questions;
  assert.ok(asked.length >= 3, `${asked.length} questions`);
  assert.ok(asked.length <= 4, "within the Plain budget");
  assert.deepEqual(asked.map((a) => a.question.topic), ["reason", "essentials", "guardrail"]);
  for (const { question } of asked) assert.ok(question.evidenceIds.length > 0, "about a screen moment");

  const decisions = session.decisions().filter((d) => d.decision === "ASK_NOW");
  assert.equal(decisions.length, asked.length);
  for (const d of decisions) {
    assert.equal(d.quiet.natural, true, `${d.whyNow}`);
    assert.deepEqual(d.quiet.channels, { input: true, screen: true, human: true, agent: true });
  }
  // The expert types 13-17 s (heartbeats until 19 s): no question was asked in between.
  for (const { askedAtMs } of asked) assert.ok(askedAtMs < 13000 || askedAtMs >= 20000, `asked at ${askedAtMs}`);
  // And the typing was noticed: questions were deferred, with the reason logged.
  assert.ok(session.decisions().some((d) => d.decision === "DEFER" && d.reasons.includes("typing")));

  // Questions are asked one at a time: nothing is asked while Clipa or the expert is speaking.
  for (let i = 1; i < asked.length; i++) assert.ok(must(asked[i]).askedAtMs - must(asked[i - 1]).askedAtMs >= 5500 + 5000, "answer plus cooldown in between");

  const map = workingMap(session.state());
  assert.ok(map.guardrails.some((g) => g.trigger === "customer" && g.reason !== null));
  assert.ok(map.guardrails.some((g) => g.trigger === "unknown_entity"));
  assert.ok(map.steps.filter((s) => s.decision?.quote).length >= 3);
});

test("Learn -> Review -> Teach: the tutor applies the rule the expert stated, and only that rule", async () => {
  const session = startLearnSession();
  await session.run(60_000);
  let state = session.state();

  // Review: at least three follow-ups the task did not answer.
  const followUps = planFollowUps(workingMap(state));
  assert.ok(followUps.length >= 3, `${followUps.length} follow-ups`);
  for (const q of followUps) {
    const extraction = await extractor.extract({ topic: q.topic, text: expertAnswer(q.topic), questionId: q.id, atMs: 70_000, evidenceIds: q.evidenceIds, targetId: q.targetId, entityRef: q.entityRef });
    state = reduceMap(state, { type: "answer", extraction });
  }
  assert.equal(reviewStatus(state).openFollowUps.length, 0);

  // The teach-back, the correction, the second teach-back and the confirmation.
  const first = buildTeachBack(workingMap(state));
  assert.match(first.text, /delivery address and delivery window/);
  assert.doesNotMatch(first.text, /order number/);
  const corrected = await applyTeachBackReply(state, { text: expertTeachback("correction"), atMs: 90_000 }, extractor);
  assert.equal(corrected.outcome, "corrected");
  assert.match(corrected.teachBack?.text ?? "", /order number, delivery address and delivery window/);
  const confirmed = await applyTeachBackReply(corrected.state, { text: expertTeachback("confirm"), atMs: 100_000 }, extractor);
  assert.equal(confirmed.outcome, "confirmed");
  state = confirmed.state;
  assert.equal(reviewStatus(state).done, true);
  const map = must(latestConfirmed(state));
  assert.equal(map.version, 2);

  // Teach: every new case as in fixtures/agent/expected.
  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
    const c = teachCase(id);
    const want = expected(id);
    const got = checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
    assert.equal(got.status, want.status, id);
    assert.deepEqual(got.missingFacts, want.missingFacts, id);
    assert.equal(got.mapVersion, want.mapVersion, id);
    const warn = new ConversationPolicy({ mode: "teach", now: () => 0 }).decideCheckpoint(got);
    assert.equal(warn.decision, want.policy, id);
  }
});

test("Teach: the new hire predicts, is stopped before Send where the map says so, and gets a mastery summary", async () => {
  const map = must(latestConfirmed(await buildState({ correction: true })));
  const cases = arr(rec(readJson("sim/novice-script.json")).cases).map(rec);
  const outcomes: CaseOutcome[] = [];
  for (const nc of cases) {
    const id = str(nc.case);
    const c = teachCase(id);
    const ord = c.order.kind === "order_view" ? c.order.facts : null;
    assert.ok(ord);

    // The policy decides whether to ask for a prediction at all.
    const policy = new ConversationPolicy({ mode: "teach", now: () => 5000 });
    policy.setMap(map);
    policy.observe(c.order);
    const predict = policy.tick(5000).find((d) => d.decision === "PREDICT");
    const prediction = buildPrediction(ord, map);
    assert.equal(predict !== undefined, prediction.expect !== "usual", `${id}: PREDICT exactly where the map has a decision`);
    const verdict = evaluatePrediction(prediction, novicePredict(id)).verdict;

    const got = checkpoint({ checkpoint: c.checkpoint, observations: c.observations, map });
    outcomes.push({ caseId: id, title: c.title, verdict, firstStatus: got.status, sent: str(nc.onStop) === "send" });
  }
  const mastery = summarizeMastery(outcomes);
  // t1 (image only) and t5 (missing order number) needed the stop; t6 predicted "just send" about a habit nobody could explain.
  assert.deepEqual(mastery.practise.sort(), ["t1", "t5", "t6"]);
  assert.deepEqual(mastery.mastered.sort(), ["t2", "t3", "t4"]);
});

test("the Learn session is replayable: the same observations and answers give the same map", async () => {
  const a = startLearnSession();
  await a.run(60_000);
  const b = startLearnSession();
  await b.run(60_000);
  assert.deepEqual(a.state(), b.state());
  assert.deepEqual(a.decisions().map((d) => [d.decision, d.atMs, d.reasons]), b.decisions().map((d) => [d.decision, d.atMs, d.reasons]));
});
