// Dev-only generator for the briefing board fixtures. Run from the repo root:
//   node apps/web/features/agent/workmap/fixtures/generate.ts
// It plays the synthetic customer_07 Learn fixture (fixtures/agent/learn-customer07.json) through the real agent code
// (packages/agent: extractor, map reducer, review) with the scripted expert's answers, and writes two snapshots of what
// Review would hand the board: the draft at the start of the debrief (open gaps) and the confirmed map after the teach-back.
// The map, the gaps and the quotes come out of the agent code; nothing here writes a rule by hand. All data is synthetic.
import { readFileSync, writeFileSync } from "node:fs";
import { SCHEMA_VERSION, parseScreenObservation } from "@apprentice/contracts";
import type { ScreenEvidence, ScreenObservation } from "@apprentice/contracts";
import {
  HeuristicAnswerExtractor,
  confirmationOf,
  createMapState,
  knownCustomerRefs,
  reduceMap,
  reviewStatus,
  stateTeachBack,
  workingMap,
} from "@apprentice/agent";
import type { MapState, Topic } from "@apprentice/agent";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = new URL("../../../../../../", import.meta.url);
const read = (rel: string): Json => JSON.parse(readFileSync(new URL(rel, repo), "utf8"));

const learn = read("fixtures/agent/learn-customer07.json");
const expert = read("fixtures/agent/sim/expert-script.json");
const customers: string[] = read("fixtures/agent/sim/scenario.json").customers.map((c: { ref: string }) => c.ref);
const sessionId: string = learn.sessionId;

// Evidence: the fixture's frames and clip, plus one synthetic frame for each vision observation that only points at the clip,
// so every keyframe of the storyboard has a still. Times are session-relative (sessionEpochMs = capture start).
const evidence: ScreenEvidence[] = learn.evidence.map((e: Json) => ({
  schemaVersion: SCHEMA_VERSION, id: e.id, kind: e.kind, assetRef: e.assetRef, startMs: e.startOffsetMs, endMs: e.endOffsetMs,
}));
// The clip stays on the first observation that points at it (the removal), so later moments do not share its id.
const clipUsed = new Set<string>();
const observations: ScreenObservation[] = learn.observations.map((o: Json, i: number) => {
  let evidenceIds: string[] = o.evidenceIds;
  if (o.kind !== "input_activity" && !evidenceIds.some((id) => id.startsWith("ev-f-"))) {
    const id = `ev-f-${String(o.id).slice(4).padStart(4, "0")}`;
    evidence.push({ schemaVersion: SCHEMA_VERSION, id, kind: "frame", assetRef: `mock://frames/f-${id.slice(5)}.png`, startMs: o.atMs, endMs: o.atMs + 1000 });
    const clips = evidenceIds.filter((c) => !clipUsed.has(c));
    clips.forEach((c) => clipUsed.add(c));
    evidenceIds = [id, ...clips];
  }
  return parseScreenObservation({
    schemaVersion: SCHEMA_VERSION, id: o.id, sessionId, sequence: i + 1, timestampMs: o.atMs, source: o.source,
    frameId: o.frameId, sourceRevision: o.sourceRevision, entityRef: o.entityRef, evidenceIds, kind: o.kind, facts: o.facts,
  });
});
evidence.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
const byId = new Map(observations.map((o) => [o.id, o]));
const evOf = (id: string): string[] => [...(byId.get(id)?.evidenceIds ?? [])];

const extractor = new HeuristicAnswerExtractor();
async function answer(
  state: MapState,
  topic: Topic | "correction",
  atMs: number,
  evidenceIds: string[],
  q: { id: string | null; targetId: string | null; entityRef: string | null },
): Promise<MapState> {
  const text: string = topic === "correction" ? expert.teachback.correction.text : expert.answers[topic].text;
  const extraction = await extractor.extract({
    topic, text, questionId: q.id, atMs, evidenceIds, targetId: q.targetId, entityRef: q.entityRef, knownRefs: knownCustomerRefs(state),
  });
  return reduceMap(state, { type: topic === "correction" ? "correct" : "answer", extraction });
}

let state = createMapState(customers);
for (const o of observations) state = reduceMap(state, { type: "observation", observation: o });

// Learn: three live questions at the pauses after the removal, the typed details and Preview.
const live: Array<[Topic, string, number]> = [["reason", "obs-005", 12900], ["essentials", "obs-011", 22800], ["guardrail", "obs-014", 26900]];
for (const [topic, obsId, atMs] of live) {
  state = await answer(state, topic, atMs, evOf(obsId), { id: `q-${topic}`, targetId: null, entityRef: "customer_07" });
}
const draft = workingMap(state);
const draftStatus = reviewStatus(state);

// Review: follow-ups, one correction in the teach-back, then the confirmation.
let atMs = 40000;
for (const q of reviewStatus(state).openFollowUps) {
  if (!(q.topic in expert.answers)) continue;
  state = await answer(state, q.topic, (atMs += 9000), q.evidenceIds, { id: q.id, targetId: q.targetId, entityRef: q.entityRef });
}
state = stateTeachBack(state).state;
state = await answer(state, "correction", (atMs += 9000), [], { id: null, targetId: null, entityRef: null });
const stated = stateTeachBack(state).state;
state = reduceMap(stated, confirmationOf(stated, (atMs += 9000), expert.teachback.confirm.text));
const confirmedStatus = reviewStatus(state);
const confirmed = confirmedStatus.confirmed ?? workingMap(state);

const common = {
  generatedBy: "apps/web/features/agent/workmap/fixtures/generate.ts",
  synthetic: true,
  note: "Synthetic customer_07 Learn session played through packages/agent with the scripted expert. Frames are generated placeholders, not screen captures.",
  sessionId,
  durationMs: learn.durationMs,
  evidence,
  observations,
};
const out = new URL("./", import.meta.url);
const write = (name: string, body: unknown): void => writeFileSync(new URL(name, out), JSON.stringify(body, null, 2) + "\n");
write("board-draft.json", { ...common, stage: "review-start", map: draft, gaps: draftStatus.openFollowUps, blockers: draftStatus.blockers });
write("board-confirmed.json", { ...common, stage: "confirmed", map: confirmed, gaps: confirmedStatus.openFollowUps, blockers: confirmedStatus.blockers });
console.log(
  "draft v%d: %d steps, %d guardrails, %d gaps, %d blockers",
  draft.version, draft.steps.length, draft.guardrails.length, draftStatus.openFollowUps.length, draftStatus.blockers.length,
);
console.log(
  "confirmed v%d (%s): %d steps, %d guardrails, %d gaps",
  confirmed.version, confirmed.status, confirmed.steps.length, confirmed.guardrails.length, confirmedStatus.openFollowUps.length,
);
