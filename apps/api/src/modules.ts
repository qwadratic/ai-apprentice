import type { ApiModule } from './app.ts';
import { agentModule } from '../agent/index.ts';
import { opsModule } from '../ops/index.ts';
// Owners register explicit wrappers here. Published screen/index.mjs needs registerWebRoute, service and authorize.
// Modules remain absent until real dependencies exist; see docs/web-foundation.md.
export const modules: ApiModule[] = [agentModule, opsModule];
