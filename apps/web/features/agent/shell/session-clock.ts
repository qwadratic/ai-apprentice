// Session timing. Every timestamp in the product counts from one sessionEpochMs: the browser's Date.now() at the
// start click. The server issues the session id and the token, never the epoch.

/** The voice session ends by itself after 10 minutes (it costs minutes on a public page). */
export const SESSION_LIMIT_MS = 10 * 60 * 1000;
/** ... or after 2 minutes with the tab hidden. */
export const HIDDEN_LIMIT_MS = 2 * 60 * 1000;

/** Milliseconds since the session epoch, never negative. */
export function elapsedMs(epochMs: number, nowMs: number): number {
  return Math.max(0, nowMs - epochMs);
}

export function deadlineOf(epochMs: number, limitMs: number = SESSION_LIMIT_MS): number {
  return epochMs + limitMs;
}

export function remainingMs(epochMs: number, nowMs: number, limitMs: number = SESSION_LIMIT_MS): number {
  return Math.max(0, deadlineOf(epochMs, limitMs) - nowMs);
}

/** m:ss for a duration in milliseconds. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Estimated (server clock - browser clock) from one request, assuming the server stamped the middle of the round trip. */
export function estimateClockSkew(sentAtMs: number, receivedAtMs: number, serverNowMs: number): number {
  return Math.round(serverNowMs - (sentAtMs + receivedAtMs) / 2);
}
