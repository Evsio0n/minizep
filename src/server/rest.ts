/**
 * REST API: JSON in, JSON out, on the same HTTP server, bearer auth, group
 * rules and Minizep instance as the MCP endpoint (see docs/API.md).
 *
 * Every route validates with the shapes the MCP tools use and calls the same
 * MemoryService method, so the two surfaces cannot drift apart. Errors are
 * `{ "error": "..." }` with a meaningful status code.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Principal } from './auth.js';
import { accessShapes, type AccessControl } from './access.js';
import { ServiceError, shapes, type AddMemoryOutcome, type MemoryService } from './service.js';

/** request bodies larger than this are refused with 413 */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface RestContext {
  service: MemoryService;
  /** users, tokens and group members (the /v1/me, /v1/groups/:g/members and /v1/admin routes) */
  access: AccessControl;
  /** number of MCP sessions the caller holds, for /v1/status */
  sessionsOf?: (principal: Principal) => number;
  log?: (...args: unknown[]) => void;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * The parsed JSON body (undefined when empty). Over `limit` bytes it is 413;
 * the excess is read and dropped so the client gets the answer, up to 4x the
 * limit, after which the connection is cut.
 */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  // anything but application/json is a CORS "simple" request a web page can
  // send without a preflight; refusing it keeps cross-site writes out
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && type !== 'application/json') {
    throw new ServiceError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new ServiceError(413, `request body too large (limit ${limit} bytes)`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(400, 'request body is not valid JSON');
  }
}

/** Validate against a tool shape; the first problem becomes a 400. */
export function parse<S extends z.ZodRawShape>(shape: S, value: unknown): z.infer<z.ZodObject<S>> {
  const r = z.object(shape).safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new ServiceError(400, `invalid request: ${where}${issue.message}`);
}

const INT_PARAMS = new Set(['limit']);
const BOOL_PARAMS = new Set(['include_historical', 'history', 'isolated']);

/** Query string -> object with numbers and booleans converted (zod reports the rest). */
function queryOf(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    if (INT_PARAMS.has(k) && /^-?\d+$/.test(v)) out[k] = Number(v);
    else if (BOOL_PARAMS.has(k) && /^(true|1|false|0)$/.test(v)) out[k] = v === 'true' || v === '1';
    else out[k] = v;
  }
  return out;
}

/** A JSON object body (absent = empty); arrays and scalars are refused. */
function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceError(400, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function pathParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ServiceError(400, 'malformed path');
  }
}

/** HTTP status for an add_memory outcome: a failed extraction is an upstream failure. */
function addStatus(o: AddMemoryOutcome): number {
  switch (o.status) {
    case 'processed':
      return 201;
    case 'queued':
      return 202;
    case 'duplicate':
      return 200;
    case 'failed':
      return 502;
  }
}

type Handler = (args: {
  p: Principal;
  params: string[];
  url: URL;
  body: () => Promise<unknown>;
}) => Promise<{
  status?: number;
  body: unknown;
  /** send `body`, a string, as is with this content type instead of as JSON */
  type?: string;
}>;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: Handler;
}

