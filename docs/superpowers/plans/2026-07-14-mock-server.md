# Mock API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay saved flows (whole or per-call) as a live HTTP API on a second port so an app can point its base URL at it and get recorded responses back.

**Architecture:** A pure matcher + a second `http.Server` (`mock.ts`) live inside `createRelayServer()`. The relay keeps an in-memory registry (`enabledFlows` + `enabledCalls`), rebuilds a grouped route map on change, and starts/stops the mock server. The browser client's Flows tab toggles sources and shows the mock URL.

**Tech Stack:** Node `http`, TypeScript (server), vanilla JS (client), vitest (+ happy-dom for client).

## Global Constraints

- Mock port: `opts.mockPort ?? Number(process.env.DEVTOOLS_MOCK_PORT) || 9091`.
- Match by **method + path only** (query and host stripped); repeated path replays its recorded responses in order, **clamping at the last**.
- Conflict across sources = **sequence merge** (concatenate), deduped by `flowId#seq`.
- Every mock response adds permissive CORS (`access-control-allow-origin: *`); `OPTIONS` → `204`.
- Strip `content-length` / `content-encoding` / `transfer-encoding` from saved response headers (recomputed); default `content-type: application/json`.
- No match → `404` JSON `{ error, method, path, hint }`.
- Server package may use `node` APIs (this is not `core`).
- Commit after each task. Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- Create `packages/server/src/mock.ts` — pure matcher (`pathOf`, `routeKey`, `buildRoutes`, `matchCall`) + `createMockServer`.
- Create `packages/server/src/mock.test.ts` — unit + integration tests for `mock.ts`.
- Modify `packages/server/src/server.ts` — `RelayOptions.mockPort`, mock registry + `handleMock` routes + lifecycle.
- Modify `packages/server/src/server.test.ts` — control-endpoint tests.
- Modify `packages/server/public/app.js` — mock state, toggle/stop methods, Flows-tab toggles + banner.
- Modify `packages/server/public/index.html` — CSS for mock toggles + banner.
- Modify `packages/server/src/app.test.js` — client rendering + toggle tests.
- Modify `CLAUDE.md` — one line documenting the mock server.

---

## Task 1: Mock matcher — pure core

**Files:**
- Create: `packages/server/src/mock.ts`
- Test: `packages/server/src/mock.test.ts`

**Interfaces:**
- Consumes: `FlowCall` from `./flows.js`.
- Produces:
  - `type RouteMap = Record<string, FlowCall[]>`
  - `pathOf(url: string | undefined): string`
  - `routeKey(method: string | undefined, pathname: string): string`
  - `buildRoutes(calls: FlowCall[]): RouteMap`
  - `matchCall(routes: RouteMap, method: string, pathname: string, cursor: Map<string, number>): FlowCall | null`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/mock.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/mock.test.ts`
Expected: FAIL — cannot resolve `./mock.js` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/mock.ts` (matcher portion only):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/mock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mock.ts packages/server/src/mock.test.ts
git commit -m "feat(server): mock route matcher — method+path, sequence replay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Mock HTTP server

**Files:**
- Modify: `packages/server/src/mock.ts` (add `createMockServer`)
- Test: `packages/server/src/mock.test.ts` (add a describe)

**Interfaces:**
- Consumes: `buildRoutes`, `matchCall`, `RouteMap` from Task 1.
- Produces: `createMockServer(getRoutes: () => RouteMap): http.Server`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/mock.test.ts`:

```typescript
import type { AddressInfo } from 'node:net';
import { createMockServer } from './mock.js';

