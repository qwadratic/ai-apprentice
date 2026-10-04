import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, dropAddedNulls, parseJsonAnswer, runCodex, toCodexSchema } from '../src/codex.ts';
import { unwrapResult, wrapRootUnion } from '../src/schema.ts';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
// Snapshot of the real schemas: VISION_RESULT_SCHEMA and WORKSPACE_VISION_SCHEMA (apps/api/screen/vision-contract.ts)
// and the schemas of three LLM tasks (apps/api/agent/llm-tasks.ts), as their prepare() builds them.
const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/api-schemas.json', import.meta.url), 'utf8')) as Record<string, Json>;
const fixture = (name: string): Json => {
  const s = FIXTURES[name];
  assert.ok(s, name);
  return s;
};

const BANNED = ['oneOf', 'const', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', '$schema', 'default'];
/** OpenAI strict mode: every object lists all properties as required and forbids extra ones; no rejected keywords. */
function assertStrict(node: unknown, path = '$'): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (!isRecord(node)) return;
  for (const key of BANNED) assert.equal(Object.hasOwn(node, key), false, `${path} has ${key}`);
  if (isRecord(node.properties)) {
    assert.deepEqual(node.required, Object.keys(node.properties), `${path}.required`);
    assert.equal(node.additionalProperties, false, `${path}.additionalProperties`);
    for (const [k, v] of Object.entries(node.properties)) assertStrict(v, `${path}.${k}`);
  }
  for (const key of ['anyOf', 'allOf']) if (Array.isArray(node[key])) assertStrict(node[key], `${path}.${key}`);
  if (node.items !== undefined) assertStrict(node.items, `${path}.items`);
}

test('every real API schema converts to a strict-mode schema with an object root', () => {
  assert.ok(Object.keys(FIXTURES).length >= 5);
  for (const [name, schema] of Object.entries(FIXTURES)) {
    const converted = toCodexSchema(wrapRootUnion(schema).schema);
    assert.equal(converted.type, 'object', name);
    assertStrict(converted, name);
  }
});

