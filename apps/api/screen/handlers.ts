import type {ScreenStatus} from '@apprentice/contracts';
import type {ProcessedFrame, ScreenMediaType} from './evidence-store.ts';
import {EvidenceError, normalizeFrame} from './evidence-store.ts';
import type {FrameUpload, ScreenSessionHandle} from './session-transport.ts';
import {ScreenSessionHub, SessionTransportError} from './session-transport.ts';
import type {VisionSurface} from '../../../packages/screen/vision/queue.ts';

const json = (body: unknown, status = 200): Response => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
export interface ScreenRoute { readonly method: 'GET' | 'POST'; readonly path: string; readonly handle: ScreenHandler }
export type ScreenHandler = (request: Request, context?: Readonly<Record<string, string>>) => Promise<Response>;
export interface ScreenHandlers {
  readonly start: ScreenHandler; readonly frames: ScreenHandler; readonly updates: ScreenHandler;
  readonly lifecycle: ScreenHandler; readonly resolve: ScreenHandler; readonly asset: ScreenHandler;
}
export function createAllowedOriginCheck(configured: string): (request: Request) => boolean {
  const allowed = new Set(configured.split(',').map(value => value.trim()).filter(Boolean));
  return request => { const origin = request.headers.get('origin'); return origin !== null && allowed.has(origin); };
}
export function createScreenHandlers({hub, allowOrigin, maxBodyBytes = 12_000_000}: {
  readonly hub: ScreenSessionHub; readonly allowOrigin: (request: Request) => boolean; readonly maxBodyBytes?: number;
}): ScreenHandlers {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('Body limit required');
  const guarded = (handler: ScreenHandler): ScreenHandler => async (request, context = {}) => {
    if (!allowOrigin(request)) return json({ok: false, code: 'origin_not_allowed'}, 403);
    try { return await handler(request, context); }
    catch (error: unknown) { return errorResponse(error); }
  };
  const authenticated = (handler: (request: Request, context: Readonly<Record<string, string>>,
    session: ScreenSessionHandle) => Promise<Response>): ScreenHandler => guarded(async (request, context = {}) => {
      const sessionId = context.sessionId; const token = bearer(request);
      if (!sessionId || !token) return json({ok: false, code: 'unauthorized'}, 401);
      let session: ScreenSessionHandle;
      try { session = hub.authenticate(sessionId, token); }
      catch (error: unknown) {
        if (error instanceof SessionTransportError && ['session_not_found', 'unauthorized'].includes(error.code)) {
          return json({ok: false, code: 'unauthorized'}, 401);
        }
        throw error;
      }
      return handler(request, context, session);
    });
  return {
    start: guarded(async (request, context = {}) => {
      if (!context.sessionId) return json({ok: false, code: 'invalid_request'}, 400);
      const body = record(await readJson(request, maxBodyBytes));
      exactKeys(body, ['sessionEpochMs', 'clientGeneration']);
      const result = hub.start(context.sessionId, safeInteger(body.sessionEpochMs), safeInteger(body.clientGeneration));
      return json(result, 201);
    }),
    frames: authenticated(async (request, _context, session) => {
      const body = record(await readJson(request, maxBodyBytes));
      exactKeys(body, ['generation', 'frameId', 'timestampMs', 'processed', 'mediaType', 'data', 'provenance']);
      const data = encodedFrame(body.data); if (data.length % 4 !== 0) throw new RequestError('invalid_request');
      const bytes = Buffer.from(data, 'base64'); if (bytes.toString('base64') !== data) throw new RequestError('invalid_request');
      const provenance = parseProvenance(body.provenance);
      const frame = normalizeFrame({sessionId: session.sessionId, frameId: string(body.frameId),
        timestampMs: safeInteger(body.timestampMs), processed: body.processed,
        mediaType: mediaType(body.mediaType), bytes});
      const generation = safeInteger(body.generation);
      const outcome = hub.offer(session, {generation, frame, provenance});
      const ok = ['accepted', 'duplicate', 'sampled_out'].includes(outcome);
      return json({ok, outcome, sessionId: session.sessionId, generation, frameId: frame.frameId},
        outcome === 'accepted' ? 202 : ok ? 200 : outcome === 'invalid' ? 400 : 409);
    }),
    updates: authenticated(async (request, _context, session) => {
      const url = new URL(request.url); const cursor = queryInteger(url, 'cursor'); const generation = queryInteger(url, 'generation');
      return json(hub.updates(session, generation, cursor));
    }),
    lifecycle: authenticated(async (request, _context, session) => {
      const body = record(await readJson(request, Math.min(maxBodyBytes, 64_000)));
      exactKeys(body, ['generation', 'command'], ['generation', 'command', 'reason']);
      if (!['pause', 'resume', 'stop'].includes(String(body.command))) throw new RequestError('invalid_request');
      const reason = body.reason === undefined ? undefined : string(body.reason);
      return json(hub.lifecycle(session, safeInteger(body.generation), body.command as 'pause' | 'resume' | 'stop', reason));
    }),
    resolve: authenticated(async (request, context, session) => {
      if (!context.id) throw new RequestError('invalid_request');
      const evidence = await hub.evidence(session).resolve(context.id, {signal: request.signal});
      if (evidence.sessionId !== session.sessionId) return json({ok: false, code: 'forbidden'}, 403);
      return json({ok: true, evidence});
    }),
    asset: authenticated(async (request, context, session) => {
      if (!context.id) throw new RequestError('invalid_request');
      const {record: evidence, bytes} = await hub.evidence(session).read(context.id, {signal: request.signal});
      if (evidence.sessionId !== session.sessionId) return json({ok: false, code: 'forbidden'}, 403);
      return new Response(Uint8Array.from(bytes), {headers: {'content-type': evidence.mediaType,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
    }),
  };
}
export function mount(app: unknown, {register, ...dependencies}: {
  readonly register: (app: unknown, route: ScreenRoute) => void; readonly hub: ScreenSessionHub;
  readonly allowOrigin: (request: Request) => boolean; readonly maxBodyBytes?: number;
}): ScreenHandlers {
  if (typeof register !== 'function') throw new TypeError('Framework route adapter required');
  const handlers = createScreenHandlers(dependencies);
  for (const route of [
    {method: 'POST', path: '/screen/sessions/:sessionId/start', handle: handlers.start},
    {method: 'POST', path: '/screen/sessions/:sessionId/frames', handle: handlers.frames},
    {method: 'GET', path: '/screen/sessions/:sessionId/updates', handle: handlers.updates},
    {method: 'POST', path: '/screen/sessions/:sessionId/lifecycle', handle: handlers.lifecycle},
    {method: 'GET', path: '/screen/sessions/:sessionId/evidence/:id', handle: handlers.resolve},
    {method: 'GET', path: '/screen/sessions/:sessionId/evidence/:id/asset', handle: handlers.asset},
  ] satisfies ScreenRoute[]) register(app, route);
  return handlers;
}
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RequestError('invalid_request');
  const reader = request.body?.getReader(); if (!reader) throw new RequestError('invalid_request');
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) { const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new RequestError('body_limit'); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
}
function parseProvenance(value: unknown): FrameUpload['provenance'] {
  const source = record(value); exactKeys(source, ['surface', 'sourceRevision', 'captureGeneration']);
  const surface = source.surface === null ? null : visionSurface(source.surface);
  const sourceRevision = source.sourceRevision === null ? null : string(source.sourceRevision);
  const captureGeneration = source.captureGeneration === null ? null : safeInteger(source.captureGeneration);
  return {surface, sourceRevision, captureGeneration};
}
function errorResponse(error: unknown): Response {
  if (error instanceof SessionTransportError) {
    const status = error.code === 'session_limit' ? 429 : error.code === 'session_not_found' ? 404 :
      ['generation_mismatch', 'cursor_expired', 'inactive'].includes(error.code) ? 409 : error.code === 'unauthorized' ? 401 : 400;
    return json({ok: false, code: error.code, ...error.details}, status);
  }
  if (error instanceof EvidenceError) return json({ok: false, code: error.code}, error.code === 'evidence_not_found' ? 404 : error.code === 'invalid_frame' ? 400 : 503);
  if (error instanceof RequestError || error instanceof SyntaxError || error instanceof TypeError) {
    const code = error instanceof RequestError ? error.code : 'invalid_request'; return json({ok: false, code}, code === 'body_limit' ? 413 : 400);
  }
  return json({ok: false, code: 'screen_failed'}, 503);
}
class RequestError extends Error {
  readonly code: 'invalid_request' | 'body_limit';
  constructor(code: 'invalid_request' | 'body_limit') { super(code); this.code = code; }
}
function bearer(request: Request): string | null {
  const value = request.headers.get('authorization'); const match = value?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/); return match?.[1] ?? null;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('invalid_request'); return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[] = required): void {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.includes(key))) throw new RequestError('invalid_request');
}
function string(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 500) throw new RequestError('invalid_request'); return value; }
function encodedFrame(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 10_666_668) throw new RequestError('invalid_request');
  return value;
}
function safeInteger(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RequestError('invalid_request'); return value; }
function queryInteger(url: URL, name: string): number {
  const value = url.searchParams.get(name); if (value === null || !/^\d+$/.test(value)) throw new RequestError('invalid_request'); return safeInteger(Number(value));
}
function mediaType(value: unknown): ScreenMediaType {
  if (value !== 'image/png' && value !== 'image/jpeg' && value !== 'image/webp') throw new RequestError('invalid_request'); return value;
}
function visionSurface(value: unknown): VisionSurface {
  if (value !== 'order' && value !== 'email' && value !== 'ticket') throw new RequestError('invalid_request'); return value;
}
