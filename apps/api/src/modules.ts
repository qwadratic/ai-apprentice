import type { ApiModule } from './app.ts';
import {agentModule, authorize} from '../agent/index.ts';
import {opsModule} from '../ops/index.ts';
import {createScreenModule} from './screen-module.ts';
import {createRecordingModule} from './recording-module.ts';

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
// Preserve the raw signed deploy route before feature module registration.
export const modules: ApiModule[] = [opsModule, agentModule, createScreenModule({authorize, allowedOrigins, env: process.env}),
  createRecordingModule({authorize, allowedOrigins, env: process.env})];
