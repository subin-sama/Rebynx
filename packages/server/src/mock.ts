/**
 * Replay saved flows as a live HTTP API. Pure matcher + a second http.Server;
 * the relay composes the route map and manages the server's lifecycle.
 */
import http from 'node:http';
import type { FlowCall } from './flows.js';

/** Grouped routes: "METHOD /path" -> the recorded calls for it, in order. */
export type RouteMap = Record<string, FlowCall[]>;

/** Pathname of a saved call's url — host and query stripped. */
export function pathOf(url: string | undefined): string {
  if (!url) return '/';
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url.split('?')[0] || '/';
  }
}

export function routeKey(method: string | undefined, pathname: string): string {
  return `${(method || 'GET').toUpperCase()} ${pathname}`;
}

/** Group a flat call list by method+path, preserving order (the replay sequence). */
export function buildRoutes(calls: FlowCall[]): RouteMap {
  const routes: RouteMap = {};
  for (const c of calls) {
    const key = routeKey(c.method, pathOf(c.url));
    (routes[key] ??= []).push(c);
  }
  return routes;
}

// Canonical key for a body so bodies compare regardless of key order; a body
// captured as a JSON-string is unwrapped first so it compares to a parsed one.
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as Record<string, unknown>).sort()
    .map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
}
function bodyKey(v: unknown): string {
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (p && typeof p === 'object') return stable(p); } catch { /* plain string */ }
  }
  return stable(v);
}

/**
 * Pick the recorded call for a request. When the incoming request has a body and
 * a call in the method+path group has a matching saved request body, that call
 * wins (same endpoint, different payloads → different responses). Otherwise the
 * per-key cursor advances through the group in order, clamping on the last.
 */
export function matchCall(
  routes: RouteMap,
  method: string,
  pathname: string,
  cursor: Map<string, number>,
  reqBody?: unknown,
): FlowCall | null {
  let key = routeKey(method, pathname);
  let list = routes[key];
  // Path-only fallback: imported mocks (and api-mapper) key by path, not method,
  // so when there's no exact method+path route, match any route with this path.
  if (!list || !list.length) {
    const suffix = ` ${pathname}`;
    for (const k of Object.keys(routes)) {
      if (k.endsWith(suffix) && routes[k].length) { key = k; list = routes[k]; break; }
    }
  }
  if (!list || !list.length) return null;
  if (reqBody !== undefined && reqBody !== null && reqBody !== '') {
    const want = bodyKey(reqBody);
    const byBody = list.find((c) => bodyKey(c.request && c.request.body) === want);
    if (byBody) return byBody;
  }
  const i = cursor.get(key) ?? 0;
  cursor.set(key, i + 1);
  return list[Math.min(i, list.length - 1)];
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-headers': '*',
};

const STRIP = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

/**
 * An http.Server that answers requests from `getRoutes()` (read live, so the
 * registry can change without a restart). One cursor per server instance drives
 * the replay sequence.
 */
export function createMockServer(getRoutes: () => RouteMap, getTiming: () => boolean = () => false): http.Server {
  const cursor = new Map<string, number>();
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    // Read the request body so a request can be matched by payload, then respond.
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 20_000_000) req.destroy(); });
    req.on('end', () => {
      let reqBody: unknown;
      if (data) { try { reqBody = JSON.parse(data); } catch { reqBody = data; } }
      const call = matchCall(getRoutes(), req.method ?? 'GET', url.pathname, cursor, reqBody);
      if (!call) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', ...CORS });
        res.end(JSON.stringify({
          error: 'no saved call matches this request',
          method: req.method,
          path: url.pathname,
          hint: 'enable a flow or call for this endpoint in the Rebynx Flows tab',
        }));
        return;
      }
      const headers: Record<string, string> = { ...CORS };
      for (const [k, v] of Object.entries(call.response.headers ?? {})) {
        if (!STRIP.has(k.toLowerCase())) headers[k] = v;
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
      const body = call.response.body;
      const send = () => {
        res.writeHead(call.status ?? 200, headers);
        res.end(typeof body === 'string' ? body : JSON.stringify(body ?? null));
      };
      // Optionally reproduce the captured latency (clamped) to simulate the real API.
      const delay = getTiming() && typeof call.duration === 'number' ? Math.min(Math.max(call.duration, 0), 10000) : 0;
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  });
}
