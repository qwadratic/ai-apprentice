import { test } from "node:test";
import assert from "node:assert/strict";
import { factsFromCheckpoint, validateActionCheckpoint, validateScreenObservation, validateScreenStatus } from "../src/contract-draft.ts";
import type { ScreenObservation, ScreenStatus } from "../src/contract-draft.ts";
import { FakeClock } from "../src/fake/clock.ts";
import { FakeScreenBridge } from "../src/fake/screen-bridge.ts";
import { loadLearnCustomer07 } from "../src/fake/fixture-node.ts";
import { must, lastOf } from "./helpers.ts";

const EPOCH = 5_000_000;

const statusPairs = (statuses: readonly ScreenStatus[]) => statuses.map((s) => [s.state, s.reason]);

/** Starts a session and confirms the masks immediately, so capturing begins at the epoch. */
async function setup() {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  const bridge = new FakeScreenBridge(fixture, clock);
  const seen: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  bridge.onObservation((o) => seen.push(o));
  bridge.onStatus((s) => statuses.push(s));
  await bridge.start({ sessionId: "sess-test", sessionEpochMs: EPOCH });
  await bridge.confirmMasks();
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
  const last = lastOf(emails).facts as { attachments: unknown[]; bodyText: string; previewState: string };
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

  assert.equal(await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH }), undefined, "lifecycle calls resolve to void");
  assert.deepEqual(statuses.map((s) => [s.state, s.reason]), [["paused", "mask-review"]]);
  clock.advance(60_000);
  assert.equal(seen.length, 0, "no observation before mask confirmation");

  // resume() before the masks are confirmed is refused, not an error and not capturing
  await bridge.resume();
  assert.deepEqual(statusPairs(statuses), [["paused", "mask-review"]], "a refused resume changes nothing and is only visible through status");
  clock.advance(60_000);
  assert.equal(seen.length, 0);

  await bridge.confirmMasks();
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
  assert.equal(must(seen[0]).timestampMs, 10_000, "the first observation carries the review gap");
  clock.advance(fixture.durationMs);
  seen.forEach((o, i) => assert.equal(o.timestampMs, 10_000 + must(fixture.observations[i]).atMs));
  const first = await bridge.resolveEvidence("ev-f-0001");
  assert.deepEqual(first, { assetRef: "mock://frames/f-0001.png", startMs: 10_000, endMs: 11_000 });
});

test("replay emits ordered, valid observations with timestamps relative to sessionEpochMs", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  assert.deepEqual(statuses.map((s) => s.state), ["paused", "capturing"]);
  clock.advance(fixture.durationMs);
  assert.equal(seen.length, fixture.observations.length);
  assert.ok(bridge.finished);
  seen.forEach((o, i) => {
    assert.equal(o.sequence, i + 1);
    assert.equal(o.sessionId, "sess-test");
    assert.equal(o.timestampMs, must(fixture.observations[i]).atMs);
    assert.equal(o.source, must(fixture.observations[i]).source);
    assert.equal(o.frameId, must(fixture.observations[i]).frameId);
    assert.equal(o.sourceRevision, must(fixture.observations[i]).sourceRevision);
    assert.equal(validateScreenObservation(o).ok, true);
    if (i > 0) assert.ok(o.timestampMs >= must(seen[i - 1]).timestampMs);
  });
});

test("emission is driven by the clock, not by start()", async () => {
  const { clock, seen } = await setup();
  clock.advance(1);
  assert.equal(seen.length, 1); // the order view at 0 ms
  clock.advance(4000);
  assert.equal(seen.length, 1, "no heartbeat before the first input (4800 ms)");
  clock.advance(1000);
  assert.deepEqual(seen.map((o) => o.kind), ["order_view", "input_activity", "email_draft"]); // input at 4800, email at 5000
});

