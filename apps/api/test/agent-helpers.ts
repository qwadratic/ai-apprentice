// Shared helpers for the agent module tests. No network: ElevenLabs is a stubbed fetch.
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app.ts';
import { createAgent } from '../agent/index.ts';
import type { Agent, AgentOptions } from '../agent/index.ts';

export const ORIGIN = 'https://app.example';
export const EL_AGENT = 'agent_interviewer_test';
export const EL_KEY = 'xi-test-key-never-real';

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface Harness { base: string; agent: Agent; dir: string }

export async function start(t: TestContext, options: AgentOptions = {}, dir?: string): Promise<Harness> {
  const sessionsDir = dir ?? await tempDir(t);
  const agent = createAgent({
    allowedOrigins: [ORIGIN], sessionsDir, log: () => {},
    elevenLabsApiKey: EL_KEY, elevenLabsAgentIdInterviewer: EL_AGENT,
    ...options,
  });
  t.after(() => agent.close());
  const app = await createApi({ allowedOrigins: [ORIGIN], modules: [agent.module] });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  return { base: `http://127.0.0.1:${address.port}`, agent, dir: sessionsDir };
}

export interface Issued { sessionId: string; token: string; issuedAtMs: number; serverNowMs: number }

export async function issue(base: string): Promise<Issued> {
  const r = await fetch(`${base}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN } });
  if (r.status !== 201) throw new Error(`session issue failed: ${r.status}`);
  return await r.json() as Issued;
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
export const json = (body: unknown): string => JSON.stringify(body);
export const postHeaders = (token: string): Record<string, string> => ({ Origin: ORIGIN, 'Content-Type': 'application/json', ...bearer(token) });

export const requestWith = (authorization?: string): Request =>
  new Request('http://127.0.0.1/screen/frames', { method: 'POST', headers: authorization === undefined ? {} : { Authorization: authorization } });
