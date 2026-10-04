// Deploy status: the web sha (deploy.json next to this page), the API (/health), whether both run the same commit,
// and the last deploy the VM did (/ops/deploy/status). Each request has its own time limit and its own failure
// state, so one dead endpoint never hides the others. Nothing in here throws on a network problem.
import { ACTIONS_RELEASE_URL, DEPLOY_JSON_URL, HEALTH_URL, OPS_STATUS_URL } from './config.ts';
import { chip, el, formatClock, link, shaLink, timeEl } from './dom.ts';
import type { Child, Tone } from './dom.ts';
import { parseHealth, parseOpsStatus, parseWebDeploy, syncVerdict } from './model.ts';
import type { ApiHealth, VmDeploy, WebDeploy } from './model.ts';
import { describeFailure, getJson } from './net.ts';
import type { Failure } from './net.ts';

type Loaded<T> = { ok: true; value: T } | { ok: false; failure: Failure };

async function load<T>(url: string, parse: (data: unknown) => T | null): Promise<Loaded<T>> {
  const res = await getJson(url);
  if (!res.ok) return res;
  const value = parse(res.data);
  return value === null ? { ok: false, failure: { kind: 'shape' } } : { ok: true, value };
}

// ---- Rows --------------------------------------------------------------------

interface Row {
  readonly li: HTMLLIElement;
  readonly chipSlot: HTMLElement;
  readonly detail: HTMLElement;
}

function makeRow(label: string): Row {
  const chipSlot = el('span', 'row-chip');
  const detail = el('span', 'row-detail');
  return { li: el('li', 'row', el('span', 'row-label', label), chipSlot, detail), chipSlot, detail };
}

function setRow(row: Row, state: HTMLElement, detail: readonly Child[]): void {
  row.chipSlot.replaceChildren(state);
  row.detail.replaceChildren(...detail);
}

/** Puts " · " between the pieces of a detail line. */
const dots = (...parts: Child[]): Child[] => parts.flatMap((part, i) => (i === 0 ? [part] : [' · ', part]));

const when = (label: string, date: Date, now: Date): HTMLElement => el('span', undefined, `${label} `, timeEl(date, now, true));

// ---- Renderers: one per row, each total over its input -----------------------

function renderWeb(row: Row, res: Loaded<WebDeploy>, now: Date): void {
  const raw = link('deploy.json', DEPLOY_JSON_URL, 'raw');
  if (!res.ok) {
    setRow(row, chip('unreachable', 'bad'), dots(describeFailure(res.failure), link('release runs', ACTIONS_RELEASE_URL), raw));
    return;
  }
  const { sha, at, run } = res.value;
  const parts: Child[] = [shaLink(sha)];
  if (at) parts.push(when('published', at, now));
  if (run) parts.push(link('release run', run));
  parts.push(raw);
  setRow(row, chip('ok', 'good'), dots(...parts));
}

function renderApi(row: Row, res: Loaded<ApiHealth>): void {
  const raw = link('/health', HEALTH_URL, 'raw');
  if (!res.ok) {
    setRow(row, chip('unreachable', 'bad'), dots(describeFailure(res.failure), raw));
    return;
  }
  const { ok, runner, deployedSha } = res.value;
  const runnerText = el('span', runner === 'up' ? undefined : 'attention', `runner ${runner ?? 'unknown'}`);
  const deployed = deployedSha ? el('span', undefined, 'deployed ', shaLink(deployedSha)) : 'deployed sha unknown';
  setRow(row, ok ? chip('ok', 'good') : chip('down', 'bad'), dots(runnerText, deployed, raw));
}

