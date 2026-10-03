import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_MARKER,
  InMemoryKnowledgeStore,
  SPEAKERS,
  attributeMarkerTurns,
  validateCoachCommand,
  validateGuardrail,
  validateMapVersion,
  validateQuestionCandidate,
  validateSessionState,
  validateUtterance,
  validateWorkStep,
} from "../src/schema.ts";
import type {
  EntityScope,
  Guardrail,
  MapVersion,
  QuestionCandidate,
  SessionState,
  TranscriptTurn,
  Utterance,
  WorkStep,
} from "../src/schema.ts";
import { must } from "./helpers.ts";

const scope: EntityScope = { kind: "customer", refs: ["customer_07"] };

function utterance(over: Partial<Utterance> = {}): Utterance {
  return { id: "u1", sessionId: "s1", speaker: "expert", text: "Customer 07 asked for text.", startMs: 4000, endMs: 6000, final: true, ...over };
}

function guardrail(over: Partial<Guardrail> = {}): Guardrail {
  return {
    id: "g1",
    condition: "customer_07 order email contains only an image",
    requiredAction: "add the essential data as text",
    exceptions: ["image plus full text is fine"],
    scope,
    rationale: "customer_07 asked for the data as text",
    evidenceIds: ["ev-clip-template-replaced"],
    utteranceIds: ["u1"],
    status: "confirmed",
    version: 1,
    ...over,
  };
}

function step(over: Partial<WorkStep> = {}): WorkStep {
  return {
    id: "st1",
    goal: "Send delivery details",
    action: "Type address and window into the email body",
    conditions: ["customer_07"],
    rationale: "Customer asked for text",
    guardrailIds: ["g1"],
    evidenceIds: ["ev-f-0001"],
    utteranceIds: ["u1"],
    status: "confirmed",
    entityScope: scope,
    environment: "demo-workspace/email",
    alternatives: [],
    unknowns: ["Is an extra image still fine?"],
    ...over,
  };
}

function map(over: Partial<MapVersion> = {}): MapVersion {
  return { id: "m1", workMapId: "wm-customer07", sessionId: "s1", version: 1, createdAtMs: 30000, reason: "live", steps: [step()], guardrails: [guardrail()], gaps: [], ...over };
}

function question(over: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return {
    id: "q1",
    sessionId: "s1",
    kind: "why",
    text: "Why did you type the address instead of attaching the template image?",
    createdAtMs: 14000,
    triggerObservationIds: ["obs-007"],
    evidenceIds: ["ev-clip-template-replaced"],
    priority: 5,
    status: "candidate",
    decision: null,
    decisionReason: null,
    spokenAtMs: null,
    answerUtteranceIds: [],
    ...over,
  };
}

function session(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s1",
    sessionEpochMs: 1_000_000,
    mode: "learn",
    offRecord: false,
    screen: { schemaVersion: 1, sessionId: "s1", state: "capturing" },
    coordinator: { phase: "listening", speakingCommandId: null, lastActivityMs: null, recentQuestionIds: [] },
    workMapId: null,
    latestMapVersion: null,
    error: null,
    ...over,
  };
}

test("valid samples pass", () => {
  assert.equal(validateUtterance(utterance()).ok, true);
  assert.equal(validateUtterance(utterance({ endMs: null, final: false })).ok, true);
  assert.equal(validateGuardrail(guardrail()).ok, true);
  assert.equal(validateWorkStep(step()).ok, true);
  assert.equal(validateMapVersion(map()).ok, true);
  assert.equal(validateQuestionCandidate(question()).ok, true);
  assert.equal(validateSessionState(session()).ok, true);
  assert.equal(
    validateCoachCommand({ id: "c1", sessionId: "s1", kind: "ask", text: "Why?", questionId: "q1", evidenceIds: [], issuedAtMs: 1 }).ok,
    true,
  );
});

