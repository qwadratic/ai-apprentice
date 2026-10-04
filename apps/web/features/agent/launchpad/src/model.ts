// Types, validators and pure helpers: no DOM and no network, so Node can run this file as it is.
// Everything that arrives from the network is `unknown` until one of the parse functions below has checked it.

export type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- Small validators ------------------------------------------------------

const SHA = /^[0-9a-f]{7,40}$/i;

/** A git sha as our endpoints print it (7 to 40 hex characters), lower-cased; null for anything else ("unknown", null, ...). */
export function asSha(v: unknown): string | null {
  return typeof v === 'string' && SHA.test(v) ? v.toLowerCase() : null;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The same commit, whichever of the two is the abbreviated form. Both come from asSha, so each has at least 7 characters. */
export const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

function asDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asText(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A link that may be rendered from data: https on github.com and nothing else (no javascript: or data: URLs). */
export function asGithubUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// ---- Web: deploy.json ------------------------------------------------------

export interface WebDeploy {
  sha: string;
  at: Date | null;
  run: string | null;
}

export function parseWebDeploy(data: unknown): WebDeploy | null {
  if (!isRecord(data)) return null;
  const sha = asSha(data['sha']);
  if (!sha) return null;
  return { sha, at: asDate(data['at']), run: asGithubUrl(data['run']) };
}

// ---- API: /health ----------------------------------------------------------

export interface ApiHealth {
  ok: boolean;
  runner: string | null;
  deployedSha: string | null;
}

export function parseHealth(data: unknown): ApiHealth | null {
  if (!isRecord(data) || typeof data['ok'] !== 'boolean') return null;
  return { ok: data['ok'], runner: asText(data['runner']), deployedSha: asSha(data['deployed_sha']) };
}

// ---- VM: /ops/deploy/status ------------------------------------------------

export interface VmDeployLast {
  sha: string | null;
  state: string;
  message: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface VmDeploy {
  deployedSha: string | null;
  last: VmDeployLast | null;
}

export function parseOpsStatus(data: unknown): VmDeploy | null {
  if (!isRecord(data) || !('deployed_sha' in data || 'last' in data)) return null;
  const raw = data['last'];
  const state = isRecord(raw) ? asText(raw['state']) : null;
  const last: VmDeployLast | null =
    isRecord(raw) && state
      ? {
          sha: asSha(raw['sha']),
          state,
          message: asText(raw['message']),
          startedAt: asDate(raw['started_at']),
          finishedAt: asDate(raw['finished_at']),
        }
      : null;
  return { deployedSha: asSha(data['deployed_sha']), last };
}

// ---- Web and API: do they run the same commit? -----------------------------

export type SyncVerdict =
  | { kind: 'in-sync'; sha: string }
  | { kind: 'out-of-sync'; apiSha: string; webSha: string }
  | { kind: 'unknown'; reason: string };

/** `null` means the value could not be read at all (request failed or unexpected answer). */
export function syncVerdict(web: WebDeploy | null, api: ApiHealth | null): SyncVerdict {
  if (!web && !api) return { kind: 'unknown', reason: 'neither the web sha nor the API sha could be read' };
  if (!web) return { kind: 'unknown', reason: 'the web sha could not be read' };
  if (!api) return { kind: 'unknown', reason: 'the API could not be read' };
  if (!api.deployedSha) return { kind: 'unknown', reason: 'the API did not report a deployed sha' };
  return sameSha(web.sha, api.deployedSha)
    ? { kind: 'in-sync', sha: web.sha }
    : { kind: 'out-of-sync', apiSha: api.deployedSha, webSha: web.sha };
}

// ---- Pull requests ---------------------------------------------------------

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  createdAt: Date;
  labels: string[];
}

function parsePull(v: unknown): PullRequest | null {
  if (!isRecord(v)) return null;
  const number = v['number'];
  const title = v['title'];
  const createdAt = asDate(v['created_at']);
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof title !== 'string' || !createdAt) return null;
  const user = v['user'];
  const rawLabels: unknown = v['labels'];
  const labels: string[] = [];
  if (Array.isArray(rawLabels)) {
    const items: unknown[] = rawLabels;
    for (const label of items) {
      const name = isRecord(label) ? asText(label['name']) : null;
      if (name) labels.push(name);
    }
  }
  return {
    number,
    title,
    author: (isRecord(user) ? asText(user['login']) : null) ?? 'unknown',
    draft: v['draft'] === true,
    createdAt,
    labels,
  };
}

/** `skipped` counts entries that did not look like a pull request. A non-empty list of only such entries is "not what we expect". */
export function parsePulls(data: unknown): { pulls: PullRequest[]; skipped: number } | null {
  if (!Array.isArray(data)) return null;
  const items: unknown[] = data;
  const pulls: PullRequest[] = [];
  let skipped = 0;
  for (const item of items) {
    const pr = parsePull(item);
    if (pr) pulls.push(pr);
    else skipped += 1;
  }
  if (items.length > 0 && pulls.length === 0) return null;
  return { pulls, skipped };
}

// Status labels from backlog/decisions/decision-2, in the order the queue shows them.
export const STATUS_LABELS = ['ready-to-merge', 'in-review', 'changes-requested', 'blocked', 'wip'] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];
export type GroupKey = StatusLabel | 'none';
export const GROUP_KEYS: readonly GroupKey[] = [...STATUS_LABELS, 'none'];

export const GROUP_TITLES: Record<GroupKey, string> = {
  'ready-to-merge': 'Ready to merge',
  'in-review': 'In review',
  'changes-requested': 'Changes requested',
  blocked: 'Blocked',
  wip: 'Work in progress',
  none: 'No status label',
};

/** The first status label, in queue order, that a PR carries. Label names compare case-insensitively. */
export function statusOf(labels: readonly string[]): StatusLabel | null {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  return STATUS_LABELS.find((l) => have.has(l)) ?? null;
}

export interface QueueGroup {
  key: GroupKey;
  prs: PullRequest[];
}

const oldestFirst = (a: PullRequest, b: PullRequest): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number;

/** One group per key, in queue order (ready-to-merge first). Inside a group the oldest PR comes first. Empty groups are kept. */
export function groupPulls(pulls: readonly PullRequest[]): QueueGroup[] {
  const groups = new Map<GroupKey, PullRequest[]>(GROUP_KEYS.map((key) => [key, []]));
  for (const pr of pulls) groups.get(statusOf(pr.labels) ?? 'none')?.push(pr);
  return GROUP_KEYS.map((key) => ({ key, prs: (groups.get(key) ?? []).sort(oldestFirst) }));
}

// ---- Time ------------------------------------------------------------------

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function ageText(from: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
