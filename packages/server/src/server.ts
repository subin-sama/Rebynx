/**
 * Relay + static host — the reusable factory.
 *
 *   app(s)  ──hello:app──┐
 *                        ├─►  relay  ──replay+live──►  browser(s)
 *   browser ─hello:browser┘         ◄──commands───────
 *
 * Three jobs:
 *  1. Broadcast events from app(s) to every connected browser.
 *  2. Keep a ring buffer and replay it to a browser the moment it connects,
 *     so a page refresh (or a reconnect after the app restarted) doesn't start
 *     from an empty screen. This is the fix for the "logs vanish on reload" pain.
 *  3. Forward commands (clear, inspect-at, …) from browser back to the app(s),
 *     expose GET /open so a source link jumps to your editor, and serve the
 *     /flows storage API (save/list/get/delete captured network flows).
 *
 * `createRelayServer()` returns a configured but NOT-yet-listening http.Server,
 * so the entrypoint (index.ts) and tests can both drive it. Keeping this free of
 * listen() side effects is what lets server.test.ts boot it on an ephemeral port.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { deleteFlow, getFlow, listFlows, saveFlow, updateCall, mocksToFlow } from './flows.js';
import type { FlowCall } from './flows.js';
import { buildRoutes, createMockServer, type RouteMap } from './mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RING_SIZE = 500;

/** First non-internal IPv4 address a device/emulator should dial, else 'localhost'. */
export function lanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

export const DEFAULT_PUBLIC_DIR = path.join(__dirname, '..', 'public');
export const DEFAULT_FLOWS_DIR = process.env.DEVTOOLS_FLOWS_DIR ?? path.join(__dirname, '..', 'flows');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Read and JSON-parse a request body. Rejects on invalid JSON or oversized input. */
function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Flow storage REST API. Returns true when it owns the request, so the main
 * handler can fall through to /open and the static client otherwise.
 *
 *   GET    /flows       -> FlowSummary[]
 *   POST   /flows       -> save { name, notes?, calls } -> Flow
 *   GET    /flows/:id   -> Flow
 *   DELETE /flows/:id   -> { ok: true }
 */
