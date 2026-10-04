import path from 'node:path';
import type {Express} from 'express';
import type {ApiModule} from './app.ts';
import {registerWebRoute} from './web-routes.ts';
import {createFileRecordingStore, mountRecording} from '../screen/recording/index.ts';
import type {RecordingRoute} from '../screen/recording/index.ts';

export type RecordingAuthorize = (request: Request, sessionId: string | null) => boolean | Promise<boolean>;
export interface RecordingModuleOptions {
  readonly authorize: RecordingAuthorize;
  readonly allowedOrigins: readonly string[];
  readonly mediaDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxChunkBytes?: number;
  readonly maxAssetBytes?: number;
  readonly maxSessionBytes?: number;
  readonly maxSessionAssets?: number;
  readonly minFreeBytes?: number;
}

/** Mounts durable recording assets without exposing the agent session store or buffering unauthenticated chunks. */
export function createRecordingModule(options: RecordingModuleOptions): ApiModule {
  if (typeof options.authorize !== 'function') throw new TypeError('Recording authorize dependency required');
  return {name: 'recording', mount(app) {
    const mediaDir = required('MEDIA_DIR', options.mediaDir ?? options.env?.MEDIA_DIR);
    const env = options.env ?? {};
    const store = createFileRecordingStore(path.join(mediaDir, 'recordings'), {
      maxAssetBytes: options.maxAssetBytes ?? 256_000_000,
      // One session token must not be able to fill the disk: a total per session, a cap on recordings and a free-space floor.
      maxSessionBytes: options.maxSessionBytes ?? positive(env.RECORDING_SESSION_MAX_BYTES, 1_000_000_000),
      maxSessionAssets: options.maxSessionAssets ?? positive(env.RECORDING_SESSION_MAX_ASSETS, 200),
      minFreeBytes: options.minFreeBytes ?? positive(env.RECORDING_MIN_FREE_BYTES, 1_000_000_000),
    });
    const allowed = new Set(options.allowedOrigins);
    mountRecording(app, {store, authorize: async () => true, maxChunkBytes: options.maxChunkBytes ?? 4_000_000,
      register: (target, route) => registerRecordingRoute(target as Express, route, options.authorize, allowed)});
  }};
}

function registerRecordingRoute(app: Express, route: RecordingRoute, authorize: RecordingAuthorize, allowedOrigins: ReadonlySet<string>): void {
  registerWebRoute(app, {...route, ...(route.path.endsWith('/chunks') ? {body: 'raw' as const} : {}), async handle(request, context) {
    const sessionId = context.sessionId;
    if (!sessionId) return response('unauthorized', 401);
    if (!await authorize(request, sessionId)) return await authorize(request, null) ? response('forbidden', 403) : response('unauthorized', 401);
    const origin = request.headers.get('origin');
    if (origin === null ? request.method !== 'GET' : !allowedOrigins.has(origin)) return response('forbidden', 403);
    return route.handle(request, context);
  }});
}

function response(code: 'unauthorized' | 'forbidden', status: 401 | 403): Response {
  return Response.json({ok: false, code}, {status, headers: {'cache-control': 'no-store'}});
}
function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw.trim()) && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for the recording module`);
  return value;
}
