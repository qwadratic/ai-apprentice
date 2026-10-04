// Stream B's API module: sessions with bearer tokens, authorize() for the screen module, /api/agent/* routes.
import type { ApiModule } from '../src/app.ts';
import { createSessionStore } from './auth.ts';
import type { SessionStore } from './auth.ts';
import { resolveConfig } from './config.ts';
import type { AgentOptions } from './config.ts';
import { createElevenLabsClient } from './elevenlabs.ts';
import { registerAgentRoutes } from './routes.ts';
import type { AgentRuntime } from './routes.ts';
import { createSessionFiles } from './sessions.ts';

export type { AgentOptions, FetchFn } from './config.ts';
export type { SessionStore, IssuedSession } from './auth.ts';

export interface Agent {
  module: ApiModule;
  authorize(request: Request, sessionId: string | null): Promise<boolean>;
  /** Resolves when background work started by /finish has completed (for tests and graceful shutdown). */
  idle(): Promise<void>;
  store: SessionStore;
}

/** Builds an independent module, store and authorize() from explicit options (tests) or the environment. */
export function createAgent(options: AgentOptions = {}): Agent {
  const config = resolveConfig(options);
  const store = createSessionStore({ ...config, maxLive: config.limits.maxLiveSessions });
  const files = createSessionFiles(config.sessionsDir);
  const runtime: AgentRuntime = { config, store, files, eleven: createElevenLabsClient(config, files), background: new Set() };
  return {
    module: { name: 'agent', mount: (app) => { registerAgentRoutes(app, runtime); } },
    authorize: async (request, sessionId) => store.check(request.headers.get('authorization'), sessionId).ok,
    idle: async () => { while (runtime.background.size > 0) await Promise.allSettled([...runtime.background]); },
    store,
  };
}

// The default instance reads its environment on first use, so importing this file has no side effects.
let shared: Agent | undefined;
const defaultAgent = (): Agent => (shared ??= createAgent());

export const agentModule: ApiModule = { name: 'agent', mount: (app) => defaultAgent().module.mount(app) };

/**
 * Screen-module dependency (doc-9 4.2). Reads `Authorization: Bearer <token>`.
 * With a sessionId the token must belong to that live session; with null it may belong to any live session.
 */
export async function authorize(request: Request, sessionId: string | null): Promise<boolean> {
  return defaultAgent().authorize(request, sessionId);
}
