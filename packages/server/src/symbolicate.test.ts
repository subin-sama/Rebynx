import { describe, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseStack, firstAppFrame, symbolicate, type Frame } from './symbolicate.js';

describe('parseStack', () => {
  test('parses V8, Hermes and JSC frames and ignores junk lines', () => {
    const stack = [
      'Error',
      '    at fetchData (http://localhost:3000/src/api.js:12:34)',
      '    at http://localhost:3000/src/boot.js:5:6',
      '    at loadUser (address at /path/index.bundle:1:12345)',
      'submit@http://localhost:8081/index.bundle:1:999',
    ].join('\n');
    const f = parseStack(stack);
    expect(f).toHaveLength(4);
    expect(f[0]).toEqual({ methodName: 'fetchData', file: 'http://localhost:3000/src/api.js', lineNumber: 12, column: 34 });
    expect(f[1]).toEqual({ methodName: '', file: 'http://localhost:3000/src/boot.js', lineNumber: 5, column: 6 });
    expect(f[2]).toEqual({ methodName: 'loadUser', file: '/path/index.bundle', lineNumber: 1, column: 12345 });
    expect(f[3]).toEqual({ methodName: 'submit', file: 'http://localhost:8081/index.bundle', lineNumber: 1, column: 999 });
  });

  test('empty / rubbish input yields no frames', () => {
    expect(parseStack('')).toEqual([]);
    expect(parseStack('no frames here')).toEqual([]);
  });
});

describe('firstAppFrame', () => {
  const F = (file: string, methodName = 'fn'): Frame => ({ methodName, file, lineNumber: 1, column: 1 });

  test('skips library frames and returns the app frame', () => {
    const got = firstAppFrame([F('/app/node_modules/axios/lib/xhr.js'), F('/app/src/api.ts', 'callApi'), F('/app/src/App.tsx')]);
    expect(got?.methodName).toBe('callApi');
  });

  test('skips rebynx, RN internals and native frames', () => {
    const got = firstAppFrame([
      F('/x/node_modules/@rebynx/core/dist/collectors.js'),
      F('/x/node_modules/react-native/Libraries/Network/XHR.js'),
      F('[native code]'),
      F('/app/src/a.ts', 'mine'),
    ]);
    expect(got?.methodName).toBe('mine');
  });

  test('falls back to the first frame when everything looks like a library', () => {
    expect(firstAppFrame([F('/app/node_modules/a/b.js', 'lib')])?.methodName).toBe('lib');
  });

  test('null when there are no frames', () => {
    expect(firstAppFrame([])).toBeNull();
  });
});

describe('symbolicate', () => {
  async function bootMetro(respond: (body: any) => any) {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const out = respond(JSON.parse(data || '{}'));
        if (out === null) { res.writeHead(500); res.end('boom'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  }

  const frame: Frame = { methodName: 'callApi', file: '/path/index.bundle', lineNumber: 1, column: 12345 };

  test('posts the frames to metro and returns the symbolicated stack', async () => {
    let got: any;
    const { server, url } = await bootMetro((body) => {
      got = body;
      return { stack: [{ methodName: 'callApi', file: '/app/src/api.ts', lineNumber: 12, column: 3 }] };
    });
    try {
      const out = await symbolicate([frame], url);
      expect(got.stack).toEqual([frame]); // posted the raw frames
      expect(out?.[0]).toEqual({ methodName: 'callApi', file: '/app/src/api.ts', lineNumber: 12, column: 3 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('returns null when metro errors', async () => {
    const { server, url } = await bootMetro(() => null); // 500
    try {
      expect(await symbolicate([frame], url)).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('returns null when metro is unreachable (never throws)', async () => {
    expect(await symbolicate([frame], 'http://127.0.0.1:1', 300)).toBeNull();
  });

  test('returns null for no frames', async () => {
    expect(await symbolicate([], 'http://127.0.0.1:1')).toBeNull();
  });
});
