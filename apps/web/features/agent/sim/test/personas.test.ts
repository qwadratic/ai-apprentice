import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILE, planClips, staleClips } from '../clip-plan.ts';
import type { ClipManifest } from '../clip-plan.ts';
import { EXPERT, NEW_HIRE, PERSONAS, clipIdOf, pickLine, validatePersona } from '../personas.ts';

const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

test('both personas are valid and say that they are synthetic', () => {
  for (const persona of Object.values(PERSONAS)) {
    assert.deepEqual(validatePersona(persona), [], persona.id);
    assert.match(persona.displayName, /synthetic/i);
    assert.match(persona.banner, /simulation/i);
  }
});

test('the two voices are different stock voices', () => {
  assert.notEqual(EXPERT.voice.voiceId, NEW_HIRE.voice.voiceId);
  for (const persona of Object.values(PERSONAS)) assert.match(persona.voice.voiceId, /^[A-Za-z0-9]{20}$/);
});

test('the expert answers every topic the brain asks about, and the teach-back first corrects and then confirms', () => {
  for (const topic of ['reason', 'essentials', 'guardrail', 'scope', 'exception', 'why_stop', 'duration']) {
    assert.equal(pickLine(EXPERT, topic, null, 0).known, true, topic);
  }
  assert.equal(pickLine(EXPERT, 'teachback', null, 0).line.id, 'teachback_correct');
  assert.equal(pickLine(EXPERT, 'teachback', null, 1).line.id, 'teachback_confirm');
  assert.equal(pickLine(EXPERT, 'teachback', null, 7).line.id, 'teachback_confirm', 'the last line repeats');
});

test('the expert carries the customer_07 rule as spoken knowledge', () => {
  const said = (topic: string): string => pickLine(EXPERT, topic, null, 0).line.text.toLowerCase();
  assert.match(said('reason'), /customer zero seven/);
  assert.match(said('reason'), /text/);
  assert.match(said('reason'), /phone blocks pictures/);
  assert.match(said('essentials'), /address/);
  assert.match(said('essentials'), /window/);
  assert.match(said('exception'), /extra picture is fine/);
  assert.match(said('guardrail'), /cannot tell which customer/);
  assert.match(said('guardrail'), /account manager/);
});

test('a topic with no answer falls back to an honest "not sure", for both personas', () => {
  for (const persona of [EXPERT, NEW_HIRE]) {
    const picked = pickLine(persona, 'something_unplanned', null, 0);
    assert.equal(picked.known, false);
    assert.equal(picked.line.id, persona.unsure);
    assert.match(picked.line.text, /not sure/i);
  }
});

test('the new hire predicts per case and knows nothing of the rule before it is taught', () => {
  assert.equal(pickLine(NEW_HIRE, 'predict', 'new-image', 0).line.id, 'predict_t1');
  assert.equal(pickLine(NEW_HIRE, 'predict', 'new-text-image', 0).line.id, 'predict_t2');
  assert.equal(pickLine(NEW_HIRE, 'predict', 'other', 0).line.id, 'predict_t3');
  assert.equal(pickLine(NEW_HIRE, 'predict', 'unknown', 0).line.id, 'predict_t4');
  assert.equal(pickLine(NEW_HIRE, 'predict', null, 0).line.id, 'predict_usual');
  // Before the tutor explains, the new hire does not mention phones, pictures being blocked or the account manager.
  for (const id of ['predict_t1', 'predict_usual', 'why_hold']) {
    const text = NEW_HIRE.lines.find((l) => l.id === id)?.text ?? '';
    assert.doesNotMatch(text, /phone|blocks|account manager/i, id);
  }
});

test('the voice clips match the persona texts: no clip is stale, every file exists, the total stays under 3 MB', () => {
  const manifest = JSON.parse(readFileSync(join(SIM_DIR, MANIFEST_FILE), 'utf8')) as ClipManifest;
  const planned = planClips();
  const stale = staleClips(planned, manifest, (file) => existsSync(join(SIM_DIR, file)));
  assert.deepEqual(
    stale.map((s) => s.clipId),
    [],
    'run scripts/render-clips.ts: these lines changed after their clips were rendered',
  );
  let total = 0;
  for (const clip of planned) {
    const entry = manifest.clips[clip.clipId];
    assert.ok(entry, clip.clipId);
    assert.equal(entry.voiceId, PERSONAS[clip.persona].voice.voiceId);
    assert.equal(entry.text, clip.text);
    const bytes = statSync(join(SIM_DIR, clip.file)).size;
    assert.equal(bytes, entry.bytes, `${clip.clipId} size matches the manifest`);
    total += bytes;
  }
  assert.ok(total < 3 * 1024 * 1024, `${total} bytes`);
  assert.equal(Object.keys(manifest.clips).length, planned.length, 'no clip in the manifest without a line');
});

test('the manifest and the clips carry no key', () => {
  const manifest = readFileSync(join(SIM_DIR, MANIFEST_FILE), 'utf8');
  assert.doesNotMatch(manifest, /xi-api-key|sk_[a-f0-9]{20,}|api[_-]?key/i);
});

test('clip ids are persona.line', () => {
  assert.equal(clipIdOf('expert', 'reason'), 'expert.reason');
  assert.ok(planClips().every((c) => c.clipId === `${c.persona}.${c.lineId}`));
});
