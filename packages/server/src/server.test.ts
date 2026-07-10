import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';

let server: Server;
let base: string;
let flowsDir: string;

beforeEach(async () => {
  flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebynx-http-'));
  server = createRelayServer({ flowsDir });
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
