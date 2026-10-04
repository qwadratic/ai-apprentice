import express from 'express';
import type { Express, ErrorRequestHandler } from 'express';
export interface ApiModule { name: string; mount(app: Express): void | Promise<void> }
export interface ApiOptions { allowedOrigins?: string[]; modules?: ApiModule[] }
export async function createApi({allowedOrigins = [], modules = []}: ApiOptions = {}): Promise<Express> {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin && !allowedOrigins.includes(origin)) { res.status(403).json({error: 'Origin is not allowed'}); return; }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({limit: '12mb'}));
  app.get('/health', (_req, res) => res.json({ok: true, service: 'api-foundation', modules: modules.map((m) => m.name)}));
  if (new Set(modules.map((m) => m.name)).size !== modules.length) throw new Error('Duplicate API module name');
  for (const module of modules) await module.mount(app);
  app.use((_req, res) => { res.status(404).json({error: 'Route not mounted'}); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({error: status === 413 ? 'Request too large' : status === 400 ? 'Invalid JSON' : 'Request failed'});
  };
  app.use(errors);
  return app;
}
