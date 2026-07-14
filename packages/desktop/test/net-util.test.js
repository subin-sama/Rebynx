import { afterEach, describe, expect, test } from 'vitest';
import net from 'node:net';
import { lanIp, portInUse } from '../lib/net-util.mjs';

/** Bind a throwaway server and hand back its port + a closer. */
function listen() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) });
    });
  });
}

/** A port that was bound then released — free again. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let cleanup = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe('portInUse', () => {
  test('is true while a server is listening on the port', async () => {
    const srv = await listen();
    cleanup.push(srv.close);
    expect(await portInUse(srv.port)).toBe(true);
  });

  test('is false for a free port', async () => {
    const port = await freePort();
    expect(await portInUse(port)).toBe(false);
  });
});

describe('lanIp', () => {
  test('returns a non-empty string (an address or the localhost fallback)', () => {
    const ip = lanIp();
    expect(typeof ip).toBe('string');
    expect(ip.length).toBeGreaterThan(0);
  });
});
