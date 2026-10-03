import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  SCREEN_STATUS_REASONS,
  checkpointCoversLatest,
  factsFromCheckpoint,
  replyIsCurrent,
  validateActionCheckpoint,
  validateCheckpointReply,
  validateScreenEvidence,
  validateScreenObservation,
  validateScreenStatus,
} from "../src/contract-draft.ts";
import type { ActionCheckpoint, ScreenObservation } from "../src/contract-draft.ts";
import { loadLearnCustomer07 } from "../src/fake/fixture-node.ts";
import { must } from "./helpers.ts";

function obs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "obs-1",
    sessionId: "s1",
    sequence: 1,
    timestampMs: 0,
    source: "vision",
    frameId: "f-1",
    sourceRevision: "rev-order-1",
    kind: "order_view",
    entityRef: "customer_07",
    evidenceIds: ["ev-1"],
    facts: { customerRef: "customer_07", orderId: "ORD-1", deliveryAddress: "1 Test Rd", deliveryWindow: "10-12" },
    ...overrides,
  };
}

test("valid order observation passes; unknown customer is null, not missing", () => {
  assert.equal(validateScreenObservation(obs()).ok, true);
  const unknown = obs({ entityRef: null, facts: { customerRef: null, orderId: "ORD-9", deliveryAddress: "x", deliveryWindow: "y" } });
  assert.equal(validateScreenObservation(unknown).ok, true);
  const missing = obs({ facts: { orderId: "ORD-9", deliveryAddress: "x", deliveryWindow: "y" } });
  assert.equal(validateScreenObservation(missing).ok, false);
});

test("every order fact is nullable (unreadable or masked stays null) but never missing", () => {
  const allNull = obs({ entityRef: null, facts: { customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null } });
  assert.equal(validateScreenObservation(allNull).ok, true);
  for (const field of ["customerRef", "orderId", "deliveryAddress", "deliveryWindow"]) {
    const facts: Record<string, unknown> = { customerRef: "c", orderId: "o", deliveryAddress: "a", deliveryWindow: "w" };
    delete facts[field];
    assert.equal(validateScreenObservation(obs({ facts })).ok, false, `${field} missing must fail`);
    assert.equal(validateScreenObservation(obs({ facts: { ...facts, [field]: 5 } })).ok, false, `${field} number must fail`);
  }
});

test("envelope: source is vision|workspace; frameId is null only for workspace; sourceRevision is nullable but present", () => {
  assert.equal(validateScreenObservation(obs({ sourceRevision: null })).ok, true, "history-only vision observation");
  const noSource = obs();
  delete noSource.source;
  assert.equal(validateScreenObservation(noSource).ok, false);
  const noRevisionKey = obs();
  delete noRevisionKey.sourceRevision;
  assert.equal(validateScreenObservation(noRevisionKey).ok, false);
  assert.equal(validateScreenObservation(obs({ source: "dom" })).ok, false);
  const visionNoFrame = validateScreenObservation(obs({ frameId: null }));
  assert.ok(!visionNoFrame.ok && visionNoFrame.errors.some((e) => e.includes("frameId")));
  const hb = obs({
    kind: "input_activity",
    source: "workspace",
    frameId: null,
    sourceRevision: null,
    entityRef: null,
    evidenceIds: [],
    timestampMs: 100,
    facts: { surface: "email", typing: true, idleMs: 0, lastInputAtMs: 100 },
  });
  assert.equal(validateScreenObservation(hb).ok, true);
  assert.equal(validateScreenObservation({ ...hb, frameId: "f-9" }).ok, false, "workspace has no frame");
  assert.equal(validateScreenObservation({ ...hb, sourceRevision: "rev-1" }).ok, false, "workspace has no revision");
  assert.equal(validateScreenObservation({ ...hb, source: "vision", frameId: "f-9" }).ok, false, "input_activity is workspace-only");
  assert.equal(validateScreenObservation(obs({ source: "workspace", frameId: null })).ok, false, "workspace is only for input_activity");
});

test("observation rejects wrong schemaVersion, kind, sequence and timestamp", () => {
  for (const bad of [
    obs({ schemaVersion: 2 }),
    obs({ kind: "mystery" }),
    obs({ sequence: 0 }),
    obs({ timestampMs: -1 }),
    obs({ evidenceIds: "ev-1" }),
  ]) {
    assert.equal(validateScreenObservation(bad).ok, false);
  }
  const r = validateScreenObservation(obs({ kind: "mystery" }));
  assert.ok(!r.ok && r.errors.some((e) => e.includes("observation.kind")));
});

