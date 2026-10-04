import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Express, RequestHandler } from 'express';
export interface WebRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: 'json' | 'raw';
  handle(request: Request, context: Record<string, string>): Response | Promise<Response>;
}
/** Adapt existing Fetch handlers without duplicating their auth, media or model logic. */
export function registerWebRoute(app: Express, route: WebRoute): void {
  const handler: RequestHandler = async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      // Raw routes retain the unread Node request stream. Authentication can therefore finish before a handler consumes bytes.
      const body = !hasBody ? undefined : route.body === 'raw'
        ? Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
        : req.body === undefined ? undefined : JSON.stringify(req.body);
      if (route.body !== 'raw') headers.delete('content-length');
      const init: RequestInit & {duplex?: 'half'} = {method: req.method, headers, body, signal: controller.signal};
      if (route.body === 'raw' && body !== undefined) init.duplex = 'half';
      const request = new Request(new URL(req.originalUrl, 'http://127.0.0.1'), init);
      const response = await route.handle(request, req.params as Record<string, string>);
      res.status(response.status);
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (!response.body) { res.end(); return; }
      await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
    } catch (error) { if (!controller.signal.aborted) next(error); }
    finally { res.off('close', abort); }
  };
  app[route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](route.path, handler);
}
