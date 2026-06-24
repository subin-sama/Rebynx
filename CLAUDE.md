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
  browser client from `public/index.html` (single self-contained file, no build).
- **`packages/rn`** — `initDevTools()` wiring + `<DevToolsOverlay/>` (draggable
  bubble → tabbed mini panel). Reads from `memorySink`.

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

## Run it

```bash
pnpm install
pnpm build:core          # compile the engine
pnpm server              # http://localhost:9090  (browser client + relay)
```

In your RN app:

```ts
import { initDevTools, DevToolsOverlay, devtoolsHub } from '@rebynx/rn';
import { createReduxMiddleware } from '@rebynx/core';

initDevTools({
  url: 'ws://YOUR_MACHINE_LAN_IP:9090', // omit for overlay-only
  zustand: { cart: useCartStore },       // optional
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
6. **Redaction** — add an allow/deny list in `sanitize()` for auth headers/tokens
   before anything leaves the device.

## Conventions

- Everything crossing a sink MUST be JSON-safe → run values through `sanitize()`.
- Collectors only ever call `hub.emit()`. They never know about transports.
- Keep `core` free of `react-native` and `node` imports so it stays portable.
- All of this is dev-only: gate entry points behind `__DEV__`.
