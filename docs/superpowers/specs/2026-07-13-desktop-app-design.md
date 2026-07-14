# Design: Rebynx desktop app (Electron)

**Date:** 2026-07-13
**Status:** Approved

## Problem

Using the Rebynx browser client today means cloning the repo, building, running
`npm run server`, and opening a browser — friction every session. Package Rebynx
as a **double-clickable desktop app**: one window showing the client, with the
relay running inside it, so a React Native app on an emulator/device can connect
and events stream into the window.

## Why Electron

The relay is Node and Electron's main process **is** Node, so the app embeds the
existing relay in-process — no rewrite, no sidecar. The window just loads the
already-built client over http, so `WebSocket(ws://location.host)` and `/flows`
work unchanged. (Tauri's Rust main would need a bundled Node sidecar or a full
relay rewrite — far more work here.) The tradeoff is app size (~150–250 MB
Chromium), accepted for the desktop-app experience.

## Architecture — new workspace `packages/desktop`

```
Electron main (Node)
  ├─ start relay: createRelayServer().listen(9090, '0.0.0.0')   (embedded)
  └─ BrowserWindow.loadURL('http://localhost:9090')             (existing client)

RN app on emulator/device ──ws://<LAN-IP>:9090──▶ embedded relay ──▶ window
```

- **`packages/server`**: add an `exports` map so the app can import the factory:
  `"." : "./dist/index.js"`, `"./server": "./dist/server.js"`. (cli.mjs imports a
  relative path, so it's unaffected; nothing else imports the package by name.)
- **`packages/desktop/lib/net-util.mjs`** (pure Node, no Electron → testable):
  - `portInUse(port): Promise<boolean>` — a `net` connect probe.
  - `lanIp(): string` — first non-internal IPv4 from `os.networkInterfaces()`,
    else `localhost`.
- **`packages/desktop/main.mjs`** (Electron main):
  - On `app.whenReady()`: if `portInUse(PORT)` → a relay is already running, reuse
    it; else `createRelayServer().listen(PORT, '0.0.0.0')`.
  - Create a `BrowserWindow` titled `Rebynx — ws://<lanIp>:<PORT>` (so the user
    knows what to point the RN app at) and `loadURL('http://localhost:'+PORT)`.
  - `window-all-closed` → `app.quit()` (a devtool; quitting on close is fine).
  - `PORT` from `DEVTOOLS_PORT` env, default `9090`.
- **`packages/desktop/package.json`**: `main: main.mjs`; dep `@rebynx/server`;
  devDeps `electron`, `electron-builder`; scripts `start` (`electron .`) and
  `dist` (`electron-builder --mac`); an `electron-builder` block targeting a mac
  `.app`/`.dmg` (unsigned — personal use; first open via right-click → Open).

## Run / build

- `npm start --workspace @rebynx/desktop` — launch the app (dev).
- `npm run dist --workspace @rebynx/desktop` — produce `Rebynx.app` (+ `.dmg`) in
  `packages/desktop/release/`. Double-click to launch; no terminal, no `npm`.
- A root `app` / `app:dist` script wraps these for convenience.

## Error handling

- Port 9090 busy but not a relay → the window loads whatever is there; acceptable
  edge for a local devtool (documented).
- Relay fails to listen → log to the main process console; the window still opens
  (and shows the client's "reconnecting…" state).

## Testing

- `packages/desktop/test/net-util.test.js` (vitest): `portInUse` returns true for
  a port with a live `net` server bound and false for a free one; `lanIp` returns
  a non-empty string.
- Smoke: build core+server, launch `electron .`, and `curl http://localhost:9090`
  to confirm the embedded relay serves the client; confirm the window renders.

## Out of scope (later)

Code signing / notarization / distribution to teammates; auto-update; Windows/
Linux packaging (the `electron-builder` config can add targets later).
