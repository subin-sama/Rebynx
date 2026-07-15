# CLAUDE.md — Rebynx

Hybrid React Native devtools. One platform-agnostic engine feeds **two front-ends
at the same time**: an in-app floating overlay and a browser client. Built to
cover the gaps in stock React Native DevTools (no state inspection, no
jump-to-code, no plugin system, logs lost on reload, separate-window friction).

## Architecture

```
Collectors ─► Hub (ring buffer + fan-out) ─► Sinks ┬─ MemorySink  ─► in-app overlay (RN)
                                                    └─ WebSocketSink ─► relay ─► browser client
```

- **`packages/core`** — pure TypeScript, zero platform deps. The crown jewel.
  - `hub.ts` — stamps id/ts, keeps a bounded history, fans events to all sinks.
  - `collectors.ts` — console patch, **XHR-prototype** network hook (works on RN
    *and* browser; deliberately NOT RN's private `XHRInterceptor`), redux/zustand
    adapters, and `getSource()` (reads Babel `__source` → `file:line`).
  - `sinks.ts` — `MemorySink` (in-app) + `WebSocketSink` (auto-reconnect + queue).
  - `index.ts` — barrel + `defaultPlugins` (the tab registry; both UIs read it).
- **`packages/server`** — Node relay. Broadcasts app→browser, **replays the ring
  buffer to a browser on connect** (fixes lost-logs-on-reload), forwards commands
  browser→app, and exposes `GET /open?file=&line=` for jump-to-code. Serves the
  browser client from `public/` (no build): `index.html` (markup + styles) loads
  `app.js` as an ES module — `createApp(doc)` has zero import side effects so
  `app.test.js` can drive it under happy-dom. The client renders **incrementally**
  (append/patch one row per event) rather than rebuilding `#main`, so an open
  `<details>` payload or a text selection survives the next incoming event; JSON
  panels are syntax-highlighted and copyable (`<pre>` text is the raw JSON). The
  default **Setup** tab shows copy-paste connect steps + the `ws://<LAN-IP>:9090`
  to dial and a Reactotron-style live status (`GET /info` gives the LAN address;
  the relay broadcasts `{ kind: 'presence', apps }` to browsers so "waiting for
  app" flips to "app connected").
  - `server.ts` — `createRelayServer({ flowsDir?, publicDir? })` builds the
    configured http.Server (routes + WebSocket relay) but **does not listen**, so
    `server.test.ts` can boot it on an ephemeral port. `index.ts` is the thin
    entrypoint that just `listen()`s (kept side-effecting so `bin/cli.mjs`'s
    `import('../dist/index.js')` still auto-starts).
  - `flows.ts` — **save-network-as-flow** storage: snapshot the current Network
    tab and persist it as `flows/<id>.json` (url + request + response per call, in
    order). REST: `GET/POST /flows`, `GET/DELETE /flows/:id`. `slugify`/`safeId`
    keep ids to `[a-z0-9-]` (no path traversal). Dir overridable via
    `DEVTOOLS_FLOWS_DIR`. `updateCall()` edits a saved call's payload/response
    body/status in place (`PATCH /flows/:id/calls/:seq`), so a captured response
    can be reshaped into the mock scenario you want — the Flows detail view has a
    per-call **Edit** (JSON textareas + status), and a running mock rebuilds its
    routes on edit. Format is designed to also feed future replay + mock.
    The Flows tab has an **Export** button per flow (downloads the flow JSON via a
    Blob), so a flow can be imported into `api-ui-mapper` as mock overrides.
  - `mock.ts` — **replay saved flows as a live API**. `createMockServer(getRoutes)`
    is a second `http.Server` (port 9091, `DEVTOOLS_MOCK_PORT`) run in-process by
    the relay; it answers requests matched by **method + path** (query/host
    stripped), sequence-replaying repeated calls and clamping on the last. The
    relay composes the route map from a registry of **enabled whole-flows +
    individual calls** (deduped by `flowId#seq`, sequence merge) and starts/stops
    the mock server as the registry changes. Control: `GET/DELETE /mock`,
    `POST/DELETE /mock/flow/:id`, `POST/DELETE /mock/call/:flowId/:seq`. The Flows
    tab toggles sources (per-flow in the list, per-call in the detail) and shows
    the mock base URL to point an app's baseURL at. Adds permissive CORS; unmatched
    request → 404 JSON.
- **`packages/rn`** — `initDevTools()` wiring + `<DevToolsOverlay/>` (draggable
  bubble → tabbed mini panel). Reads from `memorySink`.
- **`packages/desktop`** — Electron wrapper so there's nothing to run by hand.
  `main.mjs` starts the relay in Electron's Node main via `createRelayServer()`
  from `@rebynx/server/server` (or reuses one already on `:9090` — see
  `lib/net-util.mjs` `portInUse`), then `loadURL('http://localhost:9090')` so the
  existing client works unchanged. `npm run app` launches it; `scripts/make-launcher.mjs`
  (`npm run app:launcher`) writes a lightweight double-click `Rebynx.app`;
  `npm run app:dist` builds a self-contained bundle via electron-builder.

## How each RN DevTools pain is addressed

| Pain | Where it's solved |
| --- | --- |
| No state inspection | `collectors.ts` adapters → `state` events |
| No jump-to-code | `getSource()` → `file:line` on events → browser link → `GET /open` → `code -g` |
| No plugin system | `defaultPlugins` registry in `core/index.ts` + mirror in client; add a tab in one place |
| Logs vanish on reload | server ring buffer replay on browser `hello` |
| Separate-window friction | in-app overlay (MemorySink) runs alongside the browser |
| Hermes-only | we hook the JS layer, not the Hermes debugger → works on JSC too |
| Native debugging | **not solved** — anything below the JS bridge still needs Xcode/Android Studio |

## Run, Test & Link Locally

```bash
npm install
npm run build            # compile the packages (core + server)
npm run server           # start relay server (http://localhost:9090)
npm test                 # run vitest test suite
npm run typecheck        # run typescript compiler checks
```

For testing in local React Native apps (solves Metro symlink issues):
```bash
npm install -g yalc
npm run build
(cd packages/core && yalc publish)
(cd packages/rn && yalc publish)
# Then run `yalc add @rebynx/rn` in your target React Native app
```

In your RN app:

```ts
import { initDevTools, DevToolsOverlay, devtoolsHub } from '@rebynx/rn';
import { createReduxMiddleware } from '@rebynx/core';

initDevTools({
  url: 'ws://YOUR_MACHINE_LAN_IP:9090', // omit for overlay-only
  zustand: { cart: useCartStore },       // optional
  // optional redaction (extends the built-in secret list; allowKeys are exempt):
  redact: { redactKeys: ['deviceId'], allowKeys: ['passwordPolicy'] },
});
// Redux is wired at store creation:
//   middleware: (getDefault) => getDefault().concat(createReduxMiddleware(devtoolsHub))

// render once at the root, above your navigator:
<DevToolsOverlay />
```

Use the LAN IP (not `localhost`) so a physical device can reach the relay.

## TODO / good next tasks for Claude Code

1. **Tap-to-inspect (native)** — in `Overlay.tsx`, add a full-screen transparent
   capture layer; on tap call RN's `getInspectorDataForViewAtPoint(...)` (guard the
   import — it moves across RN versions / Fabric vs Paper) and emit an `inspect`
   event with `props`, `style`, `hierarchy`, and `source`.
2. **More state adapters** — MMKV, AsyncStorage, Jotai, MobX. Same shape as
   `trackZustand`. Surface storage as a `state` store.
3. **Richer browser client** — current `public/index.html` is vanilla for
   zero-build simplicity. Optionally replace with a Vite + React app (add a
   `packages/web`) for JSON tree view, search per-field, request timing waterfall.
4. **Plugin packages** — formalise `Plugin` so third-party tabs (e.g. React Query
   devtools) can register a renderer for both UIs, not just a filter.
5. **Command round-trip** — wire `onCommand` in `initDevTools` so the browser's
   Clear and a future "trigger inspect" actually drive the app.
6. **Redaction** — DONE: `sanitize()` has a built-in secret deny list plus
   `allowKeys` exceptions, configurable process-wide via `configureRedaction()`
   / `initDevTools({ redact })`.

## Conventions

- Everything crossing a sink MUST be JSON-safe → run values through `sanitize()`.
- Collectors only ever call `hub.emit()`. They never know about transports.
- Keep `core` free of `react-native` and `node` imports so it stays portable.
- All of this is dev-only: gate entry points behind `__DEV__`.
