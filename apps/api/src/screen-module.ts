import type {Express} from 'express';
import type {ApiModule} from './app.ts';
import {registerWebRoute} from './web-routes.ts';
import {SessionTransportError, mount as mountScreen} from '../screen/index.ts';
import type {ScreenSessionHub} from '../screen/index.ts';
import type {ScreenRoute} from '../screen/handlers.ts';
import {createScreenRuntime} from './screen-runtime.ts';

export type ScreenAuthorize = (request: Request, sessionId: string | null) => boolean | Promise<boolean>;
export interface ScreenModuleOptions {
  readonly authorize: ScreenAuthorize;
  readonly allowedOrigins: readonly string[];
  readonly hub?: ScreenSessionHub;
  readonly databasePath?: string;
  readonly mediaDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Keeps ScreenSessionHub credentials server-side; browsers send only their agent session bearer token. */
export function createScreenModule(options: ScreenModuleOptions): ApiModule {
  if (typeof options.authorize !== 'function') throw new TypeError('Screen authorize dependency required');
  return {name: 'screen', mount(app) {
    const runtime = options.hub ? undefined : createScreenRuntime({
      databasePath: required('DATABASE_PATH', options.databasePath ?? options.env?.DATABASE_PATH),
      mediaDir: required('MEDIA_DIR', options.mediaDir ?? options.env?.MEDIA_DIR), env: options.env,
    });
    const hub = options.hub ?? runtime?.hub;
    if (!hub) throw new Error('Screen runtime unavailable');
    mountScreen(app, {hub, allowOrigin: authenticatedRouteOriginCheck(options.allowedOrigins),
      register: (target, route) => registerAuthorizedRoute(target as Express, route, options.authorize, hub)});
  }};
}

function registerAuthorizedRoute(app: Express, route: ScreenRoute, authorize: ScreenAuthorize, hub: ScreenSessionHub): void {
  const internalTokens = tokenRegistry(app);
  registerWebRoute(app, {...route, async handle(request, context) {
    const sessionId = context.sessionId;
    if (!sessionId) return unauthorized();
    if (!(await authorize(request, sessionId))) {
      return await authorize(request, null) ? forbidden() : unauthorized();
    }
    if (route.path.endsWith('/:sessionId/start')) {
      const response = await route.handle(request, context);
      if (response.status !== 201) return response;
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.sessionToken !== 'string' || body.sessionToken.length < 20) {
        return Response.json({ok: false, code: 'screen_failed'}, {status: 503});
      }
      internalTokens.set(sessionId, body.sessionToken);
      pruneInvalidTokens(internalTokens, hub);
      const {sessionToken: _internal, ...publicBody} = body;
      return Response.json(publicBody, {status: response.status, headers: response.headers});
    }
    const internalToken = internalTokens.get(sessionId);
    if (!internalToken) return unauthorized();
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${internalToken}`);
    return route.handle(new Request(request, {headers}), context);
  }});
}
const registries = new WeakMap<Express, Map<string, string>>();
function tokenRegistry(app: Express): Map<string, string> {
  let registry = registries.get(app);
  if (!registry) { registry = new Map(); registries.set(app, registry); }
  return registry;
}
function pruneInvalidTokens(registry: Map<string, string>, hub: ScreenSessionHub): void {
  for (const [sessionId, token] of registry) {
    try { hub.authenticate(sessionId, token); }
    catch (error: unknown) {
      if (error instanceof SessionTransportError && ['session_not_found', 'unauthorized'].includes(error.code)) {
        registry.delete(sessionId);
      } else throw error;
    }
  }
}
function authenticatedRouteOriginCheck(allowedOrigins: readonly string[]): (request: Request) => boolean {
  const allowed = new Set(allowedOrigins);
  return request => {
    const origin = request.headers.get('origin');
    return origin === null ? request.method === 'GET' : allowed.has(origin);
  };
}
function unauthorized(): Response {
  return Response.json({ok: false, code: 'unauthorized'}, {status: 401, headers: {'cache-control': 'no-store'}});
}
function forbidden(): Response {
  return Response.json({ok: false, code: 'forbidden'}, {status: 403, headers: {'cache-control': 'no-store'}});
}
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for the screen module`);
  return value;
}
