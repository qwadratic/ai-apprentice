import type { ApiModule } from './app.ts';
import {agentModule, authorize} from '../agent/index.ts';
import {createScreenModule} from './screen-module.ts';

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
export const modules: ApiModule[] = [agentModule, createScreenModule({authorize, allowedOrigins, env: process.env})];
