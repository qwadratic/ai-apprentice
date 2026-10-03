import { test } from "node:test";
import assert from "node:assert/strict";
import { validateActionCheckpoint, validateScreenObservation, validateScreenStatus } from "../src/contract-draft.ts";
import type { ScreenObservation, ScreenStatus } from "../src/contract-draft.ts";
import { FakeClock } from "../src/fake/clock.ts";
import { FakeScreenBridge } from "../src/fake/screen-bridge.ts";
import { loadLearnCustomer07 } from "../src/fake/fixture-node.ts";

const EPOCH = 5_000_000;

/** Starts a session and confirms the masks immediately, so capturing begins at the epoch. */
async function setup() {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  const bridge = new FakeScreenBridge(fixture, clock);
  const seen: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  bridge.onObservation((o) => seen.push(o));
  bridge.onStatus((s) => statuses.push(s));
  const started = await bridge.start({ sessionId: "sess-test", sessionEpochMs: EPOCH });
  const confirmed = await bridge.confirmMasks();
  return { clock, fixture, bridge, seen, statuses, started, confirmed };
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

test("start() ends paused with mask-review and nothing is captured until the masks are confirmed", async () => {
  const clock = new FakeClock(EPOCH);
  const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
  const seen: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  bridge.onObservation((o) => seen.push(o));
  bridge.onStatus((s) => statuses.push(s));

  const started = await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH });
  assert.deepEqual(started, { state: "paused", reason: "mask-review" });
  assert.deepEqual(statuses.map((s) => [s.state, s.reason]), [["paused", "mask-review"]]);
  clock.advance(60_000);
  assert.equal(seen.length, 0, "no observation before mask confirmation");

  // resume() before the masks are confirmed is refused, not an error and not capturing
  const refused = await bridge.resume();
  assert.deepEqual(refused, { state: "paused", reason: "mask-review" });
  clock.advance(60_000);
  assert.equal(seen.length, 0);

  const confirmed = await bridge.confirmMasks();
  assert.deepEqual(confirmed, { state: "capturing" });
  assert.deepEqual(statuses.at(-1), { schemaVersion: 1, sessionId: "s", state: "capturing" });
  for (const st of statuses) assert.equal(validateScreenStatus(st).ok, true);
  clock.advance(1);
  assert.equal(seen.length, 1);
});

test("the timeline starts when capturing starts: timestamps are wall-clock offsets from sessionEpochMs", async () => {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  const bridge = new FakeScreenBridge(fixture, clock);
  const seen: ScreenObservation[] = [];
  bridge.onObservation((o) => seen.push(o));
  await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(10_000); // mask review takes ten seconds
  await bridge.confirmMasks();
  clock.advance(1);
  assert.equal(seen[0]!.timestampMs, 10_000, "the first observation carries the review gap");
  clock.advance(fixture.durationMs);
  seen.forEach((o, i) => assert.equal(o.timestampMs, 10_000 + fixture.observations[i]!.atMs));
  const first = await bridge.resolveEvidence("ev-f-0001");
  assert.deepEqual(first, { assetRef: "mock://frames/f-0001.png", startMs: 10_000, endMs: 11_000 });
});

