import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScreenObservation } from "../src/contract-draft.ts";
import type { ScreenObservation, ScreenStatus } from "../src/contract-draft.ts";
import { FakeClock } from "../src/fake/clock.ts";
import { FakeScreenBridge } from "../src/fake/screen-bridge.ts";
import { loadLearnCustomer07 } from "../src/fake/fixture-node.ts";

const EPOCH = 5_000_000;

async function setup() {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  const bridge = new FakeScreenBridge(fixture, clock);
  const seen: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  bridge.onObservation((o) => seen.push(o));
  bridge.onStatus((s) => statuses.push(s));
  await bridge.start({ sessionId: "sess-test", sessionEpochMs: EPOCH });
  return { clock, fixture, bridge, seen, statuses };
}

test("fixture is valid, ordered and tells the customer_07 story", () => {
  const f = loadLearnCustomer07();
  assert.equal(f.schemaVersion, 1);
  const times = f.observations.map((o) => o.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(f.observations.map((o) => o.id)).size, f.observations.length);
  const emails = f.observations.filter((o) => o.kind === "email_draft");
  const hasImage = emails.some((o) => (o.facts as { attachments: unknown[] }).attachments.length > 0);
  const last = emails.at(-1)!.facts as { attachments: unknown[]; bodyText: string; previewState: string };
  assert.ok(hasImage, "template screenshot attached at some point");
  assert.equal(last.attachments.length, 0, "image removed in the end");
  assert.ok(last.bodyText.includes("14 Sample Lane") && last.bodyText.includes("14:00-16:00"), "essential data typed as text");
  assert.equal(last.previewState, "preview");
  assert.ok(f.observations.some((o) => o.kind === "input_activity" && (o.facts as { typing: boolean }).typing));
  for (const o of f.observations) for (const id of o.evidenceIds) assert.ok(f.evidence.some((e) => e.id === id), id);
});

test("replay emits ordered, valid observations with timestamps relative to sessionEpochMs", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  assert.equal(statuses[0]!.state, "capturing");
  clock.advance(fixture.durationMs);
  assert.equal(seen.length, fixture.observations.length);
  assert.ok(bridge.finished);
  seen.forEach((o, i) => {
    assert.equal(o.sequence, i + 1);
    assert.equal(o.sessionId, "sess-test");
    assert.equal(o.timestampMs, fixture.observations[i]!.atMs);
    assert.equal(validateScreenObservation(o).ok, true);
    if (i > 0) assert.ok(o.timestampMs >= seen[i - 1]!.timestampMs);
  });
});

test("emission is driven by the clock, not by start()", async () => {
  const { clock, seen } = await setup();
  clock.advance(1);
  assert.equal(seen.length, 1); // the order view at 0 ms
  clock.advance(3000);
  assert.equal(seen.length, 2); // heartbeat at 2000
  clock.advance(2000);
  assert.equal(seen.length, 3); // email opened at 5000
});

test("after pause() nothing is emitted; resume() continues without a jump or a burst", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(6000);
  const before = seen.length;
  assert.equal(before, 3);
  await bridge.pause();
  assert.equal(statuses.at(-1)!.state, "paused");
  clock.advance(60_000);
  assert.equal(seen.length, before, "nothing while paused");
  assert.equal(clock.pendingTimers(), 0, "no pending emission survives a pause");

  await bridge.resume();
  assert.equal(statuses.at(-1)!.state, "capturing");
  clock.advance(0);
  assert.equal(seen.length, before, "no burst on resume");
  // next fixture observation is 8000 ms; 6000 ms were consumed, so 2000 ms of active time remain
  clock.advance(1999);
  assert.equal(seen.length, before);
  clock.advance(1);
  assert.equal(seen.length, before + 1);
  assert.equal(seen.at(-1)!.id, fixture.observations[before]!.id);
  assert.equal(seen.at(-1)!.timestampMs, 8000 + 60_000, "session time includes the paused interval");

  clock.advance(60_000 + fixture.durationMs);
  assert.equal(seen.length, fixture.observations.length, "the rest of the timeline is intact");
  const ids = seen.map((o) => o.id);
  assert.deepEqual(ids, fixture.observations.map((o) => o.id));
});

