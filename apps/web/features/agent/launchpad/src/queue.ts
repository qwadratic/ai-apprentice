// PR queue: open pull requests grouped by their status label (backlog/decisions/decision-2), read from the public
// GitHub API without a token. Fetched at load and on Refresh only: anonymous requests are limited to 60 per hour
// per IP address, and a conditional request that GitHub answers with 304 does not count against that limit.
import { MERGE_QUEUE_URL, PULLS_API_URL, PULLS_PAGE_SIZE, PULLS_URL, prUrl } from './config.ts';
import { chip, el, formatClock, link, timeEl } from './dom.ts';
import { GROUP_TITLES, groupPulls, parsePulls, statusOf } from './model.ts';
import type { GroupKey, PullRequest, QueueGroup } from './model.ts';
import { describeFailure, getJson } from './net.ts';
import type { Failure } from './net.ts';

const HINTS: Record<GroupKey, string> = {
  'ready-to-merge': 'The merge queue, served oldest first.',
  'in-review': 'The coordinator is running the merge gate.',
  'changes-requested': 'Findings are posted on the PR; it is back with its author.',
  blocked: 'Waits on another PR or an external step, named in a PR comment.',
  wip: 'The author is still working.',
  none: 'No status label yet.',
};

function renderPr(pr: PullRequest, group: GroupKey, now: Date): HTMLLIElement {
  // The status label that put the PR in this group is implied; any other status label is shown, so a conflict is visible.
  const others = pr.labels.filter((label) => statusOf([label]) !== null && label.toLowerCase() !== group);
  const meta = el('div', 'pr-meta', el('span', undefined, `by ${pr.author}`), timeEl(pr.createdAt, now));
  if (pr.draft) meta.append(chip('draft', 'muted'));
  for (const label of others) meta.append(chip(label, 'muted'));
  const head = el('span', 'pr-head', el('span', 'pr-num', `#${pr.number}`), ' ', el('span', 'pr-title', pr.title));
  return el('li', 'pr', link(head, prUrl(pr.number), 'pr-link'), meta);
}

function renderGroup(group: QueueGroup, now: Date): HTMLElement {
  const hint = el('p', 'hint', HINTS[group.key]);
  if (group.key === 'ready-to-merge') hint.append(' ', link('Open it on GitHub', MERGE_QUEUE_URL));
  const section = el(
    'section',
    `group group-${group.key}`,
    el('h3', undefined, GROUP_TITLES[group.key], ' ', el('span', 'count', String(group.prs.length))),
    hint,
  );
  if (group.prs.length === 0) {
    section.append(el('p', 'empty', 'Nothing here.'));
  } else {
    section.append(el('ol', 'prs', ...group.prs.map((pr) => renderPr(pr, group.key, now))));
  }
  return section;
}

/** Rate-limit answers of the GitHub API: 429, or 403 with no requests left (or a retry-after for the secondary limit). */
function rateLimit(failure: Failure): { limited: boolean; resetsAt: Date | null } {
  if (failure.kind !== 'http') return { limited: false, resetsAt: null };
  const h = failure.headers;
  const noneLeft = h.get('x-ratelimit-remaining') === '0' || h.has('retry-after');
  const reset = Number(h.get('x-ratelimit-reset'));
  return {
    limited: failure.status === 429 || (failure.status === 403 && noneLeft),
    resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
  };
}

function renderFailure(failure: Failure): HTMLElement {
  const { limited, resetsAt } = rateLimit(failure);
  const why = limited
    ? `the GitHub API limit for requests without a token is used up${resetsAt ? ` (it resets at ${formatClock(resetsAt)})` : ''}`
    : describeFailure(failure);
  return el(
    'p',
    'notice',
    chip(limited ? 'rate limited' : 'unreachable', limited ? 'warn' : 'bad'),
    ` The PR list could not be loaded: ${why}. `,
    link('Open the pull requests on GitHub', PULLS_URL),
    ' instead.',
  );
}

export interface QueueParts {
  readonly section: HTMLElement;
  readonly summary: HTMLElement;
  readonly body: HTMLElement;
  readonly refresh: HTMLButtonElement;
}

export function initQueue(parts: QueueParts): void {
  let busy = false;

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    parts.refresh.disabled = true;
    parts.section.setAttribute('aria-busy', 'true');
    parts.summary.textContent = 'Loading...';
    parts.body.replaceChildren();
    try {
      // "no-cache" revalidates with GitHub on every Refresh (fresh data), and a 304 is free of the rate limit.
      const res = await getJson(PULLS_API_URL, { accept: 'application/vnd.github+json', cache: 'no-cache' });
      const now = new Date();
      const parsed = res.ok ? parsePulls(res.data) : null;
      if (!res.ok || !parsed) {
        const failure: Failure = res.ok ? { kind: 'shape' } : res.failure;
        parts.summary.textContent = `Checked at ${formatClock(now)}.`;
        parts.body.replaceChildren(renderFailure(failure));
        return;
      }
      const { pulls, skipped } = parsed;
      const notes = [`${pulls.length} open`];
      if (pulls.length + skipped >= PULLS_PAGE_SIZE) notes.push(`only the first ${PULLS_PAGE_SIZE} are listed`);
      if (skipped > 0) notes.push(`${skipped} could not be read`);
      parts.summary.replaceChildren(`${notes.join('; ')}. Checked at ${formatClock(now)}. `, link('All pull requests on GitHub', PULLS_URL));
      // The merge queue is always shown, even when empty; the other groups only when they hold something.
      const groups = groupPulls(pulls).filter((g) => g.prs.length > 0 || g.key === 'ready-to-merge');
      parts.body.replaceChildren(...groups.map((g) => renderGroup(g, now)));
    } catch (e) {
      // A bug in this page, not a network problem (those are shown above). Say so and keep the button usable.
      console.error(e);
      parts.summary.textContent = 'The PR queue could not be drawn. See the browser console.';
    } finally {
      busy = false;
      parts.refresh.disabled = false;
      parts.section.removeAttribute('aria-busy');
    }
  }

  parts.refresh.addEventListener('click', () => void refresh());
  void refresh();
}