test("a confirmed step or guardrail needs a quote and a screen moment; observation alone is not a rule", () => {
  assert.equal(validateWorkStep(step({ evidenceIds: [] })).ok, false);
  assert.equal(validateWorkStep(step({ status: "inferred", evidenceIds: [], utteranceIds: [] })).ok, true);
  assert.equal(validateGuardrail(guardrail({ evidenceIds: [] })).ok, false);
  assert.equal(validateGuardrail(guardrail({ evidenceIds: [], status: "proposed" })).ok, true);
  assert.equal(validateWorkStep(step({ rationale: null })).ok, false);
  assert.equal(validateWorkStep(step({ utteranceIds: [] })).ok, false);
  assert.equal(validateWorkStep(step({ status: "observed", rationale: null, utteranceIds: [] })).ok, true);
  assert.equal(validateGuardrail(guardrail({ utteranceIds: [] })).ok, false);
  assert.equal(validateGuardrail(guardrail({ utteranceIds: [], status: "proposed" })).ok, true);
});

test("scope: customer scope needs refs, 'any' does not", () => {
  assert.equal(validateGuardrail(guardrail({ scope: { kind: "customer", refs: [] } })).ok, false);
  assert.equal(validateGuardrail(guardrail({ scope: { kind: "any", refs: [] } })).ok, true);
  assert.equal(validateGuardrail(guardrail({ scope: { kind: "everyone" as never, refs: [] } })).ok, false);
});

test("map rejects steps that reference a missing guardrail and bad versions", () => {
  const r = validateMapVersion(map({ guardrails: [] }));
  assert.ok(!r.ok && must(r.errors[0]).includes("unknown guardrail g1"));
  assert.equal(validateMapVersion(map({ version: 0 })).ok, false);
  assert.equal(validateMapVersion(map({ reason: "magic" as never })).ok, false);
});

test("a map version needs a workMapId (identity independent of the session)", () => {
  const noId: Record<string, unknown> = { ...map() };
  delete noId.workMapId;
  assert.equal(validateMapVersion(noId).ok, false);
  assert.equal(validateMapVersion(map({ workMapId: "" })).ok, false);
  assert.equal(validateSessionState(session({ workMapId: "wm-customer07" })).ok, true);
  assert.equal(validateSessionState(session({ workMapId: "" })).ok, false);
});

test("speaker roles are expert, agent and novice; utterance source is transcript or harness", () => {
  assert.deepEqual([...SPEAKERS], ["expert", "agent", "novice"]);
  assert.equal(validateUtterance(utterance({ speaker: "novice" })).ok, true);
  assert.equal(validateUtterance(utterance({ speaker: "agent", source: "harness" })).ok, true);
  assert.equal(validateUtterance(utterance({ speaker: "agent", source: "magic" as never })).ok, false);
  assert.equal(validateUtterance(utterance({ speaker: "tutor" as never })).ok, false);
});

test("a question counts as asked only when it was actually spoken", () => {
  assert.equal(validateQuestionCandidate(question({ status: "asked", decision: "ASK_NOW" })).ok, false);
  assert.equal(validateQuestionCandidate(question({ status: "asked", decision: "ASK_NOW", spokenAtMs: 15000 })).ok, true);
  assert.equal(validateQuestionCandidate(question({ decision: "BLOCK" as never })).ok, false);
  assert.equal(validateQuestionCandidate(question({ decision: "WARN" })).ok, true);
});

test("session state validates nested screen status and coordinator phase", () => {
  assert.equal(validateSessionState(session({ screen: null })).ok, true);
  assert.equal(validateSessionState(session({ screen: { schemaVersion: 1, sessionId: "s1", state: "bogus" as never } })).ok, false);
  assert.equal(
    validateSessionState(session({ coordinator: { phase: "dreaming" as never, speakingCommandId: null, lastActivityMs: null, recentQuestionIds: [] } })).ok,
    false,
  );
});

