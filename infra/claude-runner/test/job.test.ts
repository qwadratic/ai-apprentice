import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_LIMITS, JobBody, jobCanUseTool, jobClaudeOptions, pathInside, runJob, safeRelativePath, validateJobFiles, withJobDir } from '../src/job.ts';
import type { JobEngine, JobEngineInput, JobFile } from '../src/job.ts';
import { dropAddedNulls, parseJsonAnswer, runCodex, toCodexSchema } from '../src/codex.ts';
import { unwrapResult, wrapRootUnion } from '../src/schema.ts';

const SCHEMA = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
const file = (path: string, content = 'x'): JobFile => ({ path, content });
const body = (over: Record<string, unknown> = {}) => ({ files: [file('a.txt')], prompt: 'read it', schema: SCHEMA, ...over });
const scratch = (): { base: string; done: () => void } => {
  const base = mkdtempSync(join(tmpdir(), 'job-test-'));
  return { base, done: () => rmSync(base, { recursive: true, force: true }) };
};
const noTempLeft = (base: string): void => assert.deepEqual(readdirSync(base), [], 'temp dir removed');
const signal = new AbortController().signal;

// ---- validation -------------------------------------------------------------
test('safeRelativePath accepts plain relative paths and refuses everything that could leave the directory', () => {
  for (const ok of ['a.txt', 'sessions/abc-123/transcript.tsv', 'maps/M1.json', 'a/b/c/d/e/f.txt', 'x_y-z.1']) assert.equal(safeRelativePath(ok), true, ok);
  const bad = [
    '', '/etc/passwd', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a/', '/', '.hidden', 'a/.hidden', '..', '.', 'a\\b', 'C:\\x', '~/x',
    'a b.txt', 'a\u0000b', 'caf\u00e9.txt', 'a/b/c/d/e/f/g.txt', `${'a'.repeat(65)}.txt`, 'x'.repeat(JOB_LIMITS.maxPathChars + 1), '-lead.txt',
  ];
  for (const path of bad) assert.equal(safeRelativePath(path), false, JSON.stringify(path));
});

test('validateJobFiles: duplicates (also by case), a file that is another file\'s folder, NUL, size caps and counts are refused with a fixed reason', () => {
  assert.deepEqual(validateJobFiles([file('a.txt', 'abc'), file('d/b.txt', 'de')]), { ok: true, bytes: 5 });
  assert.deepEqual(validateJobFiles([file('a.txt'), file('A.TXT')]), { ok: false, reason: 'path_duplicate', index: 1 });
  assert.deepEqual(validateJobFiles([file('a'), file('a/b')]), { ok: false, reason: 'path_conflict', index: 1 });
  assert.deepEqual(validateJobFiles([file('a/b'), file('A')]), { ok: false, reason: 'path_conflict', index: 0 });
  assert.deepEqual(validateJobFiles([file('a.txt', 'a\u0000b')]), { ok: false, reason: 'content_invalid', index: 0 });
  assert.deepEqual(validateJobFiles([file('ok.txt'), file('../x.txt')]), { ok: false, reason: 'path_invalid', index: 1 });
  assert.deepEqual(validateJobFiles([file('big.txt', 'x'.repeat(JOB_LIMITS.maxFileBytes + 1))]), { ok: false, reason: 'file_too_large', index: 0 });
  // Bytes, not characters: a 2-byte character counts twice.
  assert.deepEqual(validateJobFiles([file('wide.txt', '\u00e9'.repeat(JOB_LIMITS.maxFileBytes / 2 + 1))]), { ok: false, reason: 'file_too_large', index: 0 });
  const chunk = 'y'.repeat(JOB_LIMITS.maxFileBytes);
  assert.deepEqual(validateJobFiles([file('a.txt', chunk), file('b.txt', chunk), file('c.txt', 'z')]), { ok: false, reason: 'files_too_large', index: 2 });
  assert.equal(validateJobFiles([file('a.txt', chunk), file('b.txt', chunk)]).ok, true, 'exactly the total cap passes');
  const many = Array.from({ length: JOB_LIMITS.maxFiles + 1 }, (_, i) => file(`f${i}.txt`));
  assert.deepEqual(validateJobFiles(many), { ok: false, reason: 'too_many_files', index: null });
  assert.equal(validateJobFiles(many.slice(0, JOB_LIMITS.maxFiles)).ok, true);
  assert.deepEqual(validateJobFiles([]), { ok: false, reason: 'too_many_files', index: null });
});