test('the vision schema keeps its branches: oneOf → anyOf, const → enum, optional ocrText → nullable and required', () => {
  const converted = toCodexSchema(wrapRootUnion(fixture('vision_result')).schema);
  const result = (converted.properties as Json).result as Json;
  const branches = result.anyOf as Json[];
  assert.equal(branches.length, 5);
  const kinds = branches.map((b) => ((b.properties as Json).kind as Json | undefined)?.enum);
  assert.deepEqual(kinds, [['order_view'], ['email_draft'], ['ticket'], ['screen_activity'], undefined]);
  const email = ((branches[1]!.properties as Json).facts as Json).properties as Json;
  const attachment = (email.attachments as Json).items as Json;
  assert.deepEqual(attachment.required, ['kind', 'ocrText']);
  assert.deepEqual((attachment.properties as Json).ocrText, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  // The generic branch: already-nullable fields stay as they are, limits are dropped, descriptions stay.
  const activity = ((branches[3]!.properties as Json).facts as Json).properties as Json;
  assert.deepEqual(activity.app, { type: ['string', 'null'], description: 'app or site named by visible branding, else null' });
  assert.deepEqual(activity.surface, { type: 'string', description: 'what is open' });
  const box = ((((activity.regions as Json).items as Json).properties as Json).box as Json);
  assert.deepEqual(box.items, { type: 'number' });
  // Pure: the input is untouched.
  assert.ok(JSON.stringify(fixture('vision_result')).includes('"oneOf"'));
});

test('dropAddedNulls removes nulls only where the client schema made a field optional, then unwrap gives the client shape', () => {
  const { schema, wrapped } = wrapRootUnion(fixture('vision_result'));
  const email = { result: { outcome: 'observation', kind: 'email_draft', facts: { recipientRef: null, subject: 's', bodyText: 'b', attachments: [{ kind: 'image', ocrText: null }], previewState: 'editing' } } };
  assert.deepEqual(unwrapResult(dropAddedNulls(email, schema), wrapped), { outcome: 'observation', kind: 'email_draft', facts: { recipientRef: null, subject: 's', bodyText: 'b', attachments: [{ kind: 'image' }], previewState: 'editing' } });
  const activity = { result: { outcome: 'observation', kind: 'screen_activity', facts: { app: null, surface: 'x', summary: 'y', change: null, entities: [], pendingAction: null, pendingRegionId: null, regions: [] } } };
  assert.deepEqual(dropAddedNulls(activity, schema), activity);
  const reply = { verdict: 'confirm', correction: null };
  assert.deepEqual(dropAddedNulls(reply, fixture('llm_reply_classification')), reply);
});

test('parseJsonAnswer reads plain or fenced JSON and refuses anything else', () => {
  assert.deepEqual(parseJsonAnswer(' {"a":1}\n'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJsonAnswer('Sure! {"a":1}'), undefined);
  assert.equal(parseJsonAnswer(''), undefined);
});

test('codexArgs: read-only exec without a git repo, schema, last message file, one -i per image, optional model and effort', () => {
  assert.deepEqual(codexArgs({ outFile: '/d/answer.txt', imageFiles: [] }), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', '/d/answer.txt']);
  assert.deepEqual(codexArgs({ outFile: '/d/o', schemaFile: '/d/s.json', imageFiles: ['/d/1.png', '/d/2.jpg'], model: 'm1', reasoning: 'low', ephemeral: true }), [
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-m', 'm1', '-c', 'model_reasoning_effort="low"',
    '--output-schema', '/d/s.json', '-o', '/d/o', '-i', '/d/1.png', '-i', '/d/2.jpg',
  ]);
});

// ---- the subprocess, with a fake `codex` on PATH ---------------------------
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === 'sleep') { setTimeout(() => {}, 30000); return; }
  if (mode === 'exit') { process.stderr.write('secret stderr'); process.exit(3); }
  const schemaFile = at('--output-schema');
  const images = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
  fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    args, cwd: process.cwd(), stdin,
    schema: schemaFile ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : null,
    images: images.map((f) => fs.readFileSync(f).toString('base64')),
  }));
  fs.writeFileSync(at('-o'), process.env.FAKE_CODEX_ANSWER);
});
`;

function setup(mode: string, answer = ''): { base: string; log: string; env: Record<string, string | undefined>; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const binDir = join(root, 'bin');
  const base = join(root, 'cwd');
  mkdirSync(binDir);
  mkdirSync(base);
  writeFileSync(join(binDir, 'codex'), FAKE);
  chmodSync(join(binDir, 'codex'), 0o755);
  const log = join(root, 'log.json');
  return {
    base, log,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_CODEX_MODE: mode, FAKE_CODEX_ANSWER: answer, FAKE_CODEX_LOG: log },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
const opts = (s: { base: string; env: Record<string, string | undefined> }, timeoutMs = 10_000) => ({ baseDir: s.base, env: s.env, timeoutMs, signal: new AbortController().signal, reasoning: 'low' });
const noTempLeft = (base: string): void => assert.deepEqual(readdirSync(base), [], 'temp dir removed');

test('vision with an image: schema and image files reach the CLI, the prompt goes in on stdin, the answer comes back', async () => {
  const s = setup('json', JSON.stringify({ result: { outcome: 'incomplete', reason: 'unreadable' } }));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const { schema, wrapped } = wrapRootUnion(fixture('vision_result'));
    const r = await runCodex({ prompt: '<system>\nS\n</system>\n\nread this frame', schema: toCodexSchema(schema), images: [{ media_type: 'image/png', data: png }] }, opts(s));
    assert.equal(r.kind, 'ok');
    assert.ok(r.kind === 'ok');
    assert.deepEqual(unwrapResult(dropAddedNulls(parseJsonAnswer(r.text), schema), wrapped), { outcome: 'incomplete', reason: 'unreadable' });
    const seen = JSON.parse(readFileSync(s.log, 'utf8')) as { args: string[]; stdin: string; schema: Json; images: string[]; cwd: string };
    assert.deepEqual(seen.args.slice(0, 4), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only']);
    assert.ok(seen.args.includes('-o') && seen.args.includes('--output-schema') && seen.args.includes('-i'));
    assert.equal(seen.args.some((a) => a.includes('read this frame')), false, 'prompt not in argv');
    assert.equal(seen.stdin, '<system>\nS\n</system>\n\nread this frame');
    assert.deepEqual(seen.images, [png]);
    assert.equal(seen.schema.type, 'object');
    assert.ok(seen.cwd.startsWith(s.base), 'runs inside the per-request temp dir');
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('completion without a schema returns the text and passes no --output-schema', async () => {
  const s = setup('json', 'hello there\n');
  try {
    const r = await runCodex({ prompt: 'ping' }, opts(s));
    assert.deepEqual(r, { kind: 'ok', text: 'hello there\n' });
    const seen = JSON.parse(readFileSync(s.log, 'utf8')) as { args: string[] };
    assert.equal(seen.args.includes('--output-schema'), false);
    assert.equal(seen.args.includes('-i'), false);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('completion with a schema returns parseable JSON', async () => {
  const s = setup('json', '{"verdict":"correct","correction":"only on weekdays"}');
  try {
    const schema = fixture('llm_reply_classification');
    const r = await runCodex({ prompt: 'classify', schema: toCodexSchema(schema) }, opts(s));
    assert.ok(r.kind === 'ok');
    assert.deepEqual(dropAddedNulls(parseJsonAnswer(r.text), schema), { verdict: 'correct', correction: 'only on weekdays' });
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('a CLI that runs past the timeout is killed and reported as timeout', async () => {
  const s = setup('sleep');
  try {
    const t0 = Date.now();
    const r = await runCodex({ prompt: 'slow' }, opts(s, 300));
    assert.deepEqual(r, { kind: 'timeout' });
    assert.ok(Date.now() - t0 < 5000);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('a non-zero exit is reported with its code, without the CLI stderr', async () => {
  const s = setup('exit');
  try {
    const r = await runCodex({ prompt: 'fail' }, opts(s));
    assert.deepEqual(r, { kind: 'exit', code: 3 });
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('a missing binary is a spawn error, and the temp dir is still removed', async () => {
  const s = setup('json');
  try {
    const r = await runCodex({ prompt: 'x' }, { ...opts(s), bin: join(s.base, 'no-such-codex') });
    assert.deepEqual(r, { kind: 'spawn_error' });
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});
