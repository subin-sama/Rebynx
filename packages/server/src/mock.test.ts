import { describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { pathOf, routeKey, buildRoutes, matchCall, createMockServer } from './mock.js';
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

  test('prefers the call whose saved request body matches the incoming body', () => {
    const routes = buildRoutes([
      { ...call(1, 'POST', '/pay', { result: 'A' }), request: { headers: {}, body: { type: 'A' } } },
      { ...call(2, 'POST', '/pay', { result: 'B' }), request: { headers: {}, body: { type: 'B' } } },
    ]);
    const cursor = new Map<string, number>();
    expect(matchCall(routes, 'POST', '/pay', cursor, { type: 'B' })?.response.body).toEqual({ result: 'B' });
    expect(matchCall(routes, 'POST', '/pay', cursor, { type: 'A' })?.response.body).toEqual({ result: 'A' });
  });

  test('falls back to sequence when the body matches nothing', () => {
    const routes = buildRoutes([
      { ...call(1, 'POST', '/pay', { result: 'A' }), request: { headers: {}, body: { type: 'A' } } },
      { ...call(2, 'POST', '/pay', { result: 'B' }), request: { headers: {}, body: { type: 'B' } } },
    ]);
    const cursor = new Map<string, number>();
    expect(matchCall(routes, 'POST', '/pay', cursor, { type: 'Z' })?.response.body).toEqual({ result: 'A' });
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

async function boot(getRoutes: () => import('./mock.js').RouteMap, getTiming?: () => boolean) {
  const server = createMockServer(getRoutes, getTiming);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('createMockServer', () => {
  test('serves the saved response, then the next in sequence', async () => {
    const routes = buildRoutes([
      call(1, 'GET', '/poll', { step: 1 }),
      call(2, 'GET', '/poll', { step: 2 }),
    ]);
    const { server, base } = await boot(() => routes);
    try {
      expect(await (await fetch(`${base}/poll`)).json()).toEqual({ step: 1 });
      expect(await (await fetch(`${base}/poll`)).json()).toEqual({ step: 2 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('404 with a JSON hint when nothing matches', async () => {
    const { server, base } = await boot(() => ({}));
    try {
      const res = await fetch(`${base}/missing`);
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.method).toBe('GET');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('OPTIONS preflight is 204 with permissive CORS', async () => {
    const { server, base } = await boot(() => ({}));
    try {
      const res = await fetch(`${base}/x`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('delays by the saved duration when timing is enabled', async () => {
    const routes = buildRoutes([{ ...call(1, 'GET', '/slow', { ok: 1 }), duration: 80 }]);
    const { server, base } = await boot(() => routes, () => true);
    try {
      const t0 = Date.now();
      await fetch(`${base}/slow`);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('does not delay when timing is disabled', async () => {
    const routes = buildRoutes([{ ...call(1, 'GET', '/slow', { ok: 1 }), duration: 80 }]);
    const { server, base } = await boot(() => routes); // timing off (default)
    try {
      const t0 = Date.now();
      await fetch(`${base}/slow`);
      expect(Date.now() - t0).toBeLessThan(60);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('matches by request body when one path has different payloads', async () => {
    const routes = buildRoutes([
      { ...call(1, 'POST', '/pay', { result: 'A' }), request: { headers: {}, body: { type: 'A' } } },
      { ...call(2, 'POST', '/pay', { result: 'B' }), request: { headers: {}, body: { type: 'B' } } },
    ]);
    const { server, base } = await boot(() => routes);
    try {
      const rb = await (await fetch(`${base}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'B' }) })).json();
      expect(rb).toEqual({ result: 'B' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('reads the route map live via the callback (no restart)', async () => {
    let routes = buildRoutes([]);
    const { server, base } = await boot(() => routes);
    try {
      expect((await fetch(`${base}/late`)).status).toBe(404);
      routes = buildRoutes([call(1, 'GET', '/late', { ok: true })]);
      expect(await (await fetch(`${base}/late`)).json()).toEqual({ ok: true });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