async function handleFlows(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  flowsDir: string,
): Promise<boolean> {
  // Import an api-ui-mapper mock map as a new flow (checked before /flows/:id).
  if (url.pathname === '/flows/import') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const mocks = body?.mocks;
    if (!name) {
      sendJson(res, 400, { error: 'name required' });
      return true;
    }
    if (!mocks || typeof mocks !== 'object' || Array.isArray(mocks)) {
      sendJson(res, 400, { error: 'mocks must be an object' });
      return true;
    }
    const flow = await saveFlow(flowsDir, mocksToFlow(mocks, name));
    sendJson(res, 201, flow);
    return true;
  }

  if (url.pathname === '/flows') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listFlows(flowsDir));
      return true;
    }
    if (req.method === 'POST') {
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return true;
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendJson(res, 400, { error: 'name required' });
        return true;
      }
      const calls = Array.isArray(body?.calls) ? body.calls : [];
      const notes = typeof body?.notes === 'string' ? body.notes : undefined;
      const flow = await saveFlow(flowsDir, { name, notes, calls });
      sendJson(res, 201, flow);
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  const match = url.pathname.match(/^\/flows\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (req.method === 'GET') {
      const flow = await getFlow(flowsDir, id);
      if (!flow) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      sendJson(res, 200, flow);
      return true;
    }
    if (req.method === 'DELETE') {
      const ok = await deleteFlow(flowsDir, id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  return false;
}

export interface RelayOptions {
  /** Where captured flows are stored. Defaults to DEFAULT_FLOWS_DIR. */
  flowsDir?: string;
  /** Where the browser client is served from. Defaults to DEFAULT_PUBLIC_DIR. */
  publicDir?: string;
  /** Port for the mock API server. Defaults to DEVTOOLS_MOCK_PORT or 9091. */
  mockPort?: number;
}

/** Build the relay http.Server (with WebSocket relay attached). Does not listen. */
export function createRelayServer(opts: RelayOptions = {}): http.Server {
  const flowsDir = opts.flowsDir ?? DEFAULT_FLOWS_DIR;
  const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
  fs.mkdirSync(flowsDir, { recursive: true });

  // ---- mock API server: replay a composable set of saved flows/calls ----
  const mockPort = opts.mockPort ?? (process.env.DEVTOOLS_MOCK_PORT ? Number(process.env.DEVTOOLS_MOCK_PORT) : 9091);
  const enabledFlows = new Set<string>();
  const enabledCalls = new Set<string>(); // "flowId#seq"
  let mockServer: http.Server | null = null;
  let mockRoutes: RouteMap = {};
  let activePort = mockPort;
  let mockTiming = false; // replay each call's captured latency

  // Persist which flows/calls are mocked (+ timing) so reopening restores them.
  const mockStateFile = path.join(flowsDir, '.mock-state.json');
  function saveMockState(): void {
    try {
      fs.writeFileSync(mockStateFile, JSON.stringify({ flows: [...enabledFlows], calls: [...enabledCalls], timing: mockTiming }));
    } catch { /* best effort */ }
  }
  // Restore synchronously so GET /mock reports the registry immediately on boot.
  try {
    const saved = JSON.parse(fs.readFileSync(mockStateFile, 'utf8'));
    if (Array.isArray(saved?.flows)) for (const f of saved.flows) enabledFlows.add(f);
    if (Array.isArray(saved?.calls)) for (const c of saved.calls) enabledCalls.add(c);
    if (typeof saved?.timing === 'boolean') mockTiming = saved.timing;
  } catch { /* no saved state */ }

  // Resolve the enabled sources from disk into a grouped route map. Flow calls
  // then individually-enabled calls, deduped by flowId#seq (sequence merge).
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

  // Rebuild routes and start/stop the mock server to match the registry.
  async function syncMock(): Promise<void> {
    await rebuildRoutes();
    const shouldRun = enabledFlows.size + enabledCalls.size > 0;
    if (shouldRun && !mockServer) {
      mockServer = createMockServer(() => mockRoutes, () => mockTiming);
      await new Promise<void>((resolve) => mockServer!.listen(mockPort, '0.0.0.0', () => resolve()));
      activePort = (mockServer.address() as AddressInfo).port;
    } else if (!shouldRun && mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
    saveMockState();
  }

  // Bring a restored registry live (async — GET /mock already reports the sets).
  if (enabledFlows.size + enabledCalls.size > 0) void syncMock();

  function mockStatus() {
    const endpoints = Object.entries(mockRoutes).map(([k, list]) => {
      const sp = k.indexOf(' ');
      return { method: k.slice(0, sp), path: k.slice(sp + 1), count: list.length };
    });
    const port = mockServer ? activePort : mockPort;
    return {
      active: !!mockServer,
      port,
      url: `http://${lanIp()}:${port}`,
      timing: mockTiming,
      flows: [...enabledFlows],
      calls: [...enabledCalls],
      endpoints,
    };
  }

  /**
   * Control API for the mock server. Returns true when it owns the request.
   *
   *   GET    /mock                     -> status
   *   DELETE /mock                     -> clear + stop
   *   POST   /mock/flow/:id            -> enable a whole flow
   *   DELETE /mock/flow/:id            -> disable a whole flow
   *   POST   /mock/call/:flowId/:seq   -> enable one call
   *   DELETE /mock/call/:flowId/:seq   -> disable one call
   */
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
    if (url.pathname === '/mock/timing' && req.method === 'POST') {
      let body: any;
      try { body = await readJsonBody(req); } catch { body = {}; }
      mockTiming = typeof body?.on === 'boolean' ? body.on : !mockTiming;
      saveMockState();
      sendJson(res, 200, mockStatus());
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

  // DELETE /flows/:id — delete the flow AND drop it from the mock registry, so a
  // running mock stops serving it (handleFlows can't reach the registry).
  async function handleFlowDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const m = url.pathname.match(/^\/flows\/([^/]+)$/);
    if (!m || req.method !== 'DELETE') return false;
    const id = decodeURIComponent(m[1]);
    const ok = await deleteFlow(flowsDir, id);
    let changed = enabledFlows.delete(id);
    for (const ck of [...enabledCalls]) {
      if (ck.startsWith(id + '#')) { enabledCalls.delete(ck); changed = true; }
    }
    if (changed) await syncMock();
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    return true;
  }

  // PATCH /flows/:id/calls/:seq — edit a saved call's body/status in place. Lives
  // here (not handleFlows) because it must rebuild a running mock's routes so the
  // edit is served immediately.
  async function handleFlowPatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const m = url.pathname.match(/^\/flows\/([^/]+)\/calls\/([^/]+)$/);
    if (!m) return false;
    if (req.method !== 'PATCH') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }
    const flow = await updateCall(flowsDir, decodeURIComponent(m[1]), Number(m[2]), body ?? {});
    if (!flow) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (enabledFlows.size + enabledCalls.size > 0) await rebuildRoutes();
    sendJson(res, 200, flow);
    return true;
  }

  const ring: unknown[] = [];
  const apps = new Set<WebSocket>();
  const browsers = new Set<WebSocket>();

  // Tell every browser how many apps are currently connected (Setup tab status).
  const broadcastPresence = () => {
    const msg = JSON.stringify({ kind: 'presence', apps: apps.size });
    for (const b of browsers) if (b.readyState === b.OPEN) b.send(msg);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (await handleMock(req, res, url)) return;
      if (await handleFlowPatch(req, res, url)) return;
      if (await handleFlowDelete(req, res, url)) return;
      if (await handleFlows(req, res, url, flowsDir)) return;
    } catch {
      sendJson(res, 500, { error: 'internal error' });
      return;
    }

    // Connection info for the client's Setup tab (LAN address + live app count).
    if (url.pathname === '/info') {
      sendJson(res, 200, { lanIp: lanIp(), apps: apps.size });
      return;
    }

    // Jump-to-code: open a file at a line in VS Code (falls back gracefully).
    if (url.pathname === '/open') {
      const file = url.searchParams.get('file');
      const line = url.searchParams.get('line') ?? '1';
      if (file) {
        // `code -g file:line` — swap for your editor (e.g. cursor, webstorm) if needed.
        exec(`code -g "${file}:${line}"`, (err) => {
          res.writeHead(err ? 500 : 200, { 'content-type': 'text/plain' });
          res.end(err ? `could not open editor: ${err.message}` : 'ok');
        });
      } else {
        res.writeHead(400);
        res.end('missing file');
      }
      return;
    }

    // Static client.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(publicDir, rel);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const raw = data.toString();
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.kind) {
        case 'hello': {
          if (msg.role === 'app') {
            apps.add(ws);
            broadcastPresence();
          } else {
            browsers.add(ws);
            // Replay history to the freshly-connected browser.
            for (const event of ring) {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'event', event }));
            }
            // Give the new browser the current app count immediately.
            broadcastPresence();
          }
          break;
        }
        case 'event': {
          ring.push(msg.event);
          if (ring.length > RING_SIZE) ring.shift();
          for (const b of browsers) if (b.readyState === b.OPEN) b.send(raw);
          break;
        }
        case 'command': {
          if (msg.command?.type === 'clear') ring.length = 0;
          for (const a of apps) if (a.readyState === a.OPEN) a.send(raw);
          break;
        }
      }
    });

    ws.on('close', () => {
      const wasApp = apps.delete(ws);
      browsers.delete(ws);
      if (wasApp) broadcastPresence();
    });
  });

  // Tear down the mock server alongside the relay (keeps tests/ports clean).
  server.on('close', () => { if (mockServer) mockServer.close(); });

  return server;
}
