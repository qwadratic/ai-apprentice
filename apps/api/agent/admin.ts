// Admin routes protected by API_TOKEN: list, read and delete stored sessions (same shapes as infra/placeholder-api,
// used by infra/check.sh). Mounted at /agent/sessions (unchanged paths) and at /api/agent/sessions.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { AgentRuntime } from './routes.ts';
import { SESSION_ID } from './sessions.ts';

const digest = (v: string): Buffer => createHash('sha256').update(v).digest();

export function registerAdminRoutes(app: Express, rt: AgentRuntime): void {
  const { config, files } = rt;
  const reply = (res: Response, status: number, body: unknown): void => { res.status(status).set('Cache-Control', 'no-store').json(body); };
  const authorized = (req: Request, res: Response): boolean => {
    const given = /^Bearer (.+)$/.exec(req.get('Authorization') ?? '')?.[1];
    if (given && config.apiToken.length >= 32 && timingSafeEqual(digest(given), digest(config.apiToken))) return true;
    reply(res, 401, { ok: false, error: 'unauthorized' });
    return false;
  };
  for (const prefix of ['/agent/sessions', '/api/agent/sessions']) {
    app.get(prefix, async (req, res) => {
      if (!authorized(req, res)) return;
      const { sessions, total } = await files.list();
      reply(res, 200, {
        ok: true,
        total_bytes: total,
        warn: total > config.limits.warnBytes,
        sessions: sessions.map((s) => ({ ...s, mtime: new Date(s.mtime).toISOString() })),
      });
    });
    app.get(`${prefix}/:id`, async (req, res) => {
      if (!authorized(req, res)) return;
      const id = String(req.params.id);
      if (!SESSION_ID.test(id)) { reply(res, 400, { ok: false, error: 'invalid_session_id' }); return; }
      const d = await files.dump(id);
      if (!d) { reply(res, 404, { ok: false, error: 'session_not_found' }); return; }
      reply(res, 200, { ok: true, id, conversationId: d.conversationId, events: d.events ?? [], transcript: d.transcript, audio: d.audio });
    });
    app.delete(`${prefix}/:id`, async (req, res) => {
      if (!authorized(req, res)) return;
      const id = String(req.params.id);
      if (!SESSION_ID.test(id)) { reply(res, 400, { ok: false, error: 'invalid_session_id' }); return; }
      await files.remove(id);
      reply(res, 200, { ok: true, deleted: id });
    });
  }
}
