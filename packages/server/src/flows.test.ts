import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteFlow,
  getFlow,
  listFlows,
  safeId,
  saveFlow,
  slugify,
  updateCall,
  type FlowCall,
} from './flows.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebynx-flows-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (seq: number): FlowCall => ({
  seq,
  method: 'GET',
  url: `https://api.example.com/step/${seq}`,
  status: 200,
  ok: true,
  duration: 10,
  request: { headers: { 'x-req': '1' }, body: { a: seq } },
  response: { headers: { 'content-type': 'application/json' }, body: { ok: true } },
});

describe('slugify', () => {
  test('lowercases and dashes spaces', () => {
    expect(slugify('Checkout Flow')).toBe('checkout-flow');
  });

  test('collapses runs and trims dashes', () => {
    expect(slugify('  Add   to  Cart!! ')).toBe('add-to-cart');
  });

  test('replaces slashes so a name can never escape the dir', () => {
    expect(slugify('a/b')).toBe('a-b');
  });

  test('falls back to "flow" when nothing slug-able remains', () => {
    expect(slugify('   ')).toBe('flow');
    expect(slugify('!!!')).toBe('flow');
    expect(slugify('ทดสอบ')).toBe('flow');
  });
});

describe('safeId', () => {
  test('accepts a clean slug', () => {
    expect(safeId('checkout-flow-2')).toBe('checkout-flow-2');
  });

  test('rejects traversal, slashes and dots', () => {
    expect(safeId('../etc')).toBeNull();
    expect(safeId('a/b')).toBeNull();
    expect(safeId('a.b')).toBeNull();
    expect(safeId('')).toBeNull();
    expect(safeId('UPPER')).toBeNull();
  });
});

describe('saveFlow', () => {
  test('writes a file, stamps createdAt, returns the slugged id', async () => {
    const flow = await saveFlow(dir, { name: 'Checkout Flow', calls: [call(1)] });

    expect(flow.id).toBe('checkout-flow');
    expect(flow.name).toBe('Checkout Flow');
    expect(typeof flow.createdAt).toBe('number');
    expect(flow.createdAt).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'checkout-flow.json'))).toBe(true);
  });

  test('never overwrites a duplicate name — suffixes the id instead', async () => {
    const a = await saveFlow(dir, { name: 'Login', calls: [call(1)] });
    const b = await saveFlow(dir, { name: 'Login', calls: [call(2)] });
    const c = await saveFlow(dir, { name: 'Login', calls: [call(3)] });

    expect(a.id).toBe('login');
    expect(b.id).toBe('login-2');
    expect(c.id).toBe('login-3');

    // original is untouched
    const first = await getFlow(dir, 'login');
    expect(first?.calls[0].url).toBe('https://api.example.com/step/1');
  });
});

describe('listFlows', () => {
  test('returns summaries without bodies, newest first', async () => {
    await saveFlow(dir, { name: 'First', calls: [call(1)], createdAt: 1000 });
    await saveFlow(dir, { name: 'Second', calls: [call(1), call(2)], createdAt: 2000 });

    const list = await listFlows(dir);

    expect(list.map((f) => f.id)).toEqual(['second', 'first']);
    expect(list[0]).toEqual({ id: 'second', name: 'Second', createdAt: 2000, count: 2 });
    // summaries must not leak call bodies
    expect(list[0]).not.toHaveProperty('calls');
  });

  test('is empty for a fresh dir and skips malformed files', async () => {
    expect(await listFlows(dir)).toEqual([]);

    await saveFlow(dir, { name: 'Good', calls: [call(1)], createdAt: 1000 });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');

    const list = await listFlows(dir);
    expect(list.map((f) => f.id)).toEqual(['good']);
  });
});

describe('getFlow', () => {
  test('round-trips a saved flow', async () => {
    await saveFlow(dir, { name: 'Cart', notes: 'hi', calls: [call(1), call(2)] });

    const flow = await getFlow(dir, 'cart');
    expect(flow?.name).toBe('Cart');
    expect(flow?.notes).toBe('hi');
    expect(flow?.calls).toHaveLength(2);
    expect(flow?.calls[1].response.body).toEqual({ ok: true });
  });

  test('returns null for unknown and for unsafe ids', async () => {
    expect(await getFlow(dir, 'nope')).toBeNull();
    expect(await getFlow(dir, '../secrets')).toBeNull();
  });
});

describe('deleteFlow', () => {
  test('removes the file and reports whether it existed', async () => {
    await saveFlow(dir, { name: 'Temp', calls: [call(1)] });

    expect(await deleteFlow(dir, 'temp')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'temp.json'))).toBe(false);
    expect(await deleteFlow(dir, 'temp')).toBe(false);
    expect(await deleteFlow(dir, '../etc')).toBe(false);
  });
});

describe('listFlows', () => {
  test('ignores dotfiles (e.g. the .mock-state.json registry)', async () => {
    await saveFlow(dir, { name: 'Flow', calls: [call(1)] });
    fs.writeFileSync(path.join(dir, '.mock-state.json'), '{"flows":["flow"],"calls":[]}');
    const list = await listFlows(dir);
    expect(list.map((f) => f.id)).toEqual(['flow']);
  });
});

describe('updateCall', () => {
  test('edits response body, request body and status, recomputing ok + persisting', async () => {
    await saveFlow(dir, { name: 'Flow', calls: [call(1), call(2)] });

    const updated = await updateCall(dir, 'flow', 1, {
      requestBody: { a: 99 },
      responseBody: { changed: true },
      status: 401,
    });

    expect(updated).not.toBeNull();
    const c1 = updated!.calls.find((c) => c.seq === 1)!;
    expect(c1.request.body).toEqual({ a: 99 });
    expect(c1.response.body).toEqual({ changed: true });
    expect(c1.status).toBe(401);
    expect(c1.ok).toBe(false); // recomputed from status
    // other calls untouched
    expect(updated!.calls.find((c) => c.seq === 2)!.response.body).toEqual({ ok: true });

    // persisted to disk
    const reloaded = await getFlow(dir, 'flow');
    expect(reloaded!.calls.find((c) => c.seq === 1)!.response.body).toEqual({ changed: true });
  });

  test('a body can be set to null (presence-checked, not truthiness)', async () => {
    await saveFlow(dir, { name: 'Flow', calls: [call(1)] });
    const updated = await updateCall(dir, 'flow', 1, { responseBody: null });
    expect(updated!.calls[0].response.body).toBeNull();
  });

  test('edits method, url, and request/response headers', async () => {
    await saveFlow(dir, { name: 'Flow', calls: [call(1)] });
    const u = await updateCall(dir, 'flow', 1, {
      method: 'POST', url: 'https://new/x',
      requestHeaders: { 'x-new': '1' }, responseHeaders: { 'content-type': 'text/plain' },
    });
    const c = u!.calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://new/x');
    expect(c.request.headers).toEqual({ 'x-new': '1' });
    expect(c.response.headers).toEqual({ 'content-type': 'text/plain' });
  });

  test('returns null for an unknown id or seq', async () => {
    await saveFlow(dir, { name: 'Flow', calls: [call(1)] });
    expect(await updateCall(dir, 'nope', 1, { status: 200 })).toBeNull();
    expect(await updateCall(dir, 'flow', 999, { status: 200 })).toBeNull();
    expect(await updateCall(dir, '../etc', 1, { status: 200 })).toBeNull();
  });
});
