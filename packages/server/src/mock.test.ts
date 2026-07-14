import { describe, expect, test } from 'vitest';
import { pathOf, routeKey, buildRoutes, matchCall } from './mock.js';
import type { FlowCall } from './flows.js';

const call = (seq: number, method: string, url: string, body: unknown): FlowCall => ({
  seq, method, url, status: 200, ok: true,
  request: { headers: {}, body: null },
  response: { headers: {}, body },
});

describe('pathOf', () => {
  test('strips host and query, keeps pathname', () => {
    expect(pathOf('https://api.bank.com/v1/login?token=abc')).toBe('/v1/login');
    expect(pathOf('/v1/login?x=1')).toBe('/v1/login');
    expect(pathOf(undefined)).toBe('/');
  });
});

describe('buildRoutes + matchCall', () => {
  test('matches by method + path, ignoring query', () => {
    const routes = buildRoutes([call(1, 'GET', 'https://api/x/profile?a=1', { name: 'Jane' })]);
    const cursor = new Map<string, number>();
    expect(matchCall(routes, 'GET', '/x/profile', cursor)?.response.body).toEqual({ name: 'Jane' });
  });

  test('replays repeated calls to one path in order, then clamps on the last', () => {
    const routes = buildRoutes([
      call(1, 'GET', '/poll', { step: 1 }),
      call(2, 'GET', '/poll', { step: 2 }),
    ]);
    const cursor = new Map<string, number>();
    expect(matchCall(routes, 'GET', '/poll', cursor)?.response.body).toEqual({ step: 1 });
    expect(matchCall(routes, 'GET', '/poll', cursor)?.response.body).toEqual({ step: 2 });
    expect(matchCall(routes, 'GET', '/poll', cursor)?.response.body).toEqual({ step: 2 }); // clamp
  });

  test('returns null when nothing matches', () => {
    const routes = buildRoutes([call(1, 'GET', '/a', {})]);
    expect(matchCall(routes, 'POST', '/a', new Map())).toBeNull();
    expect(matchCall(routes, 'GET', '/b', new Map())).toBeNull();
  });

  test('routeKey uppercases method and defaults to GET', () => {
    expect(routeKey('get', '/a')).toBe('GET /a');
    expect(routeKey(undefined, '/a')).toBe('GET /a');
  });
});
