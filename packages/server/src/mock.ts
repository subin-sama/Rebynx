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

/** Next recorded call for a request; advances the per-key cursor, clamping on the last. */
export function matchCall(
  routes: RouteMap,
  method: string,
  pathname: string,
  cursor: Map<string, number>,
): FlowCall | null {
  const key = routeKey(method, pathname);
  const list = routes[key];
  if (!list || !list.length) return null;
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
export function createMockServer(getRoutes: () => RouteMap): http.Server {
  const cursor = new Map<string, number>();
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const call = matchCall(getRoutes(), req.method ?? 'GET', url.pathname, cursor);
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
    res.writeHead(call.status ?? 200, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body ?? null));
  });
}