test("store: utterances upsert and sort, returned objects are copies", async () => {
  const store = new InMemoryKnowledgeStore();
  await store.saveUtterance(utterance({ id: "u2", startMs: 9000, endMs: 10000, text: "later" }));
  await store.saveUtterance(utterance({ id: "u1", startMs: 4000, final: false, endMs: null, text: "Customer" }));
  await store.saveUtterance(utterance({ id: "u1", startMs: 4000 })); // final replaces interim
  const list = await store.listUtterances("s1");
  assert.deepEqual(list.map((u) => u.id), ["u1", "u2"]);
  assert.equal(must(list[0]).final, true);
  must(list[0]).text = "mutated";
  assert.equal(must((await store.listUtterances("s1"))[0]).text, "Customer 07 asked for text.");
  assert.deepEqual(await store.listUtterances("other"), []);
});

test("store rejects invalid data and never stores it", async () => {
  const store = new InMemoryKnowledgeStore();
  await assert.rejects(store.saveUtterance(utterance({ text: "" })), /utterance/);
  await assert.rejects(store.saveQuestion(question({ status: "asked" })), /spokenAtMs/);
  assert.deepEqual(await store.listUtterances("s1"), []);
  assert.deepEqual(await store.listQuestions("s1"), []);
});

test("store: question lifecycle upserts by id", async () => {
  const store = new InMemoryKnowledgeStore();
  await store.saveQuestion(question());
  await store.saveQuestion(question({ id: "q2", createdAtMs: 20000 }));
  await store.saveQuestion(question({ status: "answered", decision: "ASK_NOW", spokenAtMs: 16000, answerUtteranceIds: ["u1"] }));
  const qs = await store.listQuestions("s1");
  assert.deepEqual(qs.map((q) => [q.id, q.status]), [["q1", "answered"], ["q2", "candidate"]]);
});

test("store: map versions are append-only with consecutive numbers per workMapId", async () => {
  const store = new InMemoryKnowledgeStore();
  assert.equal(await store.getLatestMap("wm-customer07"), null);
  await assert.rejects(store.saveMapVersion(map({ version: 2 })), /expected 1/);
  await store.saveMapVersion(map());
  const corrected = map({
    id: "m2",
    version: 2,
    reason: "review_corrected",
    guardrails: [guardrail({ version: 2, exceptions: [] })],
  });
  await store.saveMapVersion(corrected);
  await assert.rejects(store.saveMapVersion(corrected), /expected 3/);
  assert.equal(must((await store.getLatestMap("wm-customer07"))).version, 2);
  assert.equal(must(must((await store.getMapVersion("wm-customer07", 1))).guardrails[0]).exceptions.length, 1);
  assert.deepEqual((await store.listMapVersions("wm-customer07")).map((m) => m.reason), ["live", "review_corrected"]);
  assert.equal(await store.getMapVersion("wm-customer07", 9), null);
  // numbering is per map, not per session: another map starts at 1 even for the same session
  await store.saveMapVersion(map({ id: "other-1", workMapId: "wm-other" }));
  assert.equal(must((await store.getLatestMap("wm-other"))).version, 1);
});

test("store: a new session (Teach, reset) finds the confirmed map through workMapId; sessionId is only metadata", async () => {
  const store = new InMemoryKnowledgeStore();
  await store.saveMapVersion(map({ sessionId: "learn-1" }));
  await store.saveMapVersion(map({ id: "m2", version: 2, sessionId: "review-1", reason: "review_confirmed" }));
  // a Teach session with a different id looks the map up by workMapId, never by its own session id
  assert.equal(await store.getLatestMap("teach-1"), null, "a session id is not a map id");
  const found = await store.getLatestConfirmedMap("wm-customer07");
  assert.equal(must(found).version, 2);
  assert.equal(must(found).sessionId, "review-1", "the producing session is kept as metadata");
});

