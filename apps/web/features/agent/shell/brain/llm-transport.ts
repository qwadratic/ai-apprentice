// The brain's model-backed parts call POST {base}/api/agent/llm/:task with the session token. The token stays in api.ts: this
// module asks the session for the request (`session.llm(task)`) and hands packages/agent's LlmClient a fetch that sends it. One
// client per session, so its queue (one call at a time, which the server requires) covers the extractor, the reply classifier and
// the entity resolver together. The events it reports name the task and the outcome; never the text, the answer or the token.
import { LlmClient } from '@apprentice/agent';
import type { FetchLike as LlmFetch, LlmEvent } from '@apprentice/agent';
import type { AgentSession, FetchLike } from '../api.ts';

/** A call that takes longer than this falls back to the heuristics (the person is waiting for the next question). */
export const LLM_TIMEOUT_MS = 8000;

export function describeLlmEvent(e: LlmEvent): string {
  if (e.outcome === 'llm') return `LLM ${e.task}: model answered in ${e.elapsedMs} ms.`;
  const why = e.reason ?? 'unknown';
  return `LLM ${e.task}: fell back to heuristics (${why.replace(/_/g, ' ')}${e.status !== undefined ? `, HTTP ${e.status}` : ''}) after ${e.elapsedMs} ms.`;
}

export interface LlmTransportOptions {
  session: AgentSession;
  fetch: FetchLike;
  /** One line for the visible log. */
  log(line: string): void;
  timeoutMs?: number;
}

/** The LLM client of a session, or null when the server has no LLM route for it (the placeholder API): heuristics only. */
export function createLlmClient(options: LlmTransportOptions): LlmClient | null {
  const { session } = options;
  if (session.llm('answer_extraction') === null) return null;
  const send: LlmFetch = async (url, init) => {
    const task = /\/api\/agent\/llm\/([A-Za-z_]+)$/.exec(url)?.[1];
    const request = task === undefined ? null : session.llm(task);
    if (request === null) return { ok: false, status: 404, json: () => Promise.resolve({}) };
    // The session's own Authorization header replaces the one the client built: the client never holds the token.
    const res = await options.fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...request.headers },
      body: init.body,
      signal: init.signal,
    });
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
  };
  return new LlmClient({
    apiBase: '',
    token: '',
    fetch: send,
    timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
    onEvent: (e) => options.log(describeLlmEvent(e)),
  });
}
