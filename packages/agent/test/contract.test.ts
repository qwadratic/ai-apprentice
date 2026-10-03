import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  checkpointCoversLatest,
  validateActionCheckpoint,
  validateCheckpointReply,
  validateScreenEvidence,
  validateScreenObservation,
  validateScreenStatus,
} from "../src/contract-draft.ts";
import type { ActionCheckpoint, ScreenObservation } from "../src/contract-draft.ts";
import { loadLearnCustomer07 } from "../src/fake/fixture-node.ts";

function obs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "obs-1",
    sessionId: "s1",
    sequence: 1,
    timestampMs: 0,
    frameId: "f-1",
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
    facts: { ticketId: "T-1", orderId: "ORD-1", customerRef: "customer_07", status: "done", note: "sent" },
  });
  assert.equal(validateScreenObservation(ticket).ok, true);
  const heartbeat = obs({ kind: "input_activity", evidenceIds: [], facts: { surface: "email", typing: true, idleMs: 0 } });
  assert.equal(validateScreenObservation(heartbeat).ok, true);
  // order facts under the heartbeat kind must fail
  assert.equal(validateScreenObservation(obs({ kind: "input_activity" })).ok, false);
});

test("status, evidence, checkpoint and reply validators", () => {
  assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "paused" }).ok, true);
  assert.equal(validateScreenStatus({ schemaVersion: 1, sessionId: "s", state: "sleeping" }).ok, false);
  assert.equal(validateScreenEvidence({ schemaVersion: 1, id: "e", kind: "clip", assetRef: "a", startMs: 5, endMs: 9 }).ok, true);
  assert.equal(validateScreenEvidence({ schemaVersion: 1, id: "e", kind: "clip", assetRef: "a", startMs: 9, endMs: 5 }).ok, false);
  const cp = { schemaVersion: 1, id: "cp", sessionId: "s", timestampMs: 10, observationIds: ["a"], action: "send" };
  assert.equal(validateActionCheckpoint(cp).ok, true);
  assert.equal(validateActionCheckpoint({ ...cp, action: "delete" }).ok, false);
  const reply = { schemaVersion: 1, checkpointId: "cp", status: "warn", message: "m", evidenceIds: [] };
  assert.equal(validateCheckpointReply(reply).ok, true);
  assert.equal(validateCheckpointReply({ ...reply, status: "block" }).ok, false);
  assert.equal(validateCheckpointReply({ ...reply, message: "" }).ok, false);
});

test("checkpoint must include the latest order and latest email observation", () => {
  const fixture = loadLearnCustomer07();
  const all = fixture.observations.map(
    (f, i) =>
      ({ schemaVersion: SCHEMA_VERSION, id: f.id, sessionId: "s", sequence: i + 1, timestampMs: f.atMs, frameId: f.frameId, kind: f.kind, facts: f.facts, entityRef: f.entityRef, evidenceIds: f.evidenceIds }) as ScreenObservation,
  );
  const lastOrder = all.filter((o) => o.kind === "order_view").at(-1)!;
  const lastEmail = all.filter((o) => o.kind === "email_draft").at(-1)!;
  const base: ActionCheckpoint = { schemaVersion: 1, id: "cp", sessionId: "s", timestampMs: 26000, observationIds: [], action: "send" };
  assert.equal(checkpointCoversLatest({ ...base, observationIds: [lastOrder.id, lastEmail.id] }, all).ok, true);
  const staleEmail = all.filter((o) => o.kind === "email_draft")[0]!;
  const r = checkpointCoversLatest({ ...base, observationIds: [lastOrder.id, staleEmail.id] }, all);
  assert.ok(!r.ok && r.errors[0]!.includes("email_draft"));
  assert.equal(checkpointCoversLatest({ ...base, observationIds: [] }, all).ok, false);
});
