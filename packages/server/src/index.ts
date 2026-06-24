/**
 * Relay + static host.
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
 *     and expose GET /open so a source link in the browser can jump straight to
 *     the line in your editor.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEVTOOLS_PORT ?? 9090);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const RING_SIZE = 500;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const ring: unknown[] = [];
const apps = new Set<WebSocket>();
const browsers = new Set<WebSocket>();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

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
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
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
        } else {
          browsers.add(ws);
          // Replay history to the freshly-connected browser.
          for (const event of ring) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'event', event }));
          }
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
    apps.delete(ws);
    browsers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Rebynx relay`);
  console.log(`  ├─ browser client : http://localhost:${PORT}`);
  console.log(`  └─ app connects to: ws://<your-machine-ip>:${PORT}\n`);
});