function renderSync(row: Row, web: Loaded<WebDeploy>, api: Loaded<ApiHealth>): void {
  const verdict = syncVerdict(web.ok ? web.value : null, api.ok ? api.value : null);
  switch (verdict.kind) {
    case 'in-sync':
      setRow(row, chip('in sync', 'good'), [el('span', undefined, 'web and API both on ', shaLink(verdict.sha))]);
      return;
    case 'out-of-sync':
      setRow(row, chip('out of sync', 'warn'), [
        el('span', undefined, 'API on ', shaLink(verdict.apiSha), ', web on ', shaLink(verdict.webSha)),
      ]);
      return;
    case 'unknown':
      setRow(row, chip('unknown', 'muted'), [verdict.reason]);
      return;
  }
}

// States written by the VM's deploy script (infra/deploy/deploy.sh).
const STATE_TONE = new Map<string, Tone>([
  ['ok', 'good'],
  ['queued', 'warn'],
  ['running', 'warn'],
  ['failed', 'bad'],
  ['rolled_back', 'bad'],
]);

function renderOps(row: Row, res: Loaded<VmDeploy>, now: Date): void {
  const raw = link('/ops/deploy/status', OPS_STATUS_URL, 'raw');
  if (!res.ok) {
    // Not an alarm: the deploy webhook may be absent, or this page's origin may not be allowed to read it.
    const why =
      res.failure.kind === 'network'
        ? 'not readable from the browser (network error, or blocked by CORS)'
        : describeFailure(res.failure);
    setRow(row, chip('unreachable', 'muted'), dots(why, el('span', undefined, 'open it directly: ', raw)));
    return;
  }
  const { last } = res.value;
  if (!last) {
    setRow(row, chip('none yet', 'muted'), dots('the VM has not recorded a deploy', raw));
    return;
  }
  const parts: Child[] = [];
  if (last.sha) parts.push(shaLink(last.sha));
  if (last.message) parts.push(last.message);
  if (last.finishedAt) parts.push(when('finished', last.finishedAt, now));
  else if (last.startedAt) parts.push(when('started', last.startedAt, now));
  parts.push(raw);
  setRow(row, chip(last.state.replaceAll('_', ' '), STATE_TONE.get(last.state) ?? 'muted'), dots(...parts));
}

// ---- Section -----------------------------------------------------------------

export interface StatusParts {
  readonly section: HTMLElement;
  readonly list: HTMLElement;
  readonly refresh: HTMLButtonElement;
  readonly updated: HTMLElement;
}

export function initStatus(parts: StatusParts): void {
  const rows = {
    web: makeRow('Web (Pages)'),
    api: makeRow('API (VM)'),
    sync: makeRow('Web and API'),
    ops: makeRow('Last VM deploy'),
  };
  parts.list.replaceChildren(rows.web.li, rows.api.li, rows.sync.li, rows.ops.li);
  let busy = false;

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    parts.refresh.disabled = true;
    parts.section.setAttribute('aria-busy', 'true');
    parts.updated.textContent = 'Checking...';
    for (const row of Object.values(rows)) setRow(row, chip('checking', 'muted'), []);
    try {
      // The three requests run in parallel, and each row is drawn as soon as its own answer is in.
      const web = load(DEPLOY_JSON_URL, parseWebDeploy);
      const api = load(HEALTH_URL, parseHealth);
      const ops = load(OPS_STATUS_URL, parseOpsStatus);
      await Promise.all([
        web.then((r) => renderWeb(rows.web, r, new Date())),
        api.then((r) => renderApi(rows.api, r)),
        ops.then((r) => renderOps(rows.ops, r, new Date())),
        Promise.all([web, api]).then(([w, a]) => renderSync(rows.sync, w, a)),
      ]);
      parts.updated.textContent = `Checked at ${formatClock(new Date())}.`;
    } catch (e) {
      // A bug in this page, not a network problem (those are states above). Say so and keep the button usable.
      console.error(e);
      parts.updated.textContent = 'The status could not be drawn. See the browser console.';
    } finally {
      busy = false;
      parts.refresh.disabled = false;
      parts.section.removeAttribute('aria-busy');
    }
  }

  parts.refresh.addEventListener('click', () => void refresh());
  void refresh();
}
