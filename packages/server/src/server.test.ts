import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitFor(pred: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: Server;
let base: string;
let flowsDir: string;

beforeEach(async () => {
  flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebynx-http-'));
  server = createRelayServer({ flowsDir, mockPort: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(flowsDir, { recursive: true, force: true });
});

const sampleCall = {
  seq: 1,
  method: 'GET',
  url: 'https://api.example.com/step/1',
  status: 200,
  ok: true,
  request: { headers: {}, body: null },
  response: { headers: {}, body: { ok: true } },
};

describe('POST /flows (the Save flow button)', () => {
  // Regression for the reported "Save -> 404": the route must exist and save.
  test('saves the snapshot and responds 201 with the flow', async () => {
    const res = await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Checkout Flow', calls: [sampleCall] }),
    });

    expect(res.status).toBe(201);
    const flow: any = await res.json();
    expect(flow.id).toBe('checkout-flow');
    expect(flow.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(flowsDir, 'checkout-flow.json'))).toBe(true);
  });

  test('rejects a missing name with 400', async () => {
    const res = await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calls: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects a malformed body with 400', async () => {
    const res = await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /flows', () => {
  test('lists saved flows as summaries', async () => {
    await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Login', calls: [sampleCall, { ...sampleCall, seq: 2 }] }),
    });

    const res = await fetch(`${base}/flows`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toEqual([{ id: 'login', name: 'Login', createdAt: expect.any(Number), count: 2 }]);
  });
});

describe('GET /flows/:id', () => {
  test('returns the full flow, and 404 for an unknown id', async () => {
    await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cart', calls: [sampleCall] }),
    });

    const ok = await fetch(`${base}/flows/cart`);
    expect(ok.status).toBe(200);
    const flow: any = await ok.json();
    expect(flow.name).toBe('Cart');

    const missing = await fetch(`${base}/flows/nope`);
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /flows/:id', () => {
  test('removes the flow', async () => {
    await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Temp', calls: [sampleCall] }),
    });

    const del = await fetch(`${base}/flows/temp`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(flowsDir, 'temp.json'))).toBe(false);

    const again = await fetch(`${base}/flows/temp`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

describe('fall-through', () => {
  test('unknown paths still 404 from the static handler', async () => {
    const res = await fetch(`${base}/definitely-not-a-file`);
    expect(res.status).toBe(404);
  });

  // Ties client + routing together: if the served client has a Save button,
  // the same build must also answer the /flows route it posts to.
  test('GET / serves the browser client that has the Save flow button', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="save-flow"');
  });
});

describe('connection info + presence', () => {
  test('GET /info returns the LAN address and a live app count', async () => {
    const res = await fetch(`${base}/info`);
    expect(res.status).toBe(200);
    const info: any = await res.json();
    expect(typeof info.lanIp).toBe('string');
    expect(info.lanIp.length).toBeGreaterThan(0);
    expect(info.apps).toBe(0);
  });

  test('broadcasts presence to browsers when an app connects then disconnects', async () => {
    const wsUrl = base.replace('http', 'ws');
    const browser = await openWs(wsUrl);
    const seen: number[] = [];
    browser.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.kind === 'presence' && typeof m.apps === 'number') seen.push(m.apps);
    });
    browser.send(JSON.stringify({ kind: 'hello', role: 'browser' }));

    const appWs = await openWs(wsUrl);
    appWs.send(JSON.stringify({ kind: 'hello', role: 'app' }));
    await waitFor(() => seen.includes(1));

    appWs.close();
    await waitFor(() => seen[seen.length - 1] === 0);

    browser.close();
    expect(seen).toContain(1);
    expect(seen[seen.length - 1]).toBe(0);
  });

  test('sends a browser the current app count right after it says hello', async () => {
    const wsUrl = base.replace('http', 'ws');
    // an app is already connected
    const appWs = await openWs(wsUrl);
    appWs.send(JSON.stringify({ kind: 'hello', role: 'app' }));
    await new Promise((r) => setTimeout(r, 30));

    const browser = await openWs(wsUrl);
    let firstPresence = -1;
    browser.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.kind === 'presence' && firstPresence < 0) firstPresence = m.apps;
    });
    browser.send(JSON.stringify({ kind: 'hello', role: 'browser' }));
    await waitFor(() => firstPresence >= 0);

    expect(firstPresence).toBe(1);
    appWs.close();
    browser.close();
  });
});

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
    const status: any = await (await fetch(`${base}/mock/flow/login`, { method: 'POST' })).json();
    expect(status.active).toBe(true);
    expect(status.flows).toContain('login');
    expect(status.endpoints.map((e: any) => e.path).sort()).toEqual(['/x/logout', '/x/profile']);
    const hit = await fetch(`http://127.0.0.1:${status.port}/x/profile`);
    expect(await hit.json()).toEqual({ name: 'Jane' });
  });

  test('enabling a single call serves only that endpoint', async () => {
    await saveSample();
    const status: any = await (await fetch(`${base}/mock/call/login/1`, { method: 'POST' })).json();
    expect(status.calls).toContain('login#1');
    expect(status.endpoints.map((e: any) => e.path)).toEqual(['/x/profile']);
  });

  test('GET /mock reports current state; DELETE /mock clears + stops', async () => {
    await saveSample();
    await fetch(`${base}/mock/flow/login`, { method: 'POST' });
    const now: any = await (await fetch(`${base}/mock`)).json();
    expect(now.active).toBe(true);
    const cleared: any = await (await fetch(`${base}/mock`, { method: 'DELETE' })).json();
    expect(cleared.active).toBe(false);
    expect(cleared.flows).toEqual([]);
  });

  test('enabling a missing flow is 404', async () => {
    expect((await fetch(`${base}/mock/flow/nope`, { method: 'POST' })).status).toBe(404);
  });
});

describe('PATCH /flows/:id/calls/:seq (edit a saved call)', () => {
  async function save() {
    await fetch(`${base}/flows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'edit',
        calls: [{ seq: 1, method: 'GET', url: 'https://api/x/profile', status: 200, request: {}, response: { headers: {}, body: { name: 'Jane' } } }],
      }),
    });
  }

  test('edits a call and returns the updated flow', async () => {
    await save();
    const res = await fetch(`${base}/flows/edit/calls/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseBody: { name: 'EDITED' }, status: 403 }),
    });
    expect(res.status).toBe(200);
    const flow: any = await res.json();
    expect(flow.calls[0].response.body).toEqual({ name: 'EDITED' });
    expect(flow.calls[0].status).toBe(403);
    expect(flow.calls[0].ok).toBe(false);
  });

  test('a live mock serves the edited response after PATCH (no re-toggle)', async () => {
    await save();
    const status: any = await (await fetch(`${base}/mock/flow/edit`, { method: 'POST' })).json();
    expect(await (await fetch(`http://127.0.0.1:${status.port}/x/profile`)).json()).toEqual({ name: 'Jane' });
    await fetch(`${base}/flows/edit/calls/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseBody: { name: 'EDITED' } }),
    });
    expect(await (await fetch(`http://127.0.0.1:${status.port}/x/profile`)).json()).toEqual({ name: 'EDITED' });
  });

  test('unknown seq → 404; invalid json → 400', async () => {
    await save();
    expect((await fetch(`${base}/flows/edit/calls/999`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/flows/edit/calls/1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{ bad' })).status).toBe(400);
  });
});
