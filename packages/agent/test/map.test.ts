import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeuristicAnswerExtractor,
  MapConfirmationError,
  MapValidationError,
  createMapState,
  latestConfirmed,
  reduceMap,
  replayMap,
  validateWorkMap,
  workingMap,
} from "../src/index.ts";
import type { AnswerExtraction, MapEvent, WorkMap } from "../src/index.ts";
import { Feed, buildState, expertAnswer, learnObservations, order, confirmAfterTeachBack } from "./brain-helpers.ts";
import { must } from "./helpers.ts";

const extractor = new HeuristicAnswerExtractor();

function assertDeepFrozen(value: unknown, path = "value"): void {
  if (typeof value !== "object" || value === null) return;
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [k, v] of Object.entries(value)) assertDeepFrozen(v, `${path}.${k}`);
}

async function answer(topic: AnswerExtraction["topic"], text: string, over: Partial<AnswerExtraction> = {}): Promise<AnswerExtraction> {
  const x = await extractor.extract({ topic, text, questionId: "q-test", atMs: 50000, evidenceIds: ["ev-x"], targetId: null, entityRef: "customer_07" });
  return { ...x, ...over };
}

test("steps link to evidence; judgment calls carry the expert's quote", async () => {
  const map = workingMap(await buildState({ followUps: false, confirm: false }));
  assert.ok(map.steps.length >= 7, `${map.steps.length} steps`);
  for (const s of map.steps) assert.ok(s.evidenceIds.length > 0, `${s.id} has evidence`);
  const judged = map.steps.filter((s) => s.kind === "judgment" && s.decision?.quote);
  assert.ok(judged.length >= 3, `${judged.length} judgment calls`);
  for (const s of judged) assert.ok(s.evidenceIds.length > 0 && (s.decision?.evidenceIds.length ?? 0) > 0 && s.decision?.quote);
  const removal = map.steps.find((s) => s.action.startsWith("Removed"));
  assert.equal(removal?.decision?.reason, "his phone blocks pictures in our emails");
  assert.ok(removal?.decision?.quote?.includes("because"));
});

test("a guardrail comes only from answers; scope defaults to the named customer; the reason is the expert's clause", async () => {
  assert.equal(workingMap(await buildState({ answers: [], confirm: false, followUps: false })).guardrails.length, 0);

  const map = workingMap(await buildState({ answers: ["reason", "essentials", "guardrail"], followUps: false, confirm: false }));
  const g = must(map.guardrails.find((x) => x.trigger === "customer"));
  assert.deepEqual(g.scope, { kind: "customers", customers: ["customer_07"], explicit: false });
  assert.deepEqual(g.requiredFacts, ["deliveryAddress", "deliveryWindow"]);
  assert.equal(g.reason, "his phone blocks pictures in our emails");
  assert.equal(g.quote, `${expertAnswer("reason").split(". ")[0]}.`);
  assert.ok(g.quoteAtMs !== null);
  assert.ok(g.evidenceIds.length >= 2);
  assert.match(g.condition, /customer_07/);
  assert.ok(g.unknowns.some((u) => /Scope not stated/.test(u)), "scope is listed as an open point");
  const stop = must(map.guardrails.find((x) => x.trigger === "unknown_entity"));
  assert.equal(stop.escalateTo, "the account manager");
  assert.equal(stop.status, "proposed");
  assert.ok(stop.evidenceIds.length > 0 && stop.quote);
});

test("follow-up answers fill scope, exceptions, the stop reason and duration; an unexplained habit stays unconfirmed", async () => {
  const map = must(latestConfirmed(await buildState({ correction: true })));
  const g = must(map.guardrails.find((x) => x.trigger === "customer" && !x.unexplained));
  assert.equal(g.scope.explicit, true);
  assert.deepEqual(g.scope.customers, ["customer_07"]);
  assert.equal(g.scopeQuote, "Only for him.");
  assert.equal(g.exceptions.length, 1);
  assert.ok(g.duration);
  assert.equal(g.status, "confirmed");
  const habit = must(map.guardrails.find((x) => x.unexplained));
  assert.deepEqual(habit.scope.customers, ["customer_09"]);
  assert.equal(habit.reason, null);
  assert.equal(habit.status, "proposed");
  assert.equal(map.guardrails.find((x) => x.trigger === "unknown_entity")?.status, "confirmed");
  assert.deepEqual(validateWorkMap(map), []);
});