test("kind selects the facts schema", () => {
  const email = obs({
    kind: "email_draft",
    facts: {
      recipientRef: "contact_customer_07",
      subject: "s",
      bodyText: "",
      attachments: [{ kind: "image", ocrText: "text" }, { kind: "pdf" }],
      previewState: "editing",
    },
  });
  assert.equal(validateScreenObservation(email).ok, true);
  const badAtt = obs({
    kind: "email_draft",
    facts: { recipientRef: null, subject: "", bodyText: "", attachments: [{ kind: "gif" }], previewState: "editing" },
  });
  assert.equal(validateScreenObservation(badAtt).ok, false);
  const ticket = obs({
    kind: "ticket",
    facts: { ticketId: "T-1", orderId: "ORD-1", customerRef: "customer_07", status: "done", summary: "sent" },
  });
  assert.equal(validateScreenObservation(ticket).ok, true);
  const oldNote = obs({
    kind: "ticket",
    facts: { ticketId: "T-1", orderId: "ORD-1", customerRef: "customer_07", status: "done", note: "sent" },
  });
  assert.equal(validateScreenObservation(oldNote).ok, false, "note was renamed to summary, no dual fields");
  const emptySummary = obs({
    kind: "ticket",
    facts: { ticketId: "T-1", orderId: null, customerRef: null, status: "open", summary: "" },
  });
  assert.equal(validateScreenObservation(emptySummary).ok, true);
  const heartbeat = obs({
    kind: "input_activity",
    source: "workspace",
    frameId: null,
    sourceRevision: null,
    entityRef: null,
    evidenceIds: [],
    timestampMs: 4000,
    facts: { surface: "email", typing: true, idleMs: 0, lastInputAtMs: 4000 },
  });
  assert.equal(validateScreenObservation(heartbeat).ok, true);
  const noLastInput = { ...heartbeat, facts: { surface: "email", typing: true, idleMs: 0 } };
  assert.equal(validateScreenObservation(noLastInput).ok, false, "lastInputAtMs is required");
  assert.equal(validateScreenObservation({ ...heartbeat, facts: { ...heartbeat.facts as object, lastInputAtMs: -1 } }).ok, false);
  // order facts under the heartbeat kind must fail
  assert.equal(validateScreenObservation(obs({ kind: "input_activity" })).ok, false);
});

test("status, evidence, checkpoint and reply validators", () => {
  assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "paused" }).ok, true);
  assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "sleeping" }).ok, false);
  for (const reason of ["mask-review", "off_record"]) {
    assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "paused", reason }).ok, true, reason);
  }
  assert.ok(SCREEN_STATUS_REASONS.includes("mask-review") && SCREEN_STATUS_REASONS.includes("off_record"));
  assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "paused", reason: "because" }).ok, false);
  assert.equal(validateScreenEvidence({ schemaVersion: 1, id: "e", kind: "clip", assetRef: "a", startMs: 5, endMs: 9 }).ok, true);
  assert.equal(validateScreenEvidence({ schemaVersion: 1, id: "e", kind: "clip", assetRef: "a", startMs: 9, endMs: 5 }).ok, false);
  const cp = {
    schemaVersion: 1,
    id: "cp",
    sessionId: "s",
    timestampMs: 10,
    observationIds: ["a"],
    revisions: { order: "rev-order-1", email: "rev-email-3" },
    action: "send",
  };
  assert.equal(validateActionCheckpoint(cp).ok, true);
  assert.equal(validateActionCheckpoint({ ...cp, action: "delete" }).ok, false);
  const noRevisions: Record<string, unknown> = { ...cp };
  delete noRevisions.revisions;
  assert.equal(validateActionCheckpoint(noRevisions).ok, false, "revisions are required");
  assert.equal(validateActionCheckpoint({ ...cp, revisions: { order: "r" } }).ok, false, "both revisions are required");
  const withFacts = validateActionCheckpoint({ ...cp, facts: { order: {}, email: {} } });
  assert.ok(!withFacts.ok && withFacts.errors.some((e) => e.includes("checkpoint.facts")), "a checkpoint carries no facts");
  const reply = { schemaVersion: 1, checkpointId: "cp", status: "warn", message: "m", evidenceIds: [], basedOn: { order: "rev-order-1", email: "rev-email-3" } };
  assert.equal(validateCheckpointReply(reply).ok, true);
  const noBasedOn: Record<string, unknown> = { ...reply };
  delete noBasedOn.basedOn;
  assert.equal(validateCheckpointReply(noBasedOn).ok, false, "basedOn is required");
  assert.equal(validateCheckpointReply({ ...reply, basedOn: { order: "r", email: "" } }).ok, false);
  assert.equal(replyIsCurrent(reply as never, { order: "rev-order-1", email: "rev-email-3" }), true);
  assert.equal(replyIsCurrent(reply as never, { order: "rev-order-1", email: "rev-email-4" }), false, "the email changed after the reply was judged");
  assert.equal(replyIsCurrent(reply as never, { order: "rev-order-2", email: "rev-email-3" }), false);
  assert.equal(validateCheckpointReply({ ...reply, status: "block" }).ok, false);
  assert.equal(validateCheckpointReply({ ...reply, message: "" }).ok, false);
});

