// The customer_07 rule is learned only from the expert's answers. No rule text in agent code, question templates or
// messages, and no source reads the scripted actors or the expected results (only tests do).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { buildTeachBack, planFollowUps, workingMap } from "../src/index.ts";
import { arr, buildState, expertAnswer, expertTeachback, readJson, rec, startLearnSession, str } from "./brain-helpers.ts";

const SRC = new URL("../src/", import.meta.url);

const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, text: readFileSync(new URL(f, SRC), "utf8").toLowerCase().replace(/[\u2018\u2019]/g, "'") }));

const FORBIDDEN = [
  "as text",
  "in the body",
  "in writing",
  "can't read images",
  "cannot read images",
  "read images",
  "read pictures",
  "blocks pictures",
  "phone blocks",
  "spell the details",
  "spell out",
  "text instead",
  "plain text",
  "email body",
  "extra picture",
  "asked me for it",
  "screenshot",
];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9_' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const paraphrases = rec(readJson("sim/paraphrases.json"));
const ANSWERS = ["reason", "essentials", "guardrail", "scope", "exception", "why_stop", "duration"]
  .map(expertAnswer)
  .concat(
    expertTeachback("correction"),
    arr(paraphrases.reasonParaphrases).map((p) => str(rec(p).text)),
    arr(paraphrases.corrections).map(str),
    str(paraphrases.spokenScope),
  );

function grams(text: string, n = 4): string[] {
  const w = words(text);
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
}

test("packages/agent/src holds no customer_07 rule text", () => {
  assert.ok(sources.length >= 20, `${sources.length} source files`);
  for (const { f, text } of sources) {
    for (const bad of FORBIDDEN) assert.ok(!text.includes(bad), `${f} contains "${bad}"`);
  }
});

test("no run of four words from any expert answer appears in the sources", () => {
  const haystack = sources.map((s) => words(s.text).join(" ")).join(" | ");
  for (const answer of ANSWERS) {
    for (const gram of grams(answer)) assert.ok(!haystack.includes(gram), `the sources contain "${gram}" from an expert answer`);
  }
});

test("no source reads the scripted actors or the expected results", () => {
  for (const { f, text } of sources) {
    assert.ok(!/expert-script|novice-script|fixtures\/agent\/(expected|teach|sim)|\/expected\//.test(text), `${f} references a script or an expected result`);
  }
});

test("questions and the first teach-back, as generated in a session, contain none of the expert's wording", async () => {
  const session = startLearnSession();
  await session.run(60_000);
  const draft = workingMap(await buildState({ followUps: false, confirm: false }));
  const texts = [...session.questions.map((q) => q.question.text), ...planFollowUps(draft, { max: 99 }).map((q) => q.text)];
  assert.ok(texts.length >= 6);
  const answerGrams = new Set(ANSWERS.flatMap((a) => grams(a)));
  for (const t of texts) {
    for (const gram of grams(t)) assert.ok(!answerGrams.has(gram), `"${t}" repeats "${gram}" from an expert answer`);
    for (const bad of FORBIDDEN) assert.ok(!t.toLowerCase().includes(bad), `"${t}" contains "${bad}"`);
  }
  // The teach-back is built from the map, so it may repeat the expert's reason; before any answer it says nothing about a rule.
  const empty = workingMap(await buildState({ answers: [], followUps: false, confirm: false }));
  assert.deepEqual(buildTeachBack(empty).text, "Let me play it back (version 1). Did I get that right?");
});
