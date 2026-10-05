// Codex engine (RUNNER_ENGINE=codex): each request runs `codex exec` as a subprocess, logged in with the
// account in $CODEX_HOME (default ~/.codex). The prompt goes in on stdin, never on the command line (argv is
// visible to every local user); schema and images go into a per-request temp dir that is always removed.
// Nothing from the prompt, the images, the answer or the CLI's stdout/stderr is logged.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonSchema } from './schema.js';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Keywords OpenAI strict structured output rejects or may reject; the API server validates every answer with
// its own parsers, so dropping them loses no safety.
const STRIPPED = new Set([
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'default', 'examples', '$schema',
]);

const nullable = (s: Json): Json => ({ anyOf: [s, { type: 'null' }] });

/**
 * A JSON Schema rewritten for OpenAI strict mode: every object lists all its properties in `required` (an
 * optional one becomes nullable) and has `additionalProperties: false`; `oneOf` becomes `anyOf`, `const`
 * becomes a one-value `enum`; unsupported keywords are dropped. The root must already be an object
 * (`wrapRootUnion`). Pure: the input is not changed.
 */
export function toCodexSchema(schema: JsonSchema): JsonSchema {
  return convert(schema);
}

function convert(node: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) continue;
    if (key === 'const') {
      out.enum = [value];
    } else if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      const target = key === 'allOf' ? 'allOf' : 'anyOf';
      out[target] = Array.isArray(value) ? value.map((b) => (isRecord(b) ? convert(b) : b)) : value;
    } else if (key === 'items') {
      out.items = isRecord(value) ? convert(value) : value;
    } else if (key === '$defs' || key === 'definitions') {
      out[key] = isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isRecord(v) ? convert(v) : v])) : value;
    } else if (key !== 'properties' && key !== 'required' && key !== 'additionalProperties') {
      out[key] = value;
    }
  }
  if (isRecord(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === 'string') : []);
    const properties: Json = {};
    for (const [name, prop] of Object.entries(node.properties)) {
      if (!isRecord(prop)) continue;
      const converted = convert(prop);
      properties[name] = required.has(name) || allowsNull(prop) ? converted : nullable(converted);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  } else if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
    out.additionalProperties = false;
  }
  // Strict mode wants a `type` next to every `enum` (a bare enum or a former const has none).
  if (Array.isArray(out.enum) && out.type === undefined) {
    const types = [...new Set(out.enum.map(jsonType))];
    out.type = types.length === 1 ? types[0] : types;
  }
  return out;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string' || typeof v === 'boolean') return typeof v;
  return Array.isArray(v) ? 'array' : 'object';
}

function allowsNull(s: unknown): boolean {
  if (!isRecord(s)) return false;
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  if (Object.hasOwn(s, 'const') && s.const === null) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.some(allowsNull)) return true;
  }
  return false;
}

/**
 * Undo the nullable rewrite on an answer: a `null` for a property that the client's schema made optional and
 * not nullable is removed, so the client sees the shape its own schema describes. Union branches are matched
 * by their `const`/one-value `enum` properties.
 */
export function dropAddedNulls(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  const union = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (union) {
    const branch = union.find((b) => matchesBranch(value, b));
    return branch === undefined ? value : dropAddedNulls(value, branch);
  }
  if (Array.isArray(value)) return isRecord(schema.items) ? value.map((v) => dropAddedNulls(v, schema.items)) : value;
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  const props = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    const prop = props[key];
    if (v === null && !required.has(key) && prop !== undefined && !allowsNull(prop)) continue;
    out[key] = prop === undefined ? v : dropAddedNulls(v, prop);
  }
  return out;
}

function matchesBranch(value: unknown, branch: unknown): boolean {
  if (!isRecord(branch)) return false;
  if (!isRecord(branch.properties)) return !isRecord(value) && !Array.isArray(value);
  if (!isRecord(value)) return false;
  const props = branch.properties;
  for (const key of Object.keys(value)) if (!Object.hasOwn(props, key)) return false;
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const fixed = Object.hasOwn(prop, 'const') ? [prop.const] : Array.isArray(prop.enum) && prop.enum.length === 1 ? prop.enum : undefined;
    if (fixed && value[key] !== fixed[0]) return false;
  }
  return true;
}