test('JobBody: files, prompt and schema are required, extras and oversized parts are refused, system and model are optional', () => {
  assert.equal(JobBody.safeParse(body()).success, true);
  assert.equal(JobBody.safeParse(body({ system: 'S', model: 'm' })).success, true);
  for (const bad of [
    { prompt: 'p', schema: SCHEMA }, { files: [file('a')], schema: SCHEMA }, { files: [file('a')], prompt: 'p' },
    body({ files: [] }), body({ prompt: '' }), body({ extra: 1 }), body({ files: [{ path: 'a', content: 'x', mode: 1 }] }),
    body({ files: [{ path: 'a' }] }), body({ files: [{ path: 1, content: 'x' }] }), body({ schema: [] }),
    body({ files: Array.from({ length: JOB_LIMITS.maxFiles + 1 }, (_, i) => file(`f${i}`)) }),
    body({ prompt: 'p'.repeat(JOB_LIMITS.maxPromptChars + 1) }),
  ]) assert.equal(JobBody.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  // An error names the field path only, never the value.
  const r = JobBody.safeParse(body({ files: [{ path: 'secret-name', content: 5 }] }));
  assert.ok(!r.success);
  assert.deepEqual(r.error.issues.map((i) => i.path.join('.')), ['files.0.content']);
});

// ---- the temp directory -----------------------------------------------------
test('withJobDir writes exactly the files (nested, private) and removes the directory afterwards, also when the work throws', async () => {
  const s = scratch();
  try {
    let seenDir = '';
    const out = await withJobDir(s.base, [file('top.txt', 'T'), file('deep/er/file.json', '{"a":1}'), file('sessions/s1/transcript.tsv', 'caf\u00e9')], async (dir) => {
      seenDir = dir;
      assert.equal(dir.startsWith(s.base), true);
      assert.equal(readFileSync(join(dir, 'top.txt'), 'utf8'), 'T');
      assert.equal(readFileSync(join(dir, 'deep/er/file.json'), 'utf8'), '{"a":1}');
      assert.equal(readFileSync(join(dir, 'sessions/s1/transcript.tsv'), 'utf8'), 'caf\u00e9');
      assert.equal(statSync(join(dir, 'top.txt')).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(dir).sort(), ['deep', 'sessions', 'top.txt']);
      return 'done';
    });
    assert.equal(out, 'done');
    assert.ok(seenDir !== '');
    noTempLeft(s.base);
    await assert.rejects(withJobDir(s.base, [file('a.txt')], async () => { throw new Error('engine blew up'); }), /engine blew up/);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('withJobDir never writes outside its directory, even when asked to with an unvalidated path', async () => {
  const s = scratch();
  try {
    await assert.rejects(withJobDir(s.base, [file('../escape.txt')], async () => 'unreachable'), /path_escape/);
    await assert.rejects(withJobDir(s.base, [file('/tmp/abs.txt')], async () => 'unreachable'), /path_escape/);
    noTempLeft(s.base);
    assert.equal(readdirSync(join(s.base, '..')).includes('escape.txt'), false);
  } finally {
    s.done();
  }
});

// ---- runJob with a mock engine ----------------------------------------------
const req = (over: Record<string, unknown> = {}) => JobBody.parse(body(over));

test('runJob: the engine gets a directory with the files and the request\'s prompt, system, schema and model; its answer comes back; the directory is gone', async () => {
  const s = scratch();
  try {
    let seen: (JobEngineInput & { listing: string[] }) | undefined;
    const engine: JobEngine = async (input) => {
      seen = { ...input, listing: readdirSync(input.dir).sort() };
      return { status: 200, body: { ok: true, json: { answer: readFileSync(join(input.dir, 'a.txt'), 'utf8') }, ms: 7 } };
    };
    const r = await runJob(req({ files: [file('a.txt', 'hello'), file('sub/b.txt', 'b')], system: 'SYS', model: 'claude-x' }), engine, { baseDir: s.base, timeoutMs: 1234, signal });
    assert.deepEqual(r, { status: 200, body: { ok: true, json: { answer: 'hello' }, ms: 7 } });
    assert.ok(seen);
    assert.deepEqual(seen.listing, ['a.txt', 'sub']);
    assert.deepEqual([seen.prompt, seen.system, seen.model, seen.timeoutMs, seen.signal], ['read it', 'SYS', 'claude-x', 1234, signal]);
    assert.deepEqual(seen.schema, SCHEMA);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('runJob: rejected files answer 400 invalid_files with the reason only; the engine is never called and nothing is written', async () => {
  const s = scratch();
  try {
    let calls = 0;
    const engine: JobEngine = async () => { calls++; return { status: 200, body: { ok: true, json: {}, ms: 1 } }; };
    for (const [files, reason] of [
      [[file('../x')], 'path_invalid'], [[file('a'), file('a')], 'path_duplicate'], [[file('a'), file('a/b')], 'path_conflict'],
      [[file('a', 'x'.repeat(JOB_LIMITS.maxFileBytes + 1))], 'file_too_large'],
    ] as const) {
      const r = await runJob(req({ files }), engine, { baseDir: s.base, timeoutMs: 1000, signal });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { ok: false, error: 'invalid_files', reason, ms: 0 });
    }
    assert.equal(calls, 0);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('runJob: an engine that throws, or a base directory that cannot be used, is a 502 without any path or message; the engine\'s own errors pass through', async () => {
  const s = scratch();
  try {
    const boom: JobEngine = async () => { throw new Error(`secret ${s.base}`); };
    const r = await runJob(req(), boom, { baseDir: s.base, timeoutMs: 1000, signal });
    assert.equal(r.status, 502);
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'ms', 'ok', 'subtype']);
    assert.ok(!JSON.stringify(r).includes(s.base));
    noTempLeft(s.base);
    const missing = await runJob(req(), boom, { baseDir: join(s.base, 'no-such-dir'), timeoutMs: 1000, signal });
    assert.equal(missing.status, 502);
    const timeout: JobEngine = async () => ({ status: 504, body: { ok: false, error: 'timeout', ms: 5 } });
    assert.deepEqual(await runJob(req(), timeout, { baseDir: s.base, timeoutMs: 1000, signal }), { status: 504, body: { ok: false, error: 'timeout', ms: 5 } });
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

// ---- the Codex engine with a fake `codex` that lists its working directory ---
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const tree = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tree(path.join(dir, e.name), prefix + e.name + '/') : [[prefix + e.name, fs.readFileSync(path.join(dir, e.name), 'utf8')]]);
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_MODE === 'sleep') { setTimeout(() => {}, 30000); return; }
  fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd(), stdin, files: Object.fromEntries(tree(process.cwd())) }));
  fs.writeFileSync(at('-o'), process.env.FAKE_CODEX_ANSWER);
});
`;

function codexSetup(mode: string, answer: string) {
  const root = mkdtempSync(join(tmpdir(), 'job-codex-'));
  const bin = join(root, 'bin');
  const base = join(root, 'cwd');
  mkdirSync(bin);
  mkdirSync(base);
  writeFileSync(join(bin, 'codex'), FAKE);
  chmodSync(join(bin, 'codex'), 0o755);
  const log = join(root, 'log.json');
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CODEX_MODE: mode, FAKE_CODEX_ANSWER: answer, FAKE_CODEX_LOG: log };
  // The same wiring server.ts uses for a job: wrapped schema, the job directory as the CLI's cwd, per-request files elsewhere.
  const engine = (timeoutMs = 10_000): JobEngine => async (input) => {
    const output = wrapRootUnion(input.schema);
    const r = await runCodex({ prompt: `<system>\nS\n</system>\n\n${input.prompt}`, schema: toCodexSchema(output.schema) },
      { baseDir: base, cwd: input.dir, env, timeoutMs: input.timeoutMs ?? timeoutMs, signal: input.signal, reasoning: 'low' });
    if (r.kind === 'timeout') return { status: 504, body: { ok: false, error: 'timeout', ms: 1 } };
    if (r.kind !== 'ok') return { status: 502, body: { ok: false, error: 'sdk_error', ms: 1 } };
    const parsed = parseJsonAnswer(r.text);
    const json = parsed === undefined ? undefined : unwrapResult(dropAddedNulls(parsed, output.schema), output.wrapped);
    return json === undefined ? { status: 502, body: { ok: false, error: 'no_structured_output', ms: 1 } } : { status: 200, body: { ok: true, json, ms: 1 } };
  };
  return { base, log, engine, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('Codex job: the CLI runs read-only inside the directory that holds exactly the job files; both directories are removed', async () => {
  const s = codexSetup('json', JSON.stringify({ answer: 'from the files' }));
  try {
    const r = await runJob(req({ files: [file('sessions/s1/transcript.tsv', 'expert\twords'), file('README.txt', 'read me')], prompt: 'find the words' }), s.engine(), { baseDir: s.base, timeoutMs: 10_000, signal });
    assert.deepEqual(r, { status: 200, body: { ok: true, json: { answer: 'from the files' }, ms: 1 } });
    const seen = JSON.parse(readFileSync(s.log, 'utf8')) as { args: string[]; cwd: string; stdin: string; files: Record<string, string> };
    assert.deepEqual(seen.args.slice(0, 4), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only']);
    assert.ok(seen.args.includes('--output-schema') && seen.args.includes('-o'));
    assert.equal(seen.args.some((a) => a.includes('find the words')), false, 'the prompt is on stdin, not in argv');
    assert.match(seen.stdin, /find the words/);
    assert.ok(seen.cwd.includes('/job-'), 'the working directory is the job directory');
    assert.deepEqual(seen.files, { 'README.txt': 'read me', 'sessions/s1/transcript.tsv': 'expert\twords' }, 'it sees the job files and nothing else (no schema, no answer file)');
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('Codex job: a CLI that runs past the timeout is killed, answers 504 and the directories are removed', async () => {
  const s = codexSetup('sleep', '');
  try {
    const t0 = Date.now();
    const r = await runJob(req(), s.engine(), { baseDir: s.base, timeoutMs: 300, signal });
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t0 < 5000);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

test('Codex job: a client that went away stops the CLI and still cleans up', async () => {
  const s = codexSetup('sleep', '');
  try {
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 150);
    const r = await runJob(req(), s.engine(), { baseDir: s.base, timeoutMs: 10_000, signal: gone.signal });
    assert.equal(r.status, 502);
    noTempLeft(s.base);
  } finally {
    s.done();
  }
});

// ---- the Claude engine's read-only scope ------------------------------------
test('pathInside: the directory itself and anything below it, nothing else', () => {
  const dir = '/var/lib/x/job-abc';
  for (const ok of [dir, `${dir}/a.txt`, 'a.txt', 'sub/b.txt', './a.txt', `${dir}/sub/../a.txt`, '.']) assert.equal(pathInside(dir, ok), true, ok);
  for (const bad of ['/etc/passwd', '../a.txt', 'sub/../../a.txt', `${dir}/../other/a.txt`, `${dir}-evil/a.txt`, '/var/lib/x', '/proc/self/environ', '~/a', '', 'a\u0000b']) assert.equal(pathInside(dir, bad), false, JSON.stringify(bad));
});

test('jobCanUseTool: Read, Glob and Grep inside the directory pass; every other tool, path or glob that leaves it is denied', async () => {
  const dir = '/var/lib/x/job-abc';
  const can = jobCanUseTool(dir);
  const ask = (tool: string, input: Record<string, unknown>) => can(tool, input, { signal });
  const allowed = [
    ['Read', { file_path: `${dir}/sessions/s1/transcript.tsv` }], ['Read', { file_path: 'a.txt', offset: 3, limit: 50 }],
    ['Glob', { pattern: '**/*.tsv' }], ['Glob', { pattern: '*.json', path: dir }], ['Grep', { pattern: 'a|b..c', path: dir }],
    // A regular expression is not a path: its dots and slashes mean nothing to the file system.
    ['Grep', { pattern: '../x', glob: '*.tsv' }],
  ] as const;
  for (const [tool, input] of allowed) assert.equal((await ask(tool, { ...input })).behavior, 'allow', `${tool} ${JSON.stringify(input)}`);
  const denied = [
    ['Read', { file_path: '/etc/passwd' }], ['Read', { file_path: '../secret' }], ['Read', { file_path: '/proc/self/environ' }], ['Read', { file_path: 7 }],
    ['Glob', { pattern: '../**' }], ['Glob', { pattern: '/etc/*' }], ['Glob', { pattern: '~/*' }], ['Glob', { pattern: '*.txt', path: '/etc' }],
    ['Grep', { pattern: 'x', path: '/var/lib' }], ['Grep', { pattern: 'x', glob: '../*' }],
    ['Bash', { command: 'cat /etc/passwd' }], ['Write', { file_path: `${dir}/a.txt`, content: 'x' }], ['Edit', { file_path: `${dir}/a.txt` }],
    ['WebFetch', { url: 'https://example.com' }], ['Agent', { prompt: 'x' }], ['mcp__x__y', {}],
  ] as const;
  for (const [tool, input] of denied) assert.equal((await ask(tool, { ...input })).behavior, 'deny', `${tool} ${JSON.stringify(input)}`);
});

test('jobClaudeOptions: only the three read tools exist, nothing is pre-approved, the cwd is the job directory, nothing is stored', () => {
  const o = jobClaudeOptions('/var/lib/x/job-abc');
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep']);
  assert.equal(o.cwd, '/var/lib/x/job-abc');
  assert.equal(o.permissionMode, 'default');
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.persistSession, false);
  assert.ok(typeof o.canUseTool === 'function');
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) assert.ok(o.disallowedTools?.includes(t), t);
  assert.equal('allowedTools' in o, false, 'no tool is auto-approved: every call goes through canUseTool or the in-directory read default');
});