test("store: getLatestConfirmedMap returns the newest review_* version, never a later live draft", async () => {
  const store = new InMemoryKnowledgeStore();
  assert.equal(await store.getLatestConfirmedMap("wm-customer07"), null);
  await store.saveMapVersion(map());
  assert.equal(await store.getLatestConfirmedMap("wm-customer07"), null, "a live version is not confirmed");
  await store.saveMapVersion(map({ id: "m2", version: 2, reason: "review_confirmed" }));
  await store.saveMapVersion(
    map({ id: "m3", version: 3, reason: "review_corrected", guardrails: [guardrail({ version: 2, exceptions: [] })] }),
  );
  await store.saveMapVersion(map({ id: "m4", version: 4, reason: "live" }));
  const confirmed = await store.getLatestConfirmedMap("wm-customer07");
  assert.equal(must(confirmed).version, 3, "T5: the latest confirmed version wins, not the newest draft");
  assert.deepEqual(must(must(confirmed).guardrails[0]).exceptions, []);
  assert.equal(must((await store.getLatestMap("wm-customer07"))).version, 4);
  must(confirmed).steps.length = 0;
  assert.equal(must((await store.getLatestConfirmedMap("wm-customer07"))).steps.length, 1, "returns copies");
});

test("store: sessions round-trip", async () => {
  const store = new InMemoryKnowledgeStore();
  assert.equal(await store.getSession("s1"), null);
  await store.saveSession(session());
  await store.saveSession(session({ offRecord: true }));
  assert.equal(must((await store.getSession("s1"))).offRecord, true);
});

function turn(over: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return { role: "user", text: "Customer 07 asked for text.", startMs: 1000, endMs: 2000, final: true, ...over };
}

test("attributeMarkerTurns: user turns that start with [ASK] are the agent's question, source harness", () => {
  const out = attributeMarkerTurns([
    turn({ role: "user", text: `${ASK_MARKER} Why did you type the address?`, startMs: 1000 }),
    turn({ role: "agent", text: "Why did you type the address?", startMs: 1100 }),
    turn({ role: "user", text: "Because the customer asked for text.", startMs: 5000 }),
  ]);
  assert.deepEqual(
    out.map((t) => [t.speaker, t.source]),
    [["agent", "harness"], ["agent", "transcript"], ["expert", "transcript"]],
  );
  assert.equal(must(out[0]).text, "Why did you type the address?", "marker stripped");
  assert.equal(must(out[2]).text, "Because the customer asked for text.");
  assert.ok(!out.some((t) => t.speaker === "expert" && t.text.includes("Why did you type")), "the question never becomes an expert answer");
});

test("attributeMarkerTurns: marker rules, user role for Teach, copy semantics", () => {
  const input = [
    turn({ text: "  [ASK] leading spaces are fine", endMs: undefined }),
    turn({ text: "I said [ASK] in the middle of a sentence" }),
    turn({ text: "[ask] lower case is not the marker" }),
    turn({ role: "agent", text: "[ASK] an agent turn is already the agent" }),
  ];
  const copy = structuredClone(input);
  const out = attributeMarkerTurns(input, { userRole: "novice" });
  assert.deepEqual(input, copy, "the input is not mutated");
  assert.deepEqual(
    out.map((t) => [t.speaker, t.source]),
    [["agent", "harness"], ["novice", "transcript"], ["novice", "transcript"], ["agent", "transcript"]],
  );
  assert.equal(must(out[0]).text, "leading spaces are fine");
  assert.equal(must(out[0]).endMs, null);
  assert.equal(must(out[0]).final, true);
  assert.equal(must(out[3]).text, "[ASK] an agent turn is already the agent", "agent turns are left untouched");
  assert.deepEqual(attributeMarkerTurns([]), []);
  // the result maps straight onto a valid Utterance
  const u = { id: "u9", sessionId: "s1", ...must(attributeMarkerTurns([turn({ text: "[ASK] Why?" })])[0]) };
  assert.equal(validateUtterance(u).ok, true);
});