// ---- running one `codex exec` ----------------------------------------------
export interface CodexImage { media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export interface CodexRequest { prompt: string; schema?: JsonSchema; images?: readonly CodexImage[] }
export interface CodexOptions {
  /** Parent of the per-request temp dir (the runner cwd). */
  baseDir: string;
  /** The CLI's working directory; default: the per-request temp dir. A job passes the directory that holds its files. */
  cwd?: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal: AbortSignal;
  /** Passed as `-m` only when set. */
  model?: string;
  /** `model_reasoning_effort` config override, e.g. "low"; empty leaves the CLI's own setting. */
  reasoning?: string;
  /** Adds `--ephemeral` (no session rollout files on disk); needs a CLI version that has the flag. */
  ephemeral?: boolean;
  bin?: string;
}
export type CodexOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'exit'; code: number | null }
  | { kind: 'spawn_error' };

const EXT: Record<CodexImage['media_type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The argv after `codex`; the prompt is not part of it (stdin). */
export function codexArgs(o: { outFile: string; schemaFile?: string; imageFiles: readonly string[]; model?: string; reasoning?: string; ephemeral?: boolean }): string[] {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
  if (o.ephemeral) args.push('--ephemeral');
  if (o.model) args.push('-m', o.model);
  if (o.reasoning) args.push('-c', `model_reasoning_effort="${o.reasoning}"`);
  if (o.schemaFile) args.push('--output-schema', o.schemaFile);
  args.push('-o', o.outFile);
  for (const f of o.imageFiles) args.push('-i', f);
  return args;
}

export async function runCodex(req: CodexRequest, o: CodexOptions): Promise<CodexOutcome> {
  const dir = await mkdtemp(join(o.baseDir, 'codex-'));
  try {
    const outFile = join(dir, 'answer.txt');
    let schemaFile: string | undefined;
    if (req.schema) {
      schemaFile = join(dir, 'schema.json');
      await writeFile(schemaFile, JSON.stringify(req.schema), { mode: 0o600 });
    }
    const imageFiles: string[] = [];
    for (const [i, img] of (req.images ?? []).entries()) {
      const file = join(dir, `image-${i + 1}.${EXT[img.media_type]}`);
      await writeFile(file, Buffer.from(img.data, 'base64'), { mode: 0o600 });
      imageFiles.push(file);
    }
    const args = codexArgs({ outFile, schemaFile, imageFiles, model: o.model, reasoning: o.reasoning, ephemeral: o.ephemeral });
    const end = await spawnCodex(o.bin ?? 'codex', args, req.prompt, o.cwd ?? dir, o);
    if (end.kind !== 'exit' || end.code !== 0) return end.kind === 'exit' ? { kind: 'exit', code: end.code } : end;
    let text: string;
    try {
      text = await readFile(outFile, 'utf8');
    } catch {
      text = '';
    }
    return { kind: 'ok', text };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type SpawnEnd = { kind: 'exit'; code: number | null } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'spawn_error' };

function spawnCodex(bin: string, args: string[], prompt: string, cwd: string, o: CodexOptions): Promise<SpawnEnd> {
  return new Promise((resolve) => {
    let stopped: 'timeout' | 'aborted' | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // Own process group, so a stop also ends whatever the CLI started.
    const child = spawn(bin, args, { cwd, env: o.env, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = (why: 'timeout' | 'aborted'): void => {
      if (stopped) return;
      stopped = why;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
    const onAbort = (): void => stop('aborted');
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (end: SpawnEnd): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      resolve(stopped ? { kind: stopped } : end);
    };
    child.on('error', () => finish({ kind: 'spawn_error' }));
    child.on('close', (code) => finish({ kind: 'exit', code }));
    child.stdin.on('error', () => {}); // a CLI that exits early closes the pipe
    child.stdin.end(prompt);
  });
}

/** The answer as JSON: the whole text, or the text inside one ```json fence; undefined when unparseable. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}
