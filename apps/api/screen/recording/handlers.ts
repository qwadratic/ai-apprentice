import type {RecordingStore} from './store.ts';
import {RecordingStoreError} from './store.ts';
import type {RecordingSegment} from '../../../../packages/screen/evidence/index.ts';

export type RecordingHandler = (request: Request, context?: Readonly<Record<string, string>>) => Promise<Response>;
export interface RecordingRoute {readonly method: 'GET' | 'POST'; readonly path: string; readonly handle: RecordingHandler}
export interface RecordingHandlers {readonly chunk: RecordingHandler; readonly finalize: RecordingHandler; readonly asset: RecordingHandler}

type Authorize = (request: Request, sessionId: string) => boolean | Promise<boolean>;
const json = (body: unknown, status = 200): Response => Response.json(body, {status, headers: {'cache-control': 'no-store'}});

export function createRecordingHandlers({store, authorize, maxChunkBytes = 4_000_000}: {
  readonly store: RecordingStore; readonly authorize: Authorize; readonly maxChunkBytes?: number;
}): RecordingHandlers {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new TypeError('Chunk limit required.');
  const guarded = (handler: (request: Request, sessionId: string, assetId: string) => Promise<Response>): RecordingHandler =>
    async (request, context = {}) => {
      const sessionId = identifier(context.sessionId); const assetId = identifier(context.assetId);
      if (!sessionId || !assetId) return json({ok: false, code: 'invalid_request'}, 400);
      try {
        if (!await authorize(request, sessionId)) return json({ok: false, code: 'unauthorized'}, 401);
        return await handler(request, sessionId, assetId);
      } catch (error: unknown) { return failure(error); }
    };
  return {
    chunk: guarded(async (request, sessionId, assetId) => {
      const mimeType = recordingMime(request.headers.get('content-type'));
      const index = integer(request.headers.get('x-recording-chunk-index'));
      const bytes = new Uint8Array(await limitedBody(request, maxChunkBytes));
      if (!bytes.byteLength) throw new RequestError('invalid_request');
      const result = await store.append(sessionId, assetId, index, mimeType, bytes);
      return json({ok: true, outcome: result, index}, result === 'created' ? 201 : 200);
    }),
    finalize: guarded(async (request, sessionId, assetId) => {
      const body = record(await limitedJson(request, 16_000));
      if (Object.keys(body).some(key => !['chunkCount', 'mimeType', 'segment'].includes(key)) || !('chunkCount' in body) || !('mimeType' in body)) {
        throw new RequestError('invalid_request');
      }
      const chunkCount = integer(body.chunkCount); const mimeType = recordingMime(body.mimeType);
      const segment = body.segment === undefined ? undefined : recordingSegment(body.segment);
      const result = await store.finalize(sessionId, assetId, chunkCount, mimeType, segment);
      return json({ok: true, asset: result.asset}, result.created ? 201 : 200);
    }),
    asset: guarded(async (_request, sessionId, assetId) => {
      const result = await store.read(sessionId, assetId);
      return new Response(Buffer.from(result.bytes), {headers: {'content-type': result.asset.mimeType, 'content-length': String(result.asset.byteLength),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
    }),
  };
}

export function mountRecording(app: unknown, {register, ...options}: {
  readonly register: (app: unknown, route: RecordingRoute) => void; readonly store: RecordingStore;
  readonly authorize: Authorize; readonly maxChunkBytes?: number;
}): RecordingHandlers {
  const handlers = createRecordingHandlers(options);
  for (const route of [
    {method: 'POST', path: '/screen/sessions/:sessionId/recordings/:assetId/chunks', handle: handlers.chunk},
    {method: 'POST', path: '/screen/sessions/:sessionId/recordings/:assetId/finalize', handle: handlers.finalize},
    {method: 'GET', path: '/screen/sessions/:sessionId/recordings/:assetId/asset', handle: handlers.asset},
  ] satisfies RecordingRoute[]) register(app, route);
  return handlers;
}

class RequestError extends Error {
  readonly code: 'invalid_request' | 'body_limit';
  constructor(code: 'invalid_request' | 'body_limit') { super(code); this.code = code; }
}
async function limitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length'); if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RequestError('body_limit');
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new RequestError('body_limit'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function limitedJson(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RequestError('invalid_request');
  return JSON.parse(new TextDecoder().decode(await limitedBody(request, limit))) as unknown;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('invalid_request'); return value as Record<string, unknown>;
}
function identifier(value: unknown): string | null { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function integer(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0) throw new RequestError('invalid_request'); return number as number;
}
function recordingMime(value: unknown): string {
  if (typeof value !== 'string') throw new RequestError('invalid_request');
  const normalized = value.toLowerCase().trim();
  if (!/^video\/(?:webm|mp4)(?:;codecs=[a-z0-9.,-]+)?$/.test(normalized)) throw new RequestError('invalid_request'); return normalized;
}
function recordingSegment(value: unknown): RecordingSegment {
  const item = record(value);
  const keys = ['id', 'sessionId', 'assetRef', 'startMs', 'endMs', 'mediaStartMs', 'mediaEndMs', 'mimeType'];
  if (Object.keys(item).length !== keys.length || keys.some(key => !(key in item)) ||
    ['id', 'sessionId', 'assetRef', 'mimeType'].some(key => typeof item[key] !== 'string')) throw new RequestError('invalid_request');
  for (const key of ['startMs', 'endMs', 'mediaStartMs', 'mediaEndMs']) {
    if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || (item[key] as number) < 0) throw new RequestError('invalid_request');
  }
  return item as unknown as RecordingSegment;
}
function failure(error: unknown): Response {
  if (error instanceof RecordingStoreError) {
    const status = error.code === 'asset_not_found' ? 404 : error.code === 'storage_failed' ? 503 :
      error.code === 'quota_exceeded' ? 413 : error.code === 'storage_full' ? 507 : 409;
    return json({ok: false, code: error.code}, status);
  }
  if (error instanceof RequestError || error instanceof SyntaxError || error instanceof TypeError) {
    const code = error instanceof RequestError ? error.code : 'invalid_request';
    return json({ok: false, code}, code === 'body_limit' ? 413 : 400);
  }
  return json({ok: false, code: 'storage_failed'}, 503);
}