test("events that fall due while paused are dropped, not deferred; later ones keep their wall-clock time", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(6000);
  const before = seen.length;
  assert.equal(before, 3);
  await bridge.pause();
  assert.deepEqual([lastOf(statuses).state, lastOf(statuses).reason], ["paused", "user-paused"]);
  clock.advance(4000); // 6000 -> 10000: hb-02 (6800), hb-03 (7800), obs-004 (8000) and hb-04 (9800) fall inside the pause
  assert.equal(seen.length, before, "nothing while paused");
  assert.equal(clock.pendingTimers(), 0, "no pending emission survives a pause");

  await bridge.resume();
  assert.equal(lastOf(statuses).state, "capturing");
  clock.advance(0);
  assert.equal(seen.length, before, "no burst on resume");
  const inPause = fixture.observations.filter((o) => o.atMs >= 6000 && o.atMs < 10_000).map((o) => o.id);
  assert.ok(inPause.includes("obs-004") && inPause.length >= 2);
  assert.deepEqual(bridge.dropped, inPause, "everything that fell due in the paused interval is dropped");

  clock.advance(799);
  assert.equal(seen.length, before, "hb-05 is due at 10800 on the wall clock, not 800 ms after a replay");
  clock.advance(1);
  assert.equal(lastOf(seen).id, "hb-05");
  clock.advance(199);
  assert.equal(seen.length, before + 1, "obs-005 is due at 11000");
  clock.advance(1);
  assert.equal(seen.length, before + 2);
  assert.equal(lastOf(seen).id, "obs-005");
  assert.equal(lastOf(seen).timestampMs, 11_000, "wall-clock offset, unchanged by the pause");

  clock.advance(fixture.durationMs);
  assert.deepEqual(
    seen.map((o) => o.id),
    fixture.observations.map((o) => o.id).filter((id) => !inPause.includes(id)),
    "everything except the paused interval arrives, in order",
  );
  assert.deepEqual(seen.map((o) => o.sequence), seen.map((_, i) => i + 1), "sequence has no gap or repeat");
});

test("a long pause drops the whole remaining timeline: nothing is replayed after resume", async () => {
  const { clock, bridge, seen, statuses } = await setup();
  clock.advance(6000);
  await bridge.pause();
  clock.advance(60_000);
  assert.equal(seen.length, 3);
  await bridge.resume();
  assert.equal(lastOf(statuses).state, "capturing");
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
  assert.deepEqual([lastOf(statuses).state, lastOf(statuses).reason], ["paused", "off_record"]);
  assert.equal(validateScreenStatus(statuses.at(-1)).ok, true);
  clock.advance(30_000);
  assert.equal(seen.length, n);
});

test("a refused resume resolves with the reason and is not an error; the session keeps its epoch", async () => {
  const { clock, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.pause("off_record");
  bridge.blockResume("geometry-changed");
  await bridge.resume();
  assert.deepEqual([lastOf(statuses).state, lastOf(statuses).reason], ["paused", "geometry-changed"]);
  clock.advance(10_000);
  assert.equal(seen.length, 1, "still nothing while the resume is blocked");

  bridge.blockResume(null);
  await bridge.resume();
  assert.equal(lastOf(statuses).state, "capturing");
  clock.advance(1000); // wall clock 14000: obs-007 is due at 14000
  assert.equal(lastOf(seen).id, "obs-007");
  assert.equal(lastOf(seen).timestampMs, 14_000);
});

test("pause and resume on a bridge that is not paused or capturing are harmless", async () => {
  const clock = new FakeClock(EPOCH);
  const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
  const idleStatuses: ScreenStatus[] = [];
  bridge.onStatus((s) => idleStatuses.push(s));
  await bridge.pause(); // idle: no-op
  await bridge.resume();
  assert.equal(idleStatuses.length, 0, "no status from an idle bridge");
  const { bridge: running, statuses } = await setup();
  const before = statuses.length;
  await running.resume(); // resume while capturing is a no-op
  assert.equal(statuses.length, before);
  assert.equal(lastOf(statuses).state, "capturing");
});

test("stop() ends emission and reports stopped; start() again restarts the replay through mask review", async () => {
  const { clock, fixture, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.stop();
  assert.equal(lastOf(statuses).state, "stopped");
  const n = seen.length;
  assert.equal(n, 1);
  clock.advance(60_000);
  assert.equal(seen.length, n, "nothing after stop");

  const epoch2 = clock.now();
  await bridge.start({ sessionId: "sess-test-2", sessionEpochMs: epoch2 });
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "mask-review"]);
  assert.equal(lastOf(statuses).state, "paused");
  assert.equal(bridge.emitted.length, 0, "replay state is reset");
  assert.equal(bridge.dropped.length, 0);
  await bridge.confirmMasks();
  assert.equal(lastOf(statuses).state, "capturing");
  clock.advance(1);
  const first = lastOf(seen);
  assert.equal(first.id, must(fixture.observations[0]).id, "replay starts again from the first observation");
  assert.equal(first.sequence, 1);
  assert.equal(first.sessionId, "sess-test-2");
  assert.equal(first.timestampMs, 0, "timestamps count from the new sessionEpochMs");
  clock.advance(fixture.durationMs);
  assert.equal(bridge.emitted.length, fixture.observations.length);
});

