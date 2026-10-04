// The macOS hand-over (doc-12 v1.1): `open_web` opens this page with `?join=<code>&page=review|teach|summary`. The page makes
// its own session, posts the single-use code to `/api/agent/conductor/:id/link`, and from then on its events and cues belong
// to the macOS session's conductor. The code is removed from the address bar at once, so it is not kept in history.
import type { FetchLike } from './client.ts';
import type { ConductorMode } from './protocol.ts';

export interface JoinParams {
  /** The single-use join code, normalised (upper case, 8 characters), or null. */
  join: string | null;
  /** The stage to open: review for Reflect, teach for Pass it on. */
  page: ConductorMode | null;
}

const PAGES: Readonly<Record<string, ConductorMode>> = { review: 'review', teach: 'teach', summary: 'teach', learn: 'learn' };

export function readJoinParams(search: string): JoinParams {
  const params = new URLSearchParams(search);
  const raw = (params.get('join') ?? '').trim().toUpperCase();
  const join = /^[A-Z0-9]{8}$/.test(raw) ? raw : null;
  const page = PAGES[(params.get('page') ?? '').trim().toLowerCase()] ?? null;
  return { join, page };
}

/** The same address without `join` and `page` (for history.replaceState). */
export function withoutJoinParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('join');
  url.searchParams.delete('page');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Links `sessionId` to the conductor named by `code`. True on success; never throws. */
export async function linkSession(options: {
  base: string;
  sessionId: string;
  authorization: string | null;
  code: string;
  fetch: FetchLike;
}): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await options.fetch(`${options.base}/api/agent/conductor/${encodeURIComponent(options.sessionId)}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(options.authorization ? { Authorization: options.authorization } : {}) },
      body: JSON.stringify({ code: options.code }),
    });
    await res.text().catch(() => '');
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