test("the reducer is pure and deterministic: it never changes its input and replays to the same state", async () => {
  const run = learnObservations();
  const events: MapEvent[] = run.all.map((observation) => ({ type: "observation", observation }));
  events.push({ type: "answer", extraction: await answer("reason", expertAnswer("reason"), { evidenceIds: [...run.removal.evidenceIds] }) });
  const s0 = createMapState();
  const before = JSON.stringify(s0);
  const s1 = reduceMap(s0, must(events[0]));
  assert.equal(JSON.stringify(s0), before, "the input state is untouched");
  assert.notEqual(s1, s0);
  assertDeepFrozen(s1);
  assert.equal(JSON.stringify(replayMap(events)), JSON.stringify(replayMap(events)));
  // Replaying is the same as reducing step by step.
  let stepwise = createMapState();
  for (const e of events) stepwise = reduceMap(stepwise, e);
  assert.deepEqual(stepwise, replayMap(events));
});

test("repeated identical observations change nothing", () => {
  const run = learnObservations();
  let state = createMapState();
  for (const o of run.all) state = reduceMap(state, { type: "observation", observation: o });
  const steps = workingMap(state).steps.length;
  const again = reduceMap(reduceMap(state, { type: "observation", observation: must(run.all[0]) }), { type: "observation", observation: must(run.all.at(-1)) });
  assert.equal(workingMap(again).steps.length, steps);
  const feed = new Feed("sess-rep", 500);
  const o = order("ORD-2041");
  let s2 = reduceMap(createMapState(), { type: "observation", observation: feed.order(0, o) });
  s2 = reduceMap(s2, { type: "observation", observation: feed.order(1000, o) });
  assert.equal(workingMap(s2).steps.length, 1, "the same order seen twice is one step");
});

test("a correction seals the draft as an immutable superseded version and opens the next; a confirmation seals a confirmed one", async () => {
  const state = await buildState({ correction: true });
  assert.equal(state.versions.length, 2);
  const [v1, v2] = state.versions as [WorkMap, WorkMap];
  assertDeepFrozen(v1, "v1");
  assertDeepFrozen(v2, "v2");
  assert.equal(v1.version, 1);
  assert.equal(v1.status, "superseded");
  assert.equal(v1.confirmed, false);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, "confirmed");
  assert.equal(v2.confirmed, true);
  assert.match(v2.confirmation?.quote ?? "", /right/i);
  assert.deepEqual(must(v1.guardrails.find((g) => g.id === "g1")).requiredFacts, ["deliveryAddress", "deliveryWindow"]);
  assert.deepEqual(must(v2.guardrails.find((g) => g.id === "g1")).requiredFacts, ["orderId", "deliveryAddress", "deliveryWindow"]);
  assert.equal(latestConfirmed(state), v2);

  // Confirming again with nothing changed is a no-op.
  assert.equal(confirmAfterTeachBack(state, 99000, "Yes."), state);

  // New information after the confirmation: the next confirmation is a new version; the old ones are untouched.
  const later = reduceMap(state, { type: "answer", extraction: await answer("exception", "Yes, a second attachment is fine too.", { targetId: "g1" }) });
  const reconfirmed = confirmAfterTeachBack(later, 100000, "Yes.");
  assert.equal(reconfirmed.versions.length, 3);
  assert.equal(must(latestConfirmed(reconfirmed)).version, 3);
  assert.deepEqual(reconfirmed.versions[1], v2);
  assert.equal(must(reconfirmed.versions[1]).guardrails.find((g) => g.id === "g1")?.exceptions.length, 1);
  assert.equal(must(reconfirmed.versions[2]).guardrails.find((g) => g.id === "g1")?.exceptions.length, 2);
});