function routes(ctx: RestContext): Route[] {
  const s = ctx.service;
  const a = ctx.access;
  return [
    {
      method: 'POST',
      pattern: /^\/v1\/memories$/,
      handler: async ({ p, body }) => {
        const o = await s.addMemory(p, parse(shapes.addMemory, asObject(await body())));
        const error = o.status === 'failed' ? `extraction failed: ${o.error} (episode stored for retry)` : o.error;
        return { status: addStatus(o), body: { ...o, error } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/memories\/jobs\/([^/]+)$/,
      handler: async ({ p, params }) => ({ body: s.job(p, pathParam(params[0])) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/search$/,
      handler: async ({ p, body }) => ({ body: await s.search(p, parse(shapes.search, asObject(await body()))) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/entities$/,
      handler: async ({ p, url }) => ({ body: await s.entities(p, parse(shapes.entities, queryOf(url))) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/entities\/([^/]+)\/facts$/,
      handler: async ({ p, params, url }) => {
        const entity = pathParam(params[0]);
        const r = await s.factsAbout(p, parse(shapes.factsAbout, { ...queryOf(url), entity }));
        if (!r.entity) throw new ServiceError(404, `no entity matches "${entity}"`);
        return { body: r };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/entities\/([^/]+)$/,
      handler: async ({ p, params, url }) => ({
        body: await s.entity(p, parse(shapes.entity, { ...queryOf(url), id: pathParam(params[0]) })),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/graph$/,
      handler: async ({ p, url }) => ({ body: await s.graph(p, parse(shapes.graph, queryOf(url))) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/groups$/,
      handler: async ({ p }) => ({ body: await s.groups(p) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/facts$/,
      handler: async ({ p, url }) => ({ body: await s.factsAt(p, parse(shapes.factsAt, queryOf(url))) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/facts\/([^/]+)\/invalidate$/,
      handler: async ({ p, params, body }) => {
        const input = { ...asObject(await body()), uuid: pathParam(params[0]) };
        return { body: await s.invalidateFact(p, parse(shapes.invalidateFact, input)) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/facts\/([^/]+)\/reopen$/,
      handler: async ({ p, params, body }) => {
        const input = { ...asObject(await body()), uuid: pathParam(params[0]) };
        return { body: await s.reopenFact(p, parse(shapes.reopenFact, input)) };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/episodes$/,
      handler: async ({ p, url }) => ({ body: await s.episodes(p, parse(shapes.episodes, queryOf(url))) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/episodes\/retry-failed$/,
      handler: async ({ p, body }) => ({ body: await s.retryFailed(p, parse(shapes.group, asObject(await body()))) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/episodes\/([^/]+)\/forget$/,
      handler: async ({ p, params, body }) => {
        const input = { ...asObject(await body()), id: pathParam(params[0]) };
        return { body: await s.forgetEpisode(p, parse(shapes.forgetEpisode, input)) };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/episodes\/([^/]+)$/,
      handler: async ({ p, params, url }) => ({
        body: await s.episode(p, parse(shapes.episode, { ...queryOf(url), id: pathParam(params[0]) })),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/stats$/,
      handler: async ({ p, url }) => ({ body: await s.stats(p, parse(shapes.group, queryOf(url))) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/guide$/,
      handler: async () => ({ body: await s.guide(), type: 'text/markdown; charset=utf-8' }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/status$/,
      handler: async ({ p }) => ({ body: { ...(await s.status(p)), sessions: ctx.sessionsOf?.(p) ?? 0 } }),
    },

    /* ---------- access (see docs/ACCESS.md) ---------- */
    {
      method: 'GET',
      pattern: /^\/v1\/me$/,
      handler: async ({ p }) => ({ body: await a.me(p) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/me\/tokens$/,
      handler: async ({ p }) => ({ body: await a.myTokens(p) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/me\/tokens$/,
      handler: async ({ p, body }) => ({
        status: 201,
        body: await a.createMyToken(p, parse(accessShapes.myToken, asObject(await body()))),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/me\/tokens\/([^/]+)\/revoke$/,
      handler: async ({ p, params }) => ({ body: await a.revokeMyToken(p, pathParam(params[0])) }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/groups\/([^/]+)\/members$/,
      handler: async ({ p, params }) => ({ body: await a.members(p, pathParam(params[0])) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/groups\/([^/]+)\/members$/,
      handler: async ({ p, params, body }) => ({
        body: await a.setMember(p, pathParam(params[0]), parse(accessShapes.member, asObject(await body()))),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/groups\/([^/]+)\/members\/remove$/,
      handler: async ({ p, params, body }) => ({
        body: await a.removeMember(p, pathParam(params[0]), parse(accessShapes.removeMember, asObject(await body()))),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/admin\/users$/,
      handler: async ({ p }) => ({ body: await a.listUsers(p) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/users$/,
      handler: async ({ p, body }) => ({
        status: 201,
        body: await a.createUser(p, parse(accessShapes.createUser, asObject(await body()))),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/users\/([^/]+)$/,
      handler: async ({ p, params, body }) => ({
        body: await a.updateUser(p, pathParam(params[0]), parse(accessShapes.updateUser, asObject(await body()))),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/users\/([^/]+)\/tokens$/,
      handler: async ({ p, params, body }) => ({
        status: 201,
        body: await a.createToken(p, pathParam(params[0]), parse(accessShapes.token, asObject(await body()))),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/tokens\/([^/]+)\/revoke$/,
      handler: async ({ p, params }) => ({ body: await a.revokeToken(p, pathParam(params[0])) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/grants$/,
      handler: async ({ p, body }) => ({ body: await a.setGrant(p, parse(accessShapes.grant, asObject(await body()))) }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/admin\/grants\/revoke$/,
      handler: async ({ p, body }) => ({
        body: await a.removeGrant(p, parse(accessShapes.revokeGrant, asObject(await body()))),
      }),
    },
  ];
}

/** Builds the handler for /v1/* requests of an authenticated caller. */
export function createRestHandler(ctx: RestContext) {
  const table = routes(ctx);
  return async (req: IncomingMessage, res: ServerResponse, url: URL, p: Principal): Promise<void> => {
    try {
      const matching = table
        .map((route) => ({ route, m: route.pattern.exec(url.pathname) }))
        .filter((r) => r.m);
      if (matching.length === 0) return sendJson(res, 404, { error: 'not found' });
      const hit = matching.find((r) => r.route.method === req.method);
      if (!hit) {
        const allow = [...new Set(matching.map((r) => r.route.method))].join(', ');
        return sendJson(res, 405, { error: `method not allowed (use ${allow})` }, { allow });
      }
      const { status = 200, body, type } = await hit.route.handler({
        p,
        params: hit.m!.slice(1),
        url,
        body: () => readJsonBody(req),
      });
      if (type === undefined) return sendJson(res, status, body);
      res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      res.end(String(body));
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 600) {
        const headers: Record<string, string> = status === 413 ? { connection: 'close' } : {};
        return sendJson(res, status, { error: (err as Error).message }, headers);
      }
      ctx.log?.(`${req.method} ${url.pathname} failed:`, (err as Error)?.stack ?? err);
      sendJson(res, 500, { error: 'internal error' });
    }
  };
}