async function boot(getRoutes: () => import('./mock.js').RouteMap) {
  const server = createMockServer(getRoutes);
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
      expect((await res.json()).method).toBe('GET');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/mock.test.ts`
Expected: FAIL — `createMockServer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/server/src/mock.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/mock.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mock.ts packages/server/src/mock.test.ts
git commit -m "feat(server): mock http server — replay, CORS, 404, live routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Relay registry + control endpoints

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `buildRoutes`, `createMockServer`, `RouteMap` from `./mock.js`; `getFlow`, `FlowCall` from `./flows.js`.
- Produces: HTTP contract — `GET/POST/DELETE /mock`, `POST/DELETE /mock/flow/:id`, `POST/DELETE /mock/call/:flowId/:seq`; `RelayOptions.mockPort?: number`. Status shape `{ active, port, url, flows, calls, endpoints:[{method,path,count}] }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/server.test.ts`:

```typescript
describe('/mock (serve saved flows as an API)', () => {
  async function saveSample() {
    await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'login',
        calls: [
          { seq: 1, method: 'GET', url: 'https://api/x/profile', status: 200, request: {}, response: { headers: {}, body: { name: 'Jane' } } },
          { seq: 2, method: 'POST', url: 'https://api/x/logout', status: 204, request: {}, response: { headers: {}, body: null } },
        ],
      }),
    });
  }

  test('enabling a whole flow serves its endpoints', async () => {
    await saveSample();
    const status = await (await fetch(`${base}/mock/flow/login`, { method: 'POST' })).json();
    expect(status.active).toBe(true);
    expect(status.flows).toContain('login');
    expect(status.endpoints.map((e: any) => e.path).sort()).toEqual(['/x/logout', '/x/profile']);
    const hit = await fetch(`http://127.0.0.1:${status.port}/x/profile`);
    expect(await hit.json()).toEqual({ name: 'Jane' });
  });

  test('enabling a single call serves only that endpoint', async () => {
    await saveSample();
    const status = await (await fetch(`${base}/mock/call/login/1`, { method: 'POST' })).json();
    expect(status.calls).toContain('login#1');
    expect(status.endpoints.map((e: any) => e.path)).toEqual(['/x/profile']);
  });

  test('GET /mock reports current state; DELETE /mock clears + stops', async () => {
    await saveSample();
    await fetch(`${base}/mock/flow/login`, { method: 'POST' });
    expect((await (await fetch(`${base}/mock`)).json()).active).toBe(true);
    const cleared = await (await fetch(`${base}/mock`, { method: 'DELETE' })).json();
    expect(cleared.active).toBe(false);
    expect(cleared.flows).toEqual([]);
  });

  test('enabling a missing flow is 404', async () => {
    expect((await fetch(`${base}/mock/flow/nope`, { method: 'POST' })).status).toBe(404);
  });
});
```

Change the `beforeEach` so the mock server uses an ephemeral port (find the line `server = createRelayServer({ flowsDir });` and replace it):

```typescript
  server = createRelayServer({ flowsDir, mockPort: 0 });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server.test.ts`
Expected: FAIL — `/mock/flow/login` 404s as an unknown static path (routes not implemented).

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/server.ts`:

Add imports near the top (after the flows import):
```typescript
import type { AddressInfo } from 'node:net';
import { buildRoutes, createMockServer, type RouteMap } from './mock.js';
import type { FlowCall } from './flows.js';
```

Add `mockPort` to `RelayOptions`:
```typescript
export interface RelayOptions {
  /** Where captured flows are stored. Defaults to DEFAULT_FLOWS_DIR. */
  flowsDir?: string;
  /** Where the browser client is served from. Defaults to DEFAULT_PUBLIC_DIR. */
  publicDir?: string;
  /** Port for the mock API server. Defaults to DEVTOOLS_MOCK_PORT or 9091. */
  mockPort?: number;
}
```