test("replay emits ordered, valid observations with timestamps relative to sessionEpochMs", async () => {
  const { clock, fixture, bridge, seen, statuses, started, confirmed } = await setup();
  assert.deepEqual(started, { state: "paused", reason: "mask-review" });
  assert.deepEqual(confirmed, { state: "capturing" });
  assert.deepEqual(statuses.map((s) => s.state), ["paused", "capturing"]);
  clock.advance(fixture.durationMs);
  assert.equal(seen.length, fixture.observations.length);
  assert.ok(bridge.finished);
  seen.forEach((o, i) => {
    assert.equal(o.sequence, i + 1);
    assert.equal(o.sessionId, "sess-test");
    assert.equal(o.timestampMs, fixture.observations[i]!.atMs);
    assert.equal(o.source, fixture.observations[i]!.source);
    assert.equal(o.frameId, fixture.observations[i]!.frameId);
    assert.equal(o.sourceRevision, fixture.observations[i]!.sourceRevision);
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

test("events that fall due while paused are dropped, not deferred; later ones keep their wall-clock time", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(6000);
  const before = seen.length;
  assert.equal(before, 3);
  await bridge.pause();
  assert.deepEqual([statuses.at(-1)!.state, statuses.at(-1)!.reason], ["paused", "user-paused"]);
  clock.advance(4000); // 6000 -> 10000: obs-004 (8000) falls inside the pause
  assert.equal(seen.length, before, "nothing while paused");
  assert.equal(clock.pendingTimers(), 0, "no pending emission survives a pause");

  const result = await bridge.resume();
  assert.deepEqual(result, { state: "capturing" });
  assert.equal(statuses.at(-1)!.state, "capturing");
  clock.advance(0);
  assert.equal(seen.length, before, "no burst on resume");
  assert.deepEqual(bridge.dropped, ["obs-004"], "the paused observation is dropped");

  clock.advance(999);
  assert.equal(seen.length, before, "obs-005 is due at 11000 on the wall clock, not 2000 ms after resume");
  clock.advance(1);
  assert.equal(seen.length, before + 1);
  assert.equal(seen.at(-1)!.id, "obs-005");
  assert.equal(seen.at(-1)!.timestampMs, 11_000, "wall-clock offset, unchanged by the pause");

  clock.advance(fixture.durationMs);
  assert.deepEqual(
    seen.map((o) => o.id),
    fixture.observations.map((o) => o.id).filter((id) => id !== "obs-004"),
    "everything except the paused observation arrives, in order",
  );
  assert.deepEqual(seen.map((o) => o.sequence), seen.map((_, i) => i + 1), "sequence has no gap or repeat");
});

test("a long pause drops the whole remaining timeline: nothing is replayed after resume", async () => {
  const { clock, bridge, seen } = await setup();
  clock.advance(6000);
  await bridge.pause();
  clock.advance(60_000);
  assert.equal(seen.length, 3);
  assert.deepEqual(await bridge.resume(), { state: "capturing" });
  clock.advance(60_000);
  assert.equal(seen.length, 3, "no observation from the paused interval, and none were scheduled after it");
  assert.equal(bridge.dropped.length, loadLearnCustomer07().observations.length - 3);
  assert.equal(bridge.finished, true);
});

test("off the record: pause('off_record') reports the reason and emits nothing more", async () => {
  const { clock, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  const n = seen.length;
  await bridge.pause("off_record");
  assert.deepEqual([statuses.at(-1)!.state, statuses.at(-1)!.reason], ["paused", "off_record"]);
  assert.equal(validateScreenStatus(statuses.at(-1)).ok, true);
  clock.advance(30_000);
  assert.equal(seen.length, n);
});

test("a refused resume resolves with the reason and is not an error; the session keeps its epoch", async () => {
  const { clock, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.pause("off_record");
  bridge.blockResume("geometry-changed");
  const refused = await bridge.resume();
  assert.deepEqual(refused, { state: "paused", reason: "geometry-changed" });
  assert.deepEqual([statuses.at(-1)!.state, statuses.at(-1)!.reason], ["paused", "geometry-changed"]);
  clock.advance(10_000);
  assert.equal(seen.length, 2, "still nothing while the resume is blocked");

  bridge.blockResume(null);
  assert.deepEqual(await bridge.resume(), { state: "capturing" });
  clock.advance(1000); // wall clock 14000: obs-007 is due at 14000
  assert.equal(seen.at(-1)!.id, "obs-007");
  assert.equal(seen.at(-1)!.timestampMs, 14_000);
});

test("pause and resume on a bridge that is not paused or capturing are harmless", async () => {
  const clock = new FakeClock(EPOCH);
  const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
  await bridge.pause(); // idle: no-op
  assert.deepEqual(await bridge.resume(), { state: "stopped" });
  const { bridge: running } = await setup();
  assert.deepEqual(await running.resume(), { state: "capturing" }, "resume while capturing is a no-op");
});

test("stop() ends emission and reports stopped; start() again restarts the replay through mask review", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.stop();
  assert.equal(statuses.at(-1)!.state, "stopped");
  const n = seen.length;
  assert.equal(n, 2);
  clock.advance(60_000);
  assert.equal(seen.length, n, "nothing after stop");

  const epoch2 = clock.now();
  const restarted = await bridge.start({ sessionId: "sess-test-2", sessionEpochMs: epoch2 });
  assert.deepEqual(restarted, { state: "paused", reason: "mask-review" });
  assert.equal(statuses.at(-1)!.state, "paused");
  assert.equal(bridge.emitted.length, 0, "replay state is reset");
  assert.equal(bridge.dropped.length, 0);
  await bridge.confirmMasks();
  assert.equal(statuses.at(-1)!.state, "capturing");
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

test("resolveEvidence returns the asset; a pause does not shift evidence times (paused time is a gap)", async () => {
  const { clock, bridge } = await setup();
  await assert.rejects(bridge.resolveEvidence("ev-f-0001"), /unknown or not yet emitted/);
  clock.advance(1);
  const first = await bridge.resolveEvidence("ev-f-0001");
  assert.deepEqual(first, { assetRef: "mock://frames/f-0001.png", startMs: 0, endMs: 1000 });
  clock.advance(8000);
  await bridge.pause();
  clock.advance(1000);
  await bridge.resume();
  clock.advance(2000); // observation at 11000 references the clip
  const clip = await bridge.resolveEvidence("ev-clip-template-replaced");
  assert.equal(clip.assetRef, "mock://clips/template-replaced.webm");
  assert.equal(clip.startMs, 8000);
  assert.equal(clip.endMs, 20000);
  await assert.rejects(bridge.resolveEvidence("nope"));
});

test("checkpoint at Preview carries the latest observations, the workspace revisions and facts; replies are validated", async () => {
  const { clock, fixture, bridge, seen } = await setup();
  clock.advance(fixture.durationMs);
  const got: string[][] = [];
  bridge.onCheckpoint((c) => got.push(c.observationIds));
  const cp = bridge.raiseCheckpoint();
  const lastOrder = seen.filter((o) => o.kind === "order_view").at(-1)!;
  const lastEmail = seen.filter((o) => o.kind === "email_draft").at(-1)!;
  assert.deepEqual(got[0], [lastOrder.id, lastEmail.id]);
  assert.equal(validateActionCheckpoint(cp).ok, true);
  assert.deepEqual(cp.revisions, { order: lastOrder.sourceRevision, email: lastEmail.sourceRevision });
  assert.deepEqual(cp.facts, { order: lastOrder.facts, email: lastEmail.facts });
  assert.equal(cp.facts.email.previewState, "preview");
  const ok = { schemaVersion: 1 as const, checkpointId: cp.id, status: "unknown" as const, message: "No rule known.", evidenceIds: [], basedOn: cp.revisions };
  await bridge.replyToCheckpoint(ok);
  assert.equal(bridge.replies.length, 1);
  await assert.rejects(bridge.replyToCheckpoint({ ...ok, status: "block" as never }));
  const { basedOn: _dropped, ...withoutBasedOn } = ok;
  await assert.rejects(bridge.replyToCheckpoint(withoutBasedOn as never), /basedOn/);
});

test("a checkpoint needs a sourceRevision on the latest order and email observations", async () => {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  for (const o of fixture.observations) if (o.kind === "email_draft") o.sourceRevision = null; // e.g. an untracked external screen
  const bridge = new FakeScreenBridge(fixture, clock);
  await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH });
  await bridge.confirmMasks();
  clock.advance(fixture.durationMs);
  assert.throws(() => bridge.raiseCheckpoint(), /sourceRevision/);
});
