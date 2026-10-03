/** Proposed internal HTTP routes; the shared API provides routing, auth and CORS. */
const json = (body, status = 200) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store' } });

async function readJson(request, maxBodyBytes) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content type required'), { code: 'invalid_request' });
  }
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Body required'), { code: 'invalid_request' });
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw Object.assign(new Error('Body too large'), { code: 'body_limit' });
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

export function createScreenHandlers({ service, authorize, maxBodyBytes = 12_000_000 }) {
  if (!service || typeof authorize !== 'function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('Service, session authorization and body limit are required');
  }
  const guarded = handler => async (request, context = {}) => {
    try { return await handler(request, context); }
    catch (error) {
      const codes = { invalid_frame: 400, invalid_request: 400, body_limit: 413,
        evidence_not_found: 404, storage_error: 503 };
      const code = Object.hasOwn(codes, error?.code) ? error.code :
        error instanceof SyntaxError ? 'invalid_request' : 'screen_failed';
      return json({ ok: false, code }, codes[code] ?? 503);
    }
  };
  return {
    frames: guarded(async request => {
      // Authenticate before reading media, then authorize its session before ingestion.
      if (!await authorize(request, null)) return json({ ok: false, code: 'unauthorized' }, 401);
      const input = await readJson(request, maxBodyBytes);
      if (!input || typeof input.data !== 'string' || !input.data || input.data.length % 4 !== 0) {
        return json({ ok: false, code: 'invalid_request' }, 400);
      }
      if (!await authorize(request, input.sessionId)) return json({ ok: false, code: 'unauthorized' }, 403);
      const bytes = Buffer.from(input.data, 'base64');
      // Re-encoding validates canonical base64 in linear time, including large frames.
      if (bytes.toString('base64') !== input.data) return json({ ok: false, code: 'invalid_request' }, 400);
      const outcome = service.offer({ ...input, bytes });
      const ok = ['accepted', 'duplicate', 'sampled_out'].includes(outcome);
      return json({ ok, outcome }, outcome === 'accepted' ? 202 : ok ? 200 : outcome === 'invalid' ? 400 : 409);
    }),
    resolve: guarded(async (request, { id }) => {
      if (!await authorize(request, null)) return json({ ok: false, code: 'unauthorized' }, 401);
      const evidence = await service.evidence.resolve(id, { signal: request.signal });
      if (!await authorize(request, evidence.sessionId)) return json({ ok: false, code: 'unauthorized' }, 403);
      return json({ ok: true, evidence });
    }),
    asset: guarded(async (request, { id }) => {
      if (!await authorize(request, null)) return json({ ok: false, code: 'unauthorized' }, 401);
      const evidence = await service.evidence.resolve(id, { signal: request.signal });
      if (!await authorize(request, evidence.sessionId)) return json({ ok: false, code: 'unauthorized' }, 403);
      const { record, bytes } = await service.evidence.read(id, { signal: request.signal });
      return new Response(bytes, { headers: { 'content-type': record.mediaType,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }),
  };
}

/** register(app, route) is provided by the framework owner, not inferred here. */
export function mount(app, { register, ...dependencies }) {
  if (typeof register !== 'function') throw new TypeError('Framework route adapter required');
  const handlers = createScreenHandlers(dependencies);
  for (const route of [
    { method: 'POST', path: '/screen/frames', handle: handlers.frames },
    { method: 'GET', path: '/screen/evidence/:id', handle: handlers.resolve },
    { method: 'GET', path: '/screen/evidence/:id/asset', handle: handlers.asset },
  ]) register(app, route);
  return handlers;
}