Inside `createRelayServer`, after `fs.mkdirSync(flowsDir, ...)`, add the registry + lifecycle:
```typescript
  const mockPort = opts.mockPort ?? (process.env.DEVTOOLS_MOCK_PORT ? Number(process.env.DEVTOOLS_MOCK_PORT) : 9091);
  const enabledFlows = new Set<string>();
  const enabledCalls = new Set<string>(); // "flowId#seq"
  let mockServer: http.Server | null = null;
  let mockRoutes: RouteMap = {};
  let activePort = mockPort;

  async function rebuildRoutes(): Promise<void> {
    const calls: FlowCall[] = [];
    const seen = new Set<string>();
    const add = (flowId: string, c: FlowCall) => {
      const k = `${flowId}#${c.seq}`;
      if (seen.has(k)) return;
      seen.add(k);
      calls.push(c);
    };
    for (const fid of enabledFlows) {
      const flow = await getFlow(flowsDir, fid);
      if (flow) for (const c of flow.calls) add(fid, c);
    }
    for (const ck of enabledCalls) {
      const [fid, seqStr] = ck.split('#');
      const flow = await getFlow(flowsDir, fid);
      const c = flow?.calls.find((x) => String(x.seq) === seqStr);
      if (c) add(fid, c);
    }
    mockRoutes = buildRoutes(calls);
  }

  async function syncMock(): Promise<void> {
    await rebuildRoutes();
    const shouldRun = enabledFlows.size + enabledCalls.size > 0;
    if (shouldRun && !mockServer) {
      mockServer = createMockServer(() => mockRoutes);
      await new Promise<void>((resolve) => mockServer!.listen(mockPort, '0.0.0.0', () => resolve()));
      activePort = (mockServer.address() as AddressInfo).port;
    } else if (!shouldRun && mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
  }

  function mockStatus() {
    const endpoints = Object.entries(mockRoutes).map(([k, list]) => {
      const sp = k.indexOf(' ');
      return { method: k.slice(0, sp), path: k.slice(sp + 1), count: list.length };
    });
    return {
      active: !!mockServer,
      port: mockServer ? activePort : mockPort,
      url: `http://${lanIp()}:${mockServer ? activePort : mockPort}`,
      flows: [...enabledFlows],
      calls: [...enabledCalls],
      endpoints,
    };
  }

  async function handleMock(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/mock') {
      if (req.method === 'GET') { sendJson(res, 200, mockStatus()); return true; }
      if (req.method === 'DELETE') {
        enabledFlows.clear();
        enabledCalls.clear();
        await syncMock();
        sendJson(res, 200, mockStatus());
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const flow = url.pathname.match(/^\/mock\/flow\/([^/]+)$/);
    if (flow) {
      const id = decodeURIComponent(flow[1]);
      if (req.method === 'POST') {
        if (!(await getFlow(flowsDir, id))) { sendJson(res, 404, { error: 'flow not found' }); return true; }
        enabledFlows.add(id);
        await syncMock();
        sendJson(res, 200, mockStatus());
        return true;
      }
      if (req.method === 'DELETE') {
        enabledFlows.delete(id);
        await syncMock();
        sendJson(res, 200, mockStatus());
        return true;
      }
    }
    const one = url.pathname.match(/^\/mock\/call\/([^/]+)\/([^/]+)$/);
    if (one) {
      const fid = decodeURIComponent(one[1]);
      const seq = decodeURIComponent(one[2]);
      const key = `${fid}#${seq}`;
      if (req.method === 'POST') {
        const f = await getFlow(flowsDir, fid);
        if (!f || !f.calls.some((c) => String(c.seq) === seq)) { sendJson(res, 404, { error: 'call not found' }); return true; }
        enabledCalls.add(key);
        await syncMock();
        sendJson(res, 200, mockStatus());
        return true;
      }
      if (req.method === 'DELETE') {
        enabledCalls.delete(key);
        await syncMock();
        sendJson(res, 200, mockStatus());
        return true;
      }
    }
    return false;
  }
```

Wire `handleMock` into the request handler — find `if (await handleFlows(req, res, url, flowsDir)) return;` and add ABOVE it:
```typescript
      if (await handleMock(req, res, url)) return;
```

Stop the mock server when the relay closes — find `return server;` at the end of `createRelayServer` and add ABOVE it:
```typescript
  server.on('close', () => { if (mockServer) mockServer.close(); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace @rebynx/server`
Expected: no errors.

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "feat(server): mock registry + control endpoints (/mock)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Client — mock state, toggles, banner (logic + tests)

**Files:**
- Modify: `packages/server/public/app.js`
- Test: `packages/server/src/app.test.js`

**Interfaces:**
- Consumes: `GET/POST/DELETE /mock*` from Task 3.
- Produces (on the controller): `get/set mockState`, `loadMock()`, `toggleFlowMock(id)`, `toggleCallMock(flowId, seq)`, `stopMock()`. DOM: `.mock-banner`, `.mock-flow[.on]`, `.mock-call[.on]`, `.mock-stop`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/app.test.js`:

```javascript
describe('Flows — mock server', () => {
  beforeEach(setupDom);

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const stubFetch = (map) => {
    globalThis.fetch = (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      const body = map[`${method} ${url}`] ?? map[url] ?? {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    };
  };
  const activeStatus = (over = {}) => ({
    active: true, port: 9091, url: 'http://192.168.1.9:9091',
    flows: [], calls: [], endpoints: [{ method: 'GET', path: '/x/profile', count: 1 }], ...over,
  });

  test('the Flows list renders a Serve-as-mock toggle per flow', async () => {
    stubFetch({ '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }], '/mock': { active: false, flows: [], calls: [], endpoints: [] } });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    expect(document.querySelector('#main .mock-flow[data-id="login"]')).toBeTruthy();
  });

  test('serving a flow shows the banner (with URL) and highlights the row', async () => {
    stubFetch({
      '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }],
      '/mock': { active: false, flows: [], calls: [], endpoints: [] },
      'POST /mock/flow/login': activeStatus({ flows: ['login'] }),
    });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    await app.toggleFlowMock('login');
    expect(document.querySelector('#main .mock-banner')).toBeTruthy();
    expect(document.querySelector('#main .mock-banner').textContent).toContain('192.168.1.9:9091');
    expect(document.querySelector('#main .mock-flow.on[data-id="login"]')).toBeTruthy();
  });

  test('stopMock clears the banner', async () => {
    stubFetch({ 'DELETE /mock': { active: false, flows: [], calls: [], endpoints: [] } });
    const app = createApp(document);
    app.mockState = activeStatus({ flows: ['login'] });
    app.flowList = [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }];
    app.setActive('logs');       // avoid loadFlows fetch; render logs then flip
    app.setActive('flows');
    await flush();
    await app.stopMock();
    expect(document.querySelector('#main .mock-banner')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/app.test.js -t "mock server"`
Expected: FAIL — `.mock-flow` not rendered / `toggleFlowMock` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/public/app.js`:

Add state next to the other `let` declarations (after `let flowDetail = null;`):
```javascript
  let mockState = { active: false, port: 9091, url: '', flows: [], calls: [], endpoints: [] };
```

Add the mock functions (place them just before `function renderFlows() {`):
```javascript
  // ---- mock server (replay saved flows as a live API) ----
  async function loadMock() {
    try { mockState = await (await fetch('/mock')).json(); } catch { /* keep last */ }
  }

  async function applyMock(res) {
    if (res && res.ok) mockState = await res.json();
    if (active === 'flows') fullRender();
  }

  async function toggleFlowMock(id) {
    const on = mockState.flows.includes(id);
    await applyMock(await fetch('/mock/flow/' + encodeURIComponent(id), { method: on ? 'DELETE' : 'POST' }));
  }

  async function toggleCallMock(flowId, seq) {
    const on = mockState.calls.includes(flowId + '#' + seq);
    await applyMock(await fetch('/mock/call/' + encodeURIComponent(flowId) + '/' + encodeURIComponent(seq), { method: on ? 'DELETE' : 'POST' }));
  }

  async function stopMock() {
    await applyMock(await fetch('/mock', { method: 'DELETE' }));
  }

  function mockBanner() {
    if (!mockState.active) return '';
    const n = mockState.endpoints.length;
    return `<div class="mock-banner">
      <div class="mock-banner-row">
        <span class="mock-dot"></span>
        <span>Mock API live · ${n} endpoint${n === 1 ? '' : 's'}</span>
        <button class="mock-stop">Stop</button>
      </div>
      ${codeBlock('point your app’s baseURL here', mockState.url)}
    </div>`;
  }
```

In `renderFlows()`, prepend the banner and add a per-row toggle. Replace the whole function body's `el.innerHTML = ...` for the list with:
```javascript
    el.innerHTML = mockBanner() + flowList.map((f) => `
      <div class="row flow-row" data-id="${esc(f.id)}">
        <span class="ts">${time(f.createdAt)}</span>
        <span class="flow-name">${esc(f.name)}</span>
        <span class="url"><span class="count">${f.count} call${f.count === 1 ? '' : 's'}</span></span>
        <button class="mock-flow ${mockState.flows.includes(f.id) ? 'on' : ''}" data-id="${esc(f.id)}">${mockState.flows.includes(f.id) ? '✓ Mocking' : '▶ Serve as mock'}</button>
        <button class="flow-export" data-id="${esc(f.id)}">Export</button>
        <button class="flow-del" data-id="${esc(f.id)}">Delete</button>
      </div>`).join('');
```
Also, in `renderFlows()`, when the list is empty, still show the banner — replace the empty branch:
```javascript
    if (!flowList.length) {
      el.innerHTML = mockBanner() + `<div class="empty">no saved flows yet — Clear, drive a flow, then “Save flow”</div>`;
      return;
    }
```

In `renderFlowDetail()`, prepend the banner and add a per-call toggle. Change the call row template (inside the `.map`) to add the toggle after the `<span class="url">…</span>` block — replace the `return` template's closing so each row is:
```javascript
      return `<div class="row">
        <span class="seq">#${c.seq}</span>
        <span class="method">${esc(c.method || '')}</span>
        <span class="status ${statusCls}">${c.status != null ? c.status : '···'}</span>
        <span class="url">${esc(c.url || '')}
          <details><summary>details${c.duration != null ? ' · ' + c.duration + 'ms' : ''}</summary>
            ${jsonBlock('Request', c.request)}
            ${jsonBlock('Response' + (c.status != null ? ' · ' + c.status : ''), c.response)}
          </details>
        </span>
        <button class="mock-call ${mockState.calls.includes(f.id + '#' + c.seq) ? 'on' : ''}" data-flow="${esc(f.id)}" data-seq="${esc(c.seq)}">${mockState.calls.includes(f.id + '#' + c.seq) ? '✓ Mocked' : 'Mock'}</button>
      </div>`;
```
And prepend `mockBanner()` to the detail body — change `}${body || ...` so the header is followed by the banner:
```javascript
      </div>${mockBanner()}${body || '<div class="empty">no calls in this flow</div>'}`;
```

Make `loadFlows()` and `openFlow()` also refresh mock state — in `loadFlows`, before `fullRender()`:
```javascript
    await loadMock();
```
In `openFlow`, before `fullRender()`:
```javascript
    await loadMock();
```

Add click handlers — in `start()`, inside the `main().addEventListener('click', ...)`, add these BEFORE the `.flow-export` handler:
```javascript
      const mflow = ev.target.closest('.mock-flow');
      if (mflow) { ev.stopPropagation(); toggleFlowMock(mflow.dataset.id); return; }
      const mcall = ev.target.closest('.mock-call');
      if (mcall) { ev.stopPropagation(); toggleCallMock(mcall.dataset.flow, mcall.dataset.seq); return; }
      if (ev.target.closest('.mock-stop')) { ev.stopPropagation(); stopMock(); return; }
```

Expose on the `controller` object (add to the returned object):
```javascript
    get mockState() { return mockState; },
    set mockState(v) { mockState = v; },
    loadMock,
    toggleFlowMock,
    toggleCallMock,
    stopMock,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/app.test.js -t "mock server"`
Expected: PASS (3 tests). Then run the whole client file: `npx vitest run packages/server/src/app.test.js` — all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/public/app.js packages/server/src/app.test.js
git commit -m "feat(client): Flows-tab mock toggles + live-mock banner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Client styling + browser verification

**Files:**
- Modify: `packages/server/public/index.html`

**Interfaces:**
- Consumes: DOM classes from Task 4 (`.mock-banner`, `.mock-flow`, `.mock-call`, `.mock-stop`, `.mock-dot`).

- [ ] **Step 1: Add CSS**

In `packages/server/public/index.html`, inside `<style>`, after the `.flow-*` rules (near the `.seq` rule), add:
```css
      .mock-flow, .mock-call { padding: 2px 8px; font-size: 11px; }
      .mock-flow.on, .mock-call.on { border-color: var(--green); color: var(--green); }
      .mock-banner { margin: 8px 12px; padding: 8px 10px; border: 1px solid var(--green); border-radius: 8px; background: var(--panel-2); }
      .mock-banner-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .mock-banner-row > span:nth-child(2) { flex: 1; color: var(--green); font-weight: 600; }
      .mock-stop { padding: 2px 12px; font-size: 11px; }
      .mock-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
```

- [ ] **Step 2: Build + browser smoke test**

Run:
```bash
npm run build
DEVTOOLS_PORT=9097 DEVTOOLS_MOCK_PORT=9192 DEVTOOLS_FLOWS_DIR="$(mktemp -d)" node packages/server/dist/index.js &
sleep 1
# seed a flow
curl -s -XPOST localhost:9097/flows -H 'content-type: application/json' \
  -d '{"name":"login","calls":[{"seq":1,"method":"GET","url":"https://api/x/profile","status":200,"request":{},"response":{"headers":{},"body":{"name":"Jane"}}}]}' >/dev/null
# enable it as a mock and hit the mock server
curl -s -XPOST localhost:9097/mock/flow/login >/dev/null
curl -s localhost:9192/x/profile
```
Expected: the final curl prints `{"name":"Jane"}`. Then open `http://localhost:9097`, go to **Flows**, confirm the row toggle + green banner with the mock URL render. Stop the server (`kill %1`).

- [ ] **Step 3: Commit**

```bash
git add packages/server/public/index.html
git commit -m "feat(client): styling for mock toggles + live-mock banner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the mock server**

In `CLAUDE.md`, in the `packages/server` bullet list, after the `flows.ts` bullet, add:
```markdown
  - `mock.ts` — **replay saved flows as a live API**: `createMockServer(getRoutes)`
    serves recorded responses matched by method+path (query/host stripped),
    sequence-replaying repeated calls. The relay composes a route map from a
    registry of enabled whole-flows + individual calls and starts/stops the mock
    server on port 9091 (`DEVTOOLS_MOCK_PORT`). Control: `GET/DELETE /mock`,
    `POST/DELETE /mock/flow/:id`, `POST/DELETE /mock/call/:flowId/:seq`. The Flows
    tab toggles sources and shows the mock base URL to point the app at.
```

- [ ] **Step 2: Full verification**

Run:
```bash
npx vitest run
npm run typecheck --workspace @rebynx/core --workspace @rebynx/server
```
Expected: all tests pass; core + server typecheck clean (the pre-existing `packages/rn/src/Overlay.tsx` React-Native JSX errors are unrelated and out of scope).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the mock API server in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Run model (separate port 9091, in-process, Flows-tab control) → Tasks 3, 4, 5.
- Two granularities (whole flow + individual call) → registry in Task 3, toggles in Task 4.
- Registry union deduped by `flowId#seq`, sequence merge → Task 3 `rebuildRoutes` + Task 1 `buildRoutes`.
- Match method+path, sequence replay, clamp → Task 1 `matchCall`.
- Response fidelity (status/headers strip/body), CORS, OPTIONS 204, 404 JSON → Task 2.
- Control endpoints + status shape → Task 3.
- Client toggles + banner + sync → Task 4/5.
- Tests at all three layers → Tasks 1–4.
- Out of scope items are not implemented. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `RouteMap`, `buildRoutes`, `matchCall`, `createMockServer(getRoutes)`, `mockPort`, and the status shape `{ active, port, url, flows, calls, endpoints:[{method,path,count}] }` are used identically across Tasks 1–4. Client method names (`toggleFlowMock`, `toggleCallMock`, `stopMock`, `loadMock`, `mockState`) match between implementation and tests. ✓
