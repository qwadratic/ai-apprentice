// POST /v1/job: a model call that can read files. The request's files are written into a fresh temp directory, the engine
// runs with that directory as its working directory and read-only tools, the structured answer is returned like /v1/complete,
// and the directory is removed whatever happens. Logs carry metadata only (counts and sizes); never paths, contents or answers.
//
// This file imports only node builtins, zod and types: the tests import it directly (Node type stripping), so a relative
// runtime import would resolve differently there than under tsc.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

export const JOB_LIMITS = {
  /** Files per job. */
  maxFiles: 60,
  /** One file's UTF-8 bytes. */
  maxFileBytes: 1024 * 1024,
  /** All files together, UTF-8 bytes. */
  maxTotalBytes: 2 * 1024 * 1024,
  maxPathChars: 160,
  maxPathDepth: 6,
  maxPromptChars: 200_000,
  maxSystemChars: 20_000,
} as const;

const jsonSchema = z.record(z.string(), z.unknown());
export const JobBody = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).min(1).max(JOB_LIMITS.maxFiles),
  prompt: z.string().min(1).max(JOB_LIMITS.maxPromptChars),
  system: z.string().max(JOB_LIMITS.maxSystemChars).optional(),
  schema: jsonSchema,
  model: z.string().min(1).optional(),
}).strict();
export type JobRequest = z.infer<typeof JobBody>;
export interface JobFile { path: string; content: string }

// ---- validation -------------------------------------------------------------
/** One path segment: starts with a letter or digit, then letters, digits, dot, dash, underscore. No '.', '..', spaces or hidden files. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A relative path of safe segments joined by '/': no leading slash, no backslash, no '..', no empty segment, bounded depth and length. */
export function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > JOB_LIMITS.maxPathChars) return false;
  const parts = path.split('/');
  return parts.length <= JOB_LIMITS.maxPathDepth && parts.every((p) => SEGMENT.test(p));
}

export type FilesVerdict =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'too_many_files' | 'path_invalid' | 'path_duplicate' | 'path_conflict' | 'content_invalid' | 'file_too_large' | 'files_too_large'; index: number | null };

/** Checks the whole file set; the reason is a fixed code and never carries a path or content. */
export function validateJobFiles(files: ReadonlyArray<JobFile>): FilesVerdict {
  if (files.length < 1 || files.length > JOB_LIMITS.maxFiles) return { ok: false, reason: 'too_many_files', index: null };
  const names = new Set<string>();
  let bytes = 0;
  for (const [i, f] of files.entries()) {
    if (!safeRelativePath(f.path)) return { ok: false, reason: 'path_invalid', index: i };
    // Case-insensitive: two names that differ in case would collide on a case-insensitive disk.
    const key = f.path.toLowerCase();
    if (names.has(key)) return { ok: false, reason: 'path_duplicate', index: i };
    names.add(key);
    if (f.content.includes('\u0000')) return { ok: false, reason: 'content_invalid', index: i };
    const size = Buffer.byteLength(f.content, 'utf8');
    if (size > JOB_LIMITS.maxFileBytes) return { ok: false, reason: 'file_too_large', index: i };
    bytes += size;
    if (bytes > JOB_LIMITS.maxTotalBytes) return { ok: false, reason: 'files_too_large', index: i };
  }
  // A path that is also the folder of another file cannot be written ("a" and "a/b").
  for (const [i, f] of files.entries()) {
    const parts = f.path.toLowerCase().split('/');
    for (let n = 1; n < parts.length; n++) if (names.has(parts.slice(0, n).join('/'))) return { ok: false, reason: 'path_conflict', index: i };
  }
  return { ok: true, bytes };
}

// ---- the temp directory -----------------------------------------------------
/**
 * Runs `work` with a fresh directory under `baseDir` that holds exactly `files`. The directory (mode 0700, files 0600) is
 * removed afterwards, also when `work` throws.
 */
