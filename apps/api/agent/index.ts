// Stream B's API module: sessions with bearer tokens, authorize() for the screen module, /api/agent/* routes.
import type { ApiModule } from '../src/app.ts';
import { createSessionStore } from './auth.ts';
import type { SessionStore } from './auth.ts';
import { resolveConfig } from './config.ts';
import type { AgentOptions } from './config.ts';
import { registerAdminRoutes } from './admin.ts';
import { createElevenLabsClient } from './elevenlabs.ts';
import { registerLlmRoutes } from './llm.ts';
import { registerAgentRoutes } from './routes.ts';
import type { AgentRuntime } from './routes.ts';
import { createMaintenance } from './rotation.ts';
import { createSessionFiles } from './sessions.ts';
import { createConductorHub, registerConductorRoutes } from './conductor/routes.ts';
import { registerVoiceoverRoutes } from './voiceover.ts';

export type { AgentOptions, FetchFn } from './config.ts';
export type { SessionStore, IssuedSession } from './auth.ts';

export interface Agent {
  module: ApiModule;
  authorize(request: Request, sessionId: string | null): Promise<boolean>;
  /** Resolves when background work started by /finish has completed (for tests and graceful shutdown). */
  idle(): Promise<void>;
  /** One disk maintenance pass now (orphan tmp cleanup, warn, rotation). It also runs on mount and every 10 min. */
  maintain(): Promise<void>;
  /** Stops the maintenance timer and the conductor's clock. */
  close(): void;
  /** Feeds a screen observation of a session to its Clipa conductor (doc-12); a no-op when the session has none. */
  observeScreen(sessionId: string, observation: unknown): void;
  store: SessionStore;
}

/** Builds an independent module, store and authorize() from explicit options (tests) or the environment. */
export function createAgent(options: AgentOptions = {}): Agent {
  const config = resolveConfig(options);
  const store = createSessionStore({ ...config, maxLive: config.limits.maxLiveSessions });
  const files = createSessionFiles(config.sessionsDir);
  const maintenance = createMaintenance(config, files);
  const runtime: AgentRuntime = { config, store, files, eleven: createElevenLabsClient(config, files), maintenance, background: new Set() };
  const conductors = createConductorHub(runtime);
  return {
    module: { name: 'agent', mount: (app) => { registerAgentRoutes(app, runtime); registerLlmRoutes(app, runtime); registerConductorRoutes(app, runtime, conductors); registerAdminRoutes(app, runtime); registerVoiceoverRoutes(app, config); maintenance.start(); } },
    maintain: () => maintenance.run(),
    close: () => { maintenance.stop(); conductors.close(); },
    observeScreen: (sessionId, observation) => conductors.observe(sessionId, observation),
    authorize: async (request, sessionId) => store.check(request.headers.get('authorization'), sessionId).ok,
    idle: async () => { while (runtime.background.size > 0) await Promise.allSettled([...runtime.background]); },
    store,
  };
}

// The default instance reads its environment on first use, so importing this file has no side effects.
let shared: Agent | undefined;
const defaultAgent = (): Agent => (shared ??= createAgent());

/** `import { mount as mountAgent } from '../agent/index.ts'` (doc-9 4.1, docs/web-foundation.md). */
export const mount: ApiModule['mount'] = (app) => defaultAgent().module.mount(app);
export const agentModule: ApiModule = { name: 'agent', mount };

/** Screen-module dependency (doc-12): every observation the vision path publishes reaches the session's conductor. */
export function observeScreen(sessionId: string, observation: unknown): void {
  defaultAgent().observeScreen(sessionId, observation);
}

/**
 * Screen-module dependency (doc-9 4.2). Reads `Authorization: Bearer <token>`.
 * With a sessionId the token must belong to that live session; with null it may belong to any live session.
 */
export async function authorize(request: Request, sessionId: string | null): Promise<boolean> {
  return defaultAgent().authorize(request, sessionId);
}