test("fixture heartbeats carry the real idle time: the first typing:false is about 2000 ms after the last input", () => {
  const f = loadLearnCustomer07();
  const beats = f.observations.filter((o) => o.kind === "input_activity");
  type Hb = { typing: boolean; idleMs: number; lastInputAtMs: number };
  const stop = must(beats.find((o) => !(o.facts as Hb).typing));
  const h = stop.facts as Hb;
  assert.equal(h.idleMs, stop.atMs - h.lastInputAtMs);
  assert.ok(h.idleMs >= 1500 && h.idleMs <= 2500, `about 2000 ms, got ${h.idleMs}`);
  assert.ok(beats.every((o) => o.atMs >= (o.facts as Hb).lastInputAtMs));
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

test("checkpoint at Preview carries the latest observations and the workspace revisions, not facts; replies are validated", async () => {
  const { clock, fixture, bridge, seen } = await setup();
  clock.advance(fixture.durationMs);
  const got: string[][] = [];
  bridge.onCheckpoint((c) => got.push(c.observationIds));
  const cp = bridge.raiseCheckpoint();
  const lastOrder = must(seen.filter((o) => o.kind === "order_view").at(-1));
  const lastEmail = must(seen.filter((o) => o.kind === "email_draft").at(-1));
  assert.deepEqual(got[0], [lastOrder.id, lastEmail.id]);
  assert.equal(validateActionCheckpoint(cp).ok, true);
  assert.deepEqual(cp.revisions, { order: lastOrder.sourceRevision, email: lastEmail.sourceRevision });
  assert.equal("facts" in cp, false, "a checkpoint carries no facts");
  const facts = factsFromCheckpoint(cp, seen);
  assert.deepEqual(facts, { incomplete: false, order: lastOrder.facts, email: lastEmail.facts });
  assert.equal(facts.incomplete === false && facts.email.previewState, "preview");
  const ok = { schemaVersion: 1 as const, checkpointId: cp.id, status: "unknown" as const, message: "No rule known.", evidenceIds: [], basedOn: cp.revisions };
  await bridge.replyToCheckpoint(ok);
  assert.equal(bridge.replies.length, 1);
  await assert.rejects(bridge.replyToCheckpoint({ ...ok, status: "block" as never }));
  const { basedOn: _dropped, ...withoutBasedOn } = ok;
  await assert.rejects(bridge.replyToCheckpoint(withoutBasedOn as never), /basedOn/);
  await assert.rejects(bridge.replyToCheckpoint({ ...ok, checkpointId: `${cp.sessionId}:cp-nope` }), /unknown checkpoint/);
  await assert.rejects(bridge.replyToCheckpoint({ ...ok, basedOn: { ...cp.revisions, email: "rev-email-5" } }), /revisions/);
  await assert.rejects(bridge.replyToCheckpoint({ ...ok, basedOn: { ...cp.revisions, order: "rev-order-0" } }), /revisions/);
  assert.equal(bridge.replies.length, 1, "rejected replies are not recorded");
});

test("checkpoint ids are unique across sessions; a session-1 reply is rejected in session 2", async () => {
  const { clock, fixture, bridge } = await setup();
  clock.advance(fixture.durationMs);
  const cp1 = bridge.raiseCheckpoint();
  assert.equal(cp1.id, "sess-test:cp-1");
  await bridge.stop();

  await bridge.start({ sessionId: "sess-2", sessionEpochMs: clock.now() });
  await bridge.confirmMasks();
  clock.advance(fixture.durationMs);
  const cp2 = bridge.raiseCheckpoint();
  assert.equal(cp2.id, "sess-2:cp-1");
  assert.notEqual(cp2.id, cp1.id, "the first checkpoint of a new session does not reuse an old id");

  const reply = (cp: typeof cp1) => ({ schemaVersion: 1 as const, checkpointId: cp.id, status: "clear" as const, message: "m", evidenceIds: [], basedOn: cp.revisions });
  await assert.rejects(bridge.replyToCheckpoint(reply(cp1)), /unknown checkpoint/, "a session-1 reply cannot answer session 2");
  await bridge.replyToCheckpoint(reply(cp2));
  assert.deepEqual(bridge.replies.map((x) => x.checkpointId), [cp2.id]);
});

test("lastInputAtMs moves by the same capture-start offset as timestampMs (5 s mask-review delay)", async () => {
  const clock = new FakeClock(EPOCH);
  const fixture = loadLearnCustomer07();
  const bridge = new FakeScreenBridge(fixture, clock);
  const seen: ScreenObservation[] = [];
  bridge.onObservation((o) => seen.push(o));
  await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(5000); // mask review takes 5 s
  await bridge.confirmMasks();
  clock.advance(fixture.durationMs);
  const beats = seen.filter((o) => o.kind === "input_activity");
  assert.equal(beats.length, fixture.observations.filter((o) => o.kind === "input_activity").length);
  for (const b of beats) {
    const h = b.facts as { idleMs: number; lastInputAtMs: number };
    const src = must(fixture.observations.find((o) => o.id === b.id));
    assert.equal(b.timestampMs, src.atMs + 5000);
    assert.equal(h.lastInputAtMs, (src.facts as { lastInputAtMs: number }).lastInputAtMs + 5000, `${b.id}: same offset as timestampMs`);
    assert.equal(h.idleMs, b.timestampMs - h.lastInputAtMs, `${b.id}: idleMs = timestampMs - lastInputAtMs`);
    assert.ok(h.lastInputAtMs <= b.timestampMs);
    assert.equal(validateScreenObservation(b).ok, true, b.id);
  }
});

test("confirmMasks() never lifts an off-the-record pause", async () => {
  // off_record pressed during mask review: confirming the masks must not resume.
  const clock = new FakeClock(EPOCH);
  const bridge = new FakeScreenBridge(loadLearnCustomer07(), clock);
  const seen: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  bridge.onObservation((o) => seen.push(o));
  bridge.onStatus((s) => statuses.push(s));
  await bridge.start({ sessionId: "s", sessionEpochMs: EPOCH });
  await bridge.pause("off_record");
  assert.deepEqual([lastOf(statuses).state, lastOf(statuses).reason], ["paused", "off_record"]);
  await bridge.confirmMasks();
  assert.deepEqual([lastOf(statuses).state, lastOf(statuses).reason], ["paused", "off_record"]);
  clock.advance(60_000);
  assert.equal(seen.length, 0, "still off the record");
  // the review flag is cleared, so the explicit resume works
  await bridge.resume();
  assert.equal(lastOf(statuses).state, "capturing");

  // off_record after capturing began, then confirmMasks() (e.g. a late mask edit confirmation)
  const { clock: c2, bridge: b2, seen: seen2, statuses: st2 } = await setup();
  c2.advance(3000);
  await b2.pause("off_record");
  const n = seen2.length;
  await b2.confirmMasks();
  assert.deepEqual([lastOf(st2).state, lastOf(st2).reason], ["paused", "off_record"]);
  c2.advance(30_000);
  assert.equal(seen2.length, n);
  assert.equal(c2.pendingTimers(), 0);
  // confirmMasks() while capturing is a no-op
  await b2.resume();
  assert.equal(lastOf(st2).state, "capturing");
  await b2.confirmMasks();
  assert.equal(lastOf(st2).state, "capturing");
});

test("pause() while already paused keeps off_record until resume() or stop()", async () => {
  const { clock, bridge, seen, statuses } = await setup();
  clock.advance(3000);
  await bridge.pause("off_record");
  const count = statuses.length;
  await bridge.pause(); // a plain pause must not downgrade the off-the-record pause
  await bridge.pause("user-paused");
  assert.equal(statuses.length, count, "no status change");
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "off_record"]);
  clock.advance(30_000);
  const n = seen.length;
  await bridge.confirmMasks();
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "off_record"], "confirmMasks does not lift it either");
  await bridge.resume();
  assert.equal(lastOf(statuses).state, "capturing", "resume() ends the off-the-record pause");
  clock.advance(10_000);
  assert.ok(seen.length >= n);

  // off_record escalates a plain pause, and stop() ends it
  await bridge.pause("user-paused");
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "user-paused"]);
  await bridge.pause("off_record");
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "off_record"]);
  await bridge.pause();
  assert.deepEqual(statusPairs(statuses).at(-1), ["paused", "off_record"]);
  await bridge.stop();
  assert.deepEqual(statusPairs(statuses).at(-1), ["stopped", "stopped"]);
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