test("checkpoint must include the latest order and latest email observation", () => {
  const fixture = loadLearnCustomer07();
  const all = fixture.observations.map(
    (f, i) =>
      ({ schemaVersion: SCHEMA_VERSION, id: f.id, sessionId: "s", sequence: i + 1, timestampMs: f.atMs, source: f.source, frameId: f.frameId, sourceRevision: f.sourceRevision, kind: f.kind, facts: f.facts, entityRef: f.entityRef, evidenceIds: f.evidenceIds }) as ScreenObservation,
  );
  const lastOrder = must(all.filter((o) => o.kind === "order_view").at(-1));
  const lastEmail = must(all.filter((o) => o.kind === "email_draft").at(-1));
  const base: ActionCheckpoint = {
    schemaVersion: 1,
    id: "cp",
    sessionId: "s",
    timestampMs: 27000,
    observationIds: [],
    revisions: { order: "rev-order-1", email: "rev-email-6" },
    action: "send",
  };
  assert.equal(checkpointCoversLatest({ ...base, observationIds: [lastOrder.id, lastEmail.id] }, all).ok, true);
  const staleEmail = must(all.filter((o) => o.kind === "email_draft")[0]);
  const r = checkpointCoversLatest({ ...base, observationIds: [lastOrder.id, staleEmail.id] }, all);
  assert.ok(!r.ok && must(r.errors[0]).includes("email_draft"));
  assert.equal(checkpointCoversLatest({ ...base, observationIds: [] }, all).ok, false);
});

test("every fixture observation validates against the contract, with source and revision rules", () => {
  const f = loadLearnCustomer07();
  f.observations.forEach((o, i) => {
    const full = { schemaVersion: 1, sessionId: "s", sequence: i + 1, timestampMs: o.atMs, ...o };
    const r = validateScreenObservation(full);
    assert.ok(r.ok, `${o.id}: ${r.ok ? "" : r.errors.join("; ")}`);
    if (o.kind === "input_activity") {
      assert.equal(o.source, "workspace", o.id);
      assert.equal(o.frameId, null, o.id);
      assert.equal(o.sourceRevision, null, o.id);
      const hb = o.facts as { lastInputAtMs: number; idleMs: number };
      assert.ok(hb.lastInputAtMs <= o.atMs, `${o.id}: lastInputAtMs is not in the future`);
      assert.equal(hb.idleMs, o.atMs - hb.lastInputAtMs, `${o.id}: idleMs = timestampMs - lastInputAtMs`);
    } else {
      assert.equal(o.source, "vision", o.id);
      assert.ok(o.frameId, o.id);
    }
    if (o.kind === "order_view" || o.kind === "email_draft") {
      assert.ok(typeof o.sourceRevision === "string" && o.sourceRevision.length > 0, `${o.id} carries a sourceRevision`);
    }
  });
  const revs = f.observations.filter((o) => o.kind === "email_draft").map((o) => o.sourceRevision);
  assert.equal(new Set(revs).size, revs.length, "the email revision changes on every edit");
});