test("stop() ends emission and reports stopped; start() again restarts the replay", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.stop();
  assert.equal(statuses.at(-1)!.state, "stopped");
  const n = seen.length;
  assert.equal(n, 2);
  clock.advance(60_000);
  assert.equal(seen.length, n, "nothing after stop");

  const epoch2 = clock.now();
  await bridge.start({ sessionId: "sess-test-2", sessionEpochMs: epoch2 });
  assert.equal(statuses.at(-1)!.state, "capturing");
  assert.equal(bridge.emitted.length, 0, "replay state is reset");
  clock.advance(1);
  const first = seen.at(-1)!;
  assert.equal(first.id, fixture.observations[0]!.id, "replay starts again from the first observation");
  assert.equal(first.sequence, 1);
  assert.equal(first.sessionId, "sess-test-2");
  assert.equal(first.timestampMs, 0, "timestamps count from the new sessionEpochMs");
  clock.advance(fixture.durationMs);
  assert.equal(bridge.emitted.length, fixture.observations.length);
});

test("fixture follows the spec heartbeat: one typing:false heartbeat right when typing stops", () => {
  const f = loadLearnCustomer07();
  const beats = f.observations.filter((o) => o.kind === "input_activity");
  const typing = (o: (typeof beats)[number]) => (o.facts as { typing: boolean }).typing;
  const lastTyping = beats.filter(typing).at(-1)!;
  const stop = beats.find((o) => !typing(o) && o.atMs > lastTyping.atMs)!;
  assert.equal(stop.atMs, 19500);
  assert.equal((stop.facts as { idleMs: number }).idleMs, 0);
  assert.ok(stop.atMs - lastTyping.atMs < 2000, "emitted promptly after the last typing heartbeat");
});

test("resolveEvidence returns the asset and shifts times by paused duration", async () => {
  const { clock, bridge } = await setup();
  await assert.rejects(bridge.resolveEvidence("ev-f-0001"), /unknown or not yet emitted/);
  clock.advance(1);
  const first = await bridge.resolveEvidence("ev-f-0001");
  assert.deepEqual(first, { assetRef: "mock://frames/f-0001.png", startMs: 0, endMs: 1000 });
  clock.advance(8000);
  await bridge.pause();
  clock.advance(10_000);
  await bridge.resume();
  clock.advance(3000); // observation at 11000 references the clip
  const clip = await bridge.resolveEvidence("ev-clip-template-replaced");
  assert.equal(clip.assetRef, "mock://clips/template-replaced.webm");
  assert.equal(clip.startMs, 8000 + 10_000);
  assert.equal(clip.endMs, 20000 + 10_000);
  await assert.rejects(bridge.resolveEvidence("nope"));
});

test("checkpoint at Preview carries the latest order and email observations; replies are validated", async () => {
  const { clock, fixture, bridge, seen } = await setup();
  clock.advance(fixture.durationMs);
  const got: string[][] = [];
  bridge.onCheckpoint((c) => got.push(c.observationIds));
  const cp = bridge.raiseCheckpoint();
  const lastOrder = seen.filter((o) => o.kind === "order_view").at(-1)!;
  const lastEmail = seen.filter((o) => o.kind === "email_draft").at(-1)!;
  assert.deepEqual(got[0], [lastOrder.id, lastEmail.id]);
  await bridge.replyToCheckpoint({ schemaVersion: 1, checkpointId: cp.id, status: "unknown", message: "No rule known.", evidenceIds: [] });
  assert.equal(bridge.replies.length, 1);
  await assert.rejects(bridge.replyToCheckpoint({ schemaVersion: 1, checkpointId: cp.id, status: "block" as never, message: "x", evidenceIds: [] }));
});