test("a correction that changes the reason or the scope is applied and leaves the earlier version as it was", async () => {
  const state = await buildState({ confirm: false });
  const corrected = reduceMap(state, {
    type: "correct",
    extraction: await answer("correction", "One correction: it is because of his IT policy, and it holds for all customers.", { entityRef: null }),
  });
  const draft = workingMap(corrected);
  const g = must(draft.guardrails.find((x) => x.id === "g1"));
  assert.equal(g.reason, "of his IT policy, and it holds for all customers");
  assert.equal(g.scope.kind, "all");
  assert.equal(must(corrected.versions[0]).guardrails.find((x) => x.id === "g1")?.scope.kind, "customers");
});

test("the map refuses to confirm an item that has no evidence id or no quote", async () => {
  let state = createMapState();
  state = reduceMap(state, { type: "answer", extraction: await answer("reason", expertAnswer("reason"), { evidenceIds: [] }) });
  assert.throws(
    () => confirmAfterTeachBack(state, 1, "Yes."),
    (e: unknown) => e instanceof MapConfirmationError && e.confirmIssues.some((i) => i.kind === "guardrail" && i.missing.includes("evidence")),
  );
  // The refusal leaves the state untouched and nothing is sealed.
  assert.equal(state.versions.length, 0);

  // With one evidence id and the quote it goes through.
  const ok = reduceMap(createMapState(), { type: "answer", extraction: await answer("reason", expertAnswer("reason"), { evidenceIds: ["ev-1"] }) });
  assert.equal(must(latestConfirmed(confirmAfterTeachBack(ok, 1, "Yes."))).guardrails[0]?.status, "confirmed");

  // A confirmed map that carries an item without evidence or quote is invalid however it got there.
  const good = must(latestConfirmed(await buildState({ correction: true })));
  const g = must(good.guardrails[0]);
  const bad: WorkMap = { ...good, guardrails: [{ ...g, quote: null, evidenceIds: [] }, ...good.guardrails.slice(1)] };
  assert.deepEqual(validateWorkMap(bad), [`confirmed guardrail ${g.id} lacks evidence and quote`]);
});

test("a confirmed decision step without evidence or quote makes the map invalid", async () => {
  const good = must(latestConfirmed(await buildState({ correction: true })));
  const step = must(good.steps.find((s) => s.status === "confirmed" && s.decision !== null));
  const bad: WorkMap = {
    ...good,
    steps: good.steps.map((s) => (s.id === step.id ? { ...s, decision: s.decision && { ...s.decision, evidenceIds: [], quote: null } } : s)),
  };
  assert.deepEqual(validateWorkMap(bad), [`confirmed step ${step.id} lacks evidence and quote`]);
  assert.deepEqual(validateWorkMap(good), []);
});

test("an extraction whose quote is not the expert's own words is refused", async () => {
  const x = await answer("reason", expertAnswer("reason"), { quote: "He told me his phone cannot show images." });
  assert.throws(() => reduceMap(createMapState(), { type: "answer", extraction: x }), MapValidationError);
  const empty = await answer("reason", expertAnswer("reason"), { quote: "  " });
  assert.throws(() => reduceMap(createMapState(), { type: "answer", extraction: empty }), MapValidationError);
  const correctionAsAnswer = await answer("correction", "Almost.");
  assert.throws(() => reduceMap(createMapState(), { type: "answer", extraction: correctionAsAnswer }), MapValidationError);
  // A refused correction leaves the version history alone.
  const state = await buildState({ confirm: false });
  assert.throws(() => reduceMap(state, { type: "correct", extraction: { ...empty, topic: "correction" } }), MapValidationError);
});

test("another stop-and-ask condition is recorded on the map as a stop_condition guardrail, once", async () => {
  const text = "If the amount is above the limit, I stop and ask the finance lead first.";
  let state = createMapState();
  for (let i = 0; i < 2; i++) {
    state = reduceMap(state, { type: "answer", extraction: await answer("guardrail", text, { entityRef: null }) });
  }
  const g = workingMap(state).guardrails;
  assert.equal(g.length, 1);
  assert.equal(g[0]?.trigger, "stop_condition");
  assert.equal(g[0]?.escalateTo, "the finance lead");
  assert.match(g[0]?.requiredAction ?? "", /Stop and ask the finance lead/);
});