export async function withJobDir<T>(baseDir: string, files: ReadonlyArray<JobFile>, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(baseDir, 'job-'));
  try {
    for (const f of files) {
      const target = resolve(dir, f.path);
      // Validated already; checked again at the point of writing.
      if (!target.startsWith(dir + sep)) throw new Error('path_escape');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, f.content, { mode: 0o600, flag: 'wx' });
    }
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- running ----------------------------------------------------------------
export interface JobEngineInput {
  /** The directory that holds the job's files; the engine's working directory. */
  dir: string;
  prompt: string;
  system?: string;
  schema: Record<string, unknown>;
  model?: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export type JobEngineResult =
  | { status: 200; body: { ok: true; json: unknown; ms: number } }
  | { status: 502 | 504; body: { ok: false; error: string; subtype?: string; ms: number } };
export type JobEngine = (input: JobEngineInput) => Promise<JobEngineResult>;
export type JobResult = JobEngineResult | { status: 400; body: { ok: false; error: 'invalid_files'; reason: string; ms: number } };

export interface JobRunOptions {
  /** Parent of the per-job temp directory (the runner cwd). */
  baseDir: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Validates the files, runs `engine` in a temp directory that holds them, and cleans up. Never throws: a failure is a 502. */
export async function runJob(req: JobRequest, engine: JobEngine, o: JobRunOptions): Promise<JobResult> {
  const started = Date.now();
  const verdict = validateJobFiles(req.files);
  if (!verdict.ok) return { status: 400, body: { ok: false, error: 'invalid_files', reason: verdict.reason, ms: 0 } };
  try {
    return await withJobDir(o.baseDir, req.files, (dir) => engine({
      dir, prompt: req.prompt, system: req.system, schema: req.schema, model: req.model, signal: o.signal, timeoutMs: o.timeoutMs,
    }));
  } catch {
    // Temp-dir, write or engine failures: their messages may carry paths, so only a code is returned.
    return { status: 502, body: { ok: false, error: 'sdk_exception', subtype: 'job', ms: Date.now() - started } };
  }
}

// ---- the Claude engine: read tools only, only inside the job directory --------
export const JOB_SYSTEM_PROMPT =
  'You are a precise analysis helper inside an internal service. ' +
  'The files you need are in your working directory: read them with your read-only tools (list, read, search) before you answer, ' +
  'and answer only from them and the input. Never write, delete, move or run anything. Be concise.';

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/** `target` (absolute, or relative to `dir`) resolves to `dir` itself or something below it. */
export function pathInside(dir: string, target: string): boolean {
  if (target === '' || target.includes('\u0000') || target.startsWith('~')) return false;
  const rel = relative(dir, resolve(dir, target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A glob that could reach outside the directory: absolute, home-relative or with a '..' segment. */
function wanderingGlob(pattern: string): boolean {
  return pattern.startsWith('/') || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..');
}

/**
 * The permission callback of a job: Read, Glob and Grep inside `dir` are allowed, everything else (any other tool, any path
 * outside the directory, any glob that leaves it) is denied. Prompt text and files are untrusted, so this does not rely on the
 * model behaving.
 */
export function jobCanUseTool(dir: string): CanUseTool {
  const deny = (message: string) => ({ behavior: 'deny' as const, message });
  return async (toolName, input) => {
    if (!READ_TOOLS.has(toolName)) return deny('Only reading the files in the working directory is allowed.');
    for (const key of ['file_path', 'path']) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !pathInside(dir, value)) return deny('That path is outside the working directory.');
    }
    for (const key of ['pattern', 'glob']) {
      const value = input[key];
      if (value === undefined) continue;
      // A Grep pattern is a regular expression, not a path; only a Glob pattern and Grep's own `glob` filter are paths.
      if (key === 'pattern' && toolName !== 'Glob') continue;
      if (typeof value !== 'string' || wanderingGlob(value)) return deny('That pattern leaves the working directory.');
    }
    return { behavior: 'allow' as const, updatedInput: input };
  };
}

/**
 * The SDK options that make a call a read-only job in `dir`: only Read, Glob and Grep exist, the permission callback keeps them
 * inside the directory (the default mode asks it for anything not pre-approved, and nothing is pre-approved), no settings,
 * no session on disk.
 */
export function jobClaudeOptions(dir: string): Pick<Options, 'tools' | 'disallowedTools' | 'permissionMode' | 'canUseTool' | 'cwd' | 'settingSources' | 'persistSession'> {
  return {
    tools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'],
    permissionMode: 'default',
    canUseTool: jobCanUseTool(dir),
    cwd: dir,
    settingSources: [],
    persistSession: false,
  };
}
