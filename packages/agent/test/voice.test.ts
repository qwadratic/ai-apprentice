import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/fake/clock.ts";
import { FakeVoiceAdapter, userSays } from "../src/fake/voice-adapter.ts";
import type { VoiceEvent } from "../src/fake/voice-adapter.ts";
import { must } from "./helpers.ts";

const EPOCH = 2_000_000;

function setup(script = userSays("I paste the address as text because the customer asked for it.", 1000, 3000)) {
  const clock = new FakeClock(EPOCH);
  const voice = new FakeVoiceAdapter({ script, clock, msPerChar: 10, minSpeakMs: 100 });
  const events: VoiceEvent[] = [];
  voice.subscribe((e) => events.push(e));
  return { clock, voice, events };
}

test("script drives user_speaking and transcript events in order with relative timestamps", async () => {
  const { clock, voice, events } = setup();
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(5000);
  const types = events.map((e) => e.type + (e.type === "user_speaking" ? `:${e.speaking}` : e.type === "transcript" ? `:${e.final ? "final" : "interim"}` : ""));
  assert.deepEqual(types, [
    "status",
    "mode",
    "user_speaking:true",
    "transcript:interim",
    "user_speaking:false",
    "transcript:final",
  ]);
  const speakingTrue = must(events.find((e) => e.type === "user_speaking" && e.speaking));
  assert.equal(speakingTrue.tsMs, 1000);
  const final = must(events.find((e) => e.type === "transcript" && e.final));
  assert.equal(final.type === "transcript" && final.role, "expert");
  assert.equal(final.tsMs, 4000);
});

test("speak() emits mode speaking, an agent transcript, 'spoken' and then mode listening", async () => {
  const { clock, voice, events } = setup([]);
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  events.length = 0;
  let done = false;
  const p = voice.speak({ id: "cmd-1", text: "Why text instead of the template image?" }).then(() => {
    done = true;
  });
  assert.deepEqual(events.map((e) => e.type), ["mode"]);
  assert.equal(done, false);
  clock.advance(1000);
  await p;
  assert.deepEqual(events.map((e) => e.type), ["mode", "transcript", "spoken", "mode"]);
  const spoken = must(events.find((e) => e.type === "spoken"));
  assert.ok(spoken.type === "spoken" && spoken.commandId === "cmd-1");
  assert.equal(voice.spokenLog.length, 1);
  await assert.rejects(Promise.all([voice.speak({ id: "a", text: "one" }), voice.speak({ id: "b", text: "two" })]), /already speaking/);
});

test("cancelSpeech and pause never produce 'spoken'", async () => {
  const { clock, voice, events } = setup([]);
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  const p1 = voice.speak({ id: "c1", text: "A long question that gets cancelled before the end." });
  voice.cancelSpeech();
  await assert.rejects(p1, /cancelled/);

  const p2 = voice.speak({ id: "c2", text: "A question interrupted by off-record." });
  await voice.pause();
  await assert.rejects(p2, /paused/);
  clock.advance(60_000);
  assert.equal(events.filter((e) => e.type === "spoken").length, 0);
  assert.equal(voice.spokenLog.length, 0);
  await assert.rejects(voice.speak({ id: "c3", text: "nope" }), /paused/);
});

test("pause stops scripted input and context; events due while paused are dropped, not replayed", async () => {
  const { clock, voice, events } = setup();
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(2000); // expert started speaking at 1000
  await voice.pause();
  const n = events.length;
  clock.advance(30_000);
  assert.equal(events.length, n, "no events while paused");
  voice.sendContext("screen update while paused");
  assert.deepEqual(voice.contextUpdates, []);
  await voice.resume();
  const afterResume = events.length;
  clock.advance(60_000);
  const replayed = events.slice(afterResume).filter((e) => e.type === "transcript" || e.type === "user_speaking");
  assert.deepEqual(replayed, [], "the interim, the end of speech and the final transcript fell due while paused and are gone");
  voice.sendContext("after resume");
  assert.deepEqual(voice.contextUpdates, ["after resume"]);
});

test("the script keeps wall-clock time across a pause: later steps fire at start() + atMs", async () => {
  const script = [...userSays("early", 1000, 1000), ...userSays("late", 9000, 1000)];
  const { clock, voice, events } = setup(script);
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(500);
  await voice.pause();
  clock.advance(4500); // wall clock 5000: the first turn (1000-2000) was due while paused
  await voice.resume();
  clock.advance(3999); // 8999
  assert.equal(events.some((e) => e.type === "transcript" && e.text === "late"), false);
  clock.advance(1); // 9000: the second turn starts on the wall clock, not 9000 ms after resume
  assert.ok(events.some((e) => e.type === "user_speaking" && e.speaking && e.tsMs === 9000));
  clock.advance(1000);
  const late = must(events.find((e) => e.type === "transcript" && e.final && e.text === "late"));
  assert.equal(late.tsMs, 10_000);
  assert.equal(events.some((e) => e.type === "transcript" && e.text === "early"), false, "the early turn was dropped");
});

test("scripted transcripts may come from a novice", async () => {
  const script = [{ atMs: 100, event: { type: "transcript" as const, text: "I would send it now.", final: true, role: "novice" as const } }];
  const { clock, voice, events } = setup(script);
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  clock.advance(100);
  const t = must(events.find((e) => e.type === "transcript"));
  assert.ok(t.type === "transcript" && t.role === "novice");
});

test("unsubscribe stops delivery", async () => {
  const { voice } = setup([]);
  const got: VoiceEvent[] = [];
  const off = voice.subscribe((e) => got.push(e));
  await voice.start({ sessionId: "s", sessionEpochMs: EPOCH });
  const n = got.length;
  off();
  await voice.stop();
  assert.equal(got.length, n);
});