test("idle rule: idleMs = timestampMs - lastInputAtMs within 1 ms, last input never in the future", () => {
  const hb = (timestampMs: number, idleMs: number, lastInputAtMs: number) =>
    obs({
      kind: "input_activity",
      source: "workspace",
      frameId: null,
      sourceRevision: null,
      entityRef: null,
      evidenceIds: [],
      timestampMs,
      facts: { surface: "email", typing: false, idleMs, lastInputAtMs },
    });
  assert.equal(validateScreenObservation(hb(12_000, 2000, 10_000)).ok, true);
  assert.equal(validateScreenObservation(hb(12_000, 2001, 10_000)).ok, true, "1 ms of slack");
  const reset = validateScreenObservation(hb(12_000, 0, 10_000));
  assert.ok(!reset.ok && reset.errors.some((e) => e.includes("idleMs")), "idle is not reset to zero when typing stops");
  assert.equal(validateScreenObservation(hb(12_000, 1998, 10_000)).ok, false);
  const future = validateScreenObservation(hb(10_000, 0, 12_000));
  assert.ok(!future.ok && future.errors.some((e) => e.includes("lastInputAtMs")));
});

test("fixture heartbeats: none before the first input, first typing:false about 2000 ms after the last input, idle chain stops at 10000 ms", () => {
  const f = loadLearnCustomer07();
  type Hb = { surface: string; typing: boolean; idleMs: number; lastInputAtMs: number };
  const beats = f.observations.filter((o) => o.kind === "input_activity");
  const facts = (o: (typeof beats)[number]) => o.facts as Hb;
  assert.ok(beats.length > 0);
  const firstInput = Math.min(...beats.map((o) => facts(o).lastInputAtMs));
  assert.ok(must(beats[0]).atMs >= firstInput, "no heartbeat before the first input");
  assert.equal(must(beats[0]).atMs, facts(must(beats[0])).lastInputAtMs, "the first heartbeat is emitted right on input");
  let previous: (typeof beats)[number] | null = null;
  for (const b of beats) {
    const h = facts(b);
    if (!h.typing) {
      const prev = previous && facts(previous);
      if (previous && prev && prev.lastInputAtMs === h.lastInputAtMs && !prev.typing) {
        assert.equal(b.atMs - previous.atMs, 2000, `${b.id}: idle heartbeats every 2 s`);
        assert.ok(prev.idleMs < 10_000, `${b.id}: no idle heartbeat after the first one at or after 10000 ms`);
      } else {
        assert.ok(Math.abs(h.idleMs - 2000) <= 500, `${b.id}: first typing:false is about 2000 ms after the last input, not ${h.idleMs}`);
      }
    }
    previous = b;
  }
});

test("factsFromCheckpoint reads order and email facts from the referenced vision observations", () => {
  const f = loadLearnCustomer07();
  const all = f.observations.map(
    (o, i) =>
      ({ schemaVersion: SCHEMA_VERSION, sessionId: "s", sequence: i + 1, timestampMs: o.atMs, ...o }) as ScreenObservation,
  );
  const order = must(all.filter((o) => o.kind === "order_view").at(-1));
  const email = must(all.filter((o) => o.kind === "email_draft").at(-1));
  const cp: ActionCheckpoint = {
    schemaVersion: 1,
    id: "cp",
    sessionId: "s",
    timestampMs: 27000,
    observationIds: [order.id, email.id],
    revisions: { order: must(order.sourceRevision), email: must(email.sourceRevision) },
    action: "send",
  };
  const ok = factsFromCheckpoint(cp, all);
  assert.deepEqual(ok, { incomplete: false, order: order.facts, email: email.facts });

  const reasonOf = (r: ReturnType<typeof factsFromCheckpoint>) => (r.incomplete ? r.reason : "");
  const missing = factsFromCheckpoint({ ...cp, observationIds: [order.id] }, all);
  assert.ok(missing.incomplete && reasonOf(missing).includes("email_draft"));
  const absent = factsFromCheckpoint(cp, all.filter((o) => o.id !== email.id));
  assert.ok(absent.incomplete);
  const staleRevision = factsFromCheckpoint({ ...cp, revisions: { ...cp.revisions, email: "rev-email-5" } }, all);
  assert.ok(staleRevision.incomplete && reasonOf(staleRevision).includes("revision"));
  const otherSession = factsFromCheckpoint({ ...cp, sessionId: "other" }, all);
  assert.ok(otherSession.incomplete);
  const notVision = all.map((o) => (o.id === order.id ? ({ ...o, source: "workspace" } as ScreenObservation) : o));
  const wrongSource = factsFromCheckpoint(cp, notVision);
  assert.ok(wrongSource.incomplete && reasonOf(wrongSource).includes("vision"));
  const noRevision = all.map((o) => (o.id === order.id ? ({ ...o, sourceRevision: null } as ScreenObservation) : o));
  assert.ok(factsFromCheckpoint(cp, noRevision).incomplete, "an untracked screen never yields facts");
});
