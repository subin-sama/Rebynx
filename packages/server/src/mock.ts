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
