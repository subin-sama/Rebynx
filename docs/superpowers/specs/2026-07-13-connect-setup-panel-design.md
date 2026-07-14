# Design: Setup tab + live connection status (Reactotron-style)

**Date:** 2026-07-13
**Status:** Approved

## Problem

Opening Rebynx (browser or desktop app) gives no hint of how to point a React
Native app at it, and no signal that an app has actually connected. Add a
**Setup** landing tab with copyable install steps + the `ws://<LAN-IP>:<port>` to
dial, and a **live connection indicator** ("waiting for your app…" → "app
connected ✓"), like Reactotron.

Lives in the shared browser client, so both the browser and the desktop app get
it.

## Relay — `packages/server/src/server.ts`

- `lanIp()` — first non-internal IPv4 from `os.networkInterfaces()`, else
  `localhost`. (The desktop already has an identical helper; the relay needs its
  own so it stays dependency-free.)
- **`GET /info`** → `{ lanIp, apps }`. The port isn't included — the client
  derives it from `location.port` (the port it was served on is the port a device
  dials).
- **Presence broadcast**: a `broadcastPresence()` that sends every browser
  `{ kind: 'presence', apps: apps.size }`. Called when an app connects
  (`hello.role === 'app'`) and on every socket `close` (covers app disconnects).
  On a browser `hello`, send that browser the current presence immediately (after
  the ring replay) so it's correct on load without waiting for a change.
- Add `{ kind: 'presence'; apps: number }` to `WireMessage` in `core/types.ts`.

## Client — `packages/server/public/app.js` + `index.html`

- **State**: `appsConnected` (number), `info` (`{ lanIp }`). Default `active` tab
  is **`setup`**.
- On `start()`: `fetch('/info')` → set `info.lanIp` + `appsConnected`, render.
- WS `onmessage`: handle `{ kind: 'presence', apps }` → update `appsConnected` +
  refresh the header pill and (if visible) the Setup banner.
- **Header**: an app-status pill next to the existing relay dot —
  `○ waiting for app` (muted/yellow) → `● app connected` / `● N apps` (green).
  (The existing dot stays: it's the browser↔relay link; the pill is app↔relay.)
- **Setup tab** (special, like Flows — not event-driven):
  - Status banner: `Waiting for your app to connect…` vs `✓ N app(s) connected`.
  - **Connect URL** `ws://<lanIp>:<port>` with a Copy button.
  - **Install steps**, each a copyable code block:
    - `npm i -D @rebynx/rn`
    - `initDevTools({ url: 'ws://<lanIp>:<port>' })` + render `<DevToolsOverlay/>`
      (the real `lanIp`/`port` interpolated).
  - Emulator note: Android emulator → `ws://10.0.2.2:<port>`; physical device →
    the LAN IP. If `lanIp` is `localhost` (no LAN found), say so.
  - Reuses the existing copy-button pattern (`navigator.clipboard` of a `<pre>`'s
    text), so copies are clean.

## Error handling

- `/info` fetch fails → fall back to `lanIp = location.hostname`, `appsConnected
  = 0`; the Setup tab still renders with a best-effort URL.
- `presence` messages with a non-number `apps` are ignored.

## Testing

- **`server.test.ts`** (extend): `GET /info` returns `{ lanIp: <string>, apps: 0 }`;
  presence — open a `ws` client with `hello:app`, then a `ws` browser client, and
  assert the browser receives `{ kind: 'presence', apps: 1 }` (and `apps: 0` after
  the app socket closes).
- **Client**: drive the browser preview against a relay — Setup is the default
  tab, the URL/snippet show the relay's `lanIp`, Copy yields the raw text, and the
  header pill flips to "app connected" when a `presence` arrives (simulate by
  opening an app WS to the relay).

## Out of scope

Changing the port/URL from the UI or restarting the relay from the client
(passive-connect model only — the app dials in).
