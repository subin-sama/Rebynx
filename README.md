# Rebynx

> Hybrid devtools for React Native — an in-app overlay **and** a browser client, from one engine.

Rebynx closes the gaps in the official React Native DevTools: it inspects your
**store** (Redux / Zustand / anything), gives you **jump-to-code**, ships a real
**plugin** model, and runs **in the app and in the browser at the same time** —
no separate-window dance, and logs survive a reload.

```
collectors ──▶ Hub (ring buffer) ──fan-out──▶ sinks ┬─ MemorySink   ─▶ in-app overlay (no server needed)
 logs / network                                      └─ WebSocketSink ─▶ relay ─▶ browser client
        ▲                                                                            │
        └───────────────────────── commands ◀─────────────────────────────────────────┘
```

Every UI is just a **sink** of the same event stream. The overlay subscribes to
the hub directly; the browser gets the same events over a WebSocket relay. Both
can be attached at once — that's the hybrid part.

## Install

In your React Native app:

```bash
npm i -D @rebynx/rn        # in-app overlay + bridge (pulls in @rebynx/core)
```

```ts
// index.js — top of your entry file
import { initDevTools } from '@rebynx/rn';

if (__DEV__) {
  initDevTools({
    url: 'ws://YOUR_LAN_IP:9090', // omit url for overlay-only
    redactKeys: ['auth', 'token', 'secret'], // optional custom sensitive fields to redact
  });
}
```

```tsx
// App root
import { DevToolsOverlay } from '@rebynx/rn';

export default function App() {
  return (
    <>
      <YourApp />
      {__DEV__ && <DevToolsOverlay />}
    </>
  );
}
```

Track your stores & storage (native helpers built-in):

```ts
import { devtoolsHub as hub } from '@rebynx/rn';
import {
  createReduxMiddleware,
  trackZustand,
  trackAsyncStorage,
  trackMMKV,
  trackJotai,
  trackMobX,
  trackStore
} from '@rebynx/core';

// 1. Zustand
trackZustand(hub, useBearStore, 'bear');

// 2. Redux / RTK
configureStore({ middleware: (g) => g().concat(createReduxMiddleware(hub)) });

// 3. AsyncStorage
import AsyncStorage from '@react-native-async-storage/async-storage';
trackAsyncStorage(hub, AsyncStorage, 'async-storage');

// 4. MMKV
import { storage } from './mmkv'; // MMKV instance
trackMMKV(hub, storage, 'mmkv');

// 5. Jotai
import { getDefaultStore } from 'jotai';
trackJotai(hub, getDefaultStore(), { count: countAtom, user: userAtom }, 'jotai');

// 6. MobX
import { toJS, autorun } from 'mobx';
trackMobX(hub, myObservableState, toJS, autorun, 'mobx');

// 7. Generic Store Adapter
trackStore(hub, { name: 'cart', getState: () => cart.value, subscribe: cart.onChange });
```

## Run the browser client

```bash
npx @rebynx/server
# ▸ browser client : http://localhost:9090
# ▸ app connects to: ws://<your-machine-ip>:9090
```

Open http://localhost:9090. Click a **source link** in the inspect tab and the
file opens in your editor (jump-to-code). Configurable port via `DEVTOOLS_PORT`.

> **Android emulator** can't reach `localhost` — use `ws://10.0.2.2:9090`.
> **Physical device** — use your machine's LAN IP.

## Save a network flow

Drive a user flow on the emulator, then snapshot every API call it made — URL,
request and response — as a reusable **flow** saved on the relay.

1. In the browser client, hit **Clear** to start from a clean slate.
2. Play the flow in your app; requests stream into the **Network** tab.
3. Click **Save flow** and name it. The relay writes
   `packages/server/flows/<name>.json`.
4. Open the **Flows** tab to browse saved flows and expand each call's
   request/response.

The relay exposes flows as a small REST API:

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/flows` | list saved flows |
| `POST` | `/flows` | save `{ name, notes?, calls }` |
| `GET` | `/flows/:id` | fetch one flow |
| `DELETE` | `/flows/:id` | delete one |

Storage dir is overridable via `DEVTOOLS_FLOWS_DIR`. The saved format
(`{ method, url, request, response }` per call, in order) is built to also drive
future **replay** and **mock** modes.

## What it fixes vs the official RN DevTools

| Pain | Rebynx |
| --- | --- |
| Can't inspect Redux / Zustand / MobX store | `state` collector, adapter-based |
| No plugin system | every panel is registered in one place; add your own |
| No jump-to-code | source link in the browser → relay opens your editor |
| Component tree too deep to use | inspect returns just the tapped element + flattened style |
| Network panel was Expo-only / unstable | `XMLHttpRequest.prototype` hook — catches fetch + axios, works in the browser too |
| Separate window only | runs **in-app** as well, on-device, no server |
| Logs vanish on reload | relay replays its ring buffer to the browser on connect |
| No record of what APIs a flow calls | **Save flow** snapshots the Network tab to a reusable JSON file (URL + request + response) |

## Packages

| Package | What |
| --- | --- |
| `@rebynx/core` | platform-agnostic engine: collectors, hub, sinks (zero deps) |
| `@rebynx/rn` | React Native client: `initDevTools()` + `<DevToolsOverlay/>` |
| `@rebynx/server` | Node relay + browser client + jump-to-code endpoint |

## Local Development & Testing

### 1. Build and Run Server Locally
To build the packages and start the WebSocket relay server in this repository:
```bash
# Install dependencies
npm install

# Compile the packages (core and server)
npm run build

# Start the WebSocket relay server (defaults to port 9090)
npm run server

# …or watch mode — auto-restarts on source changes (recommended while hacking
# on the server, so a rebuilt route like /flows is picked up without a manual restart)
npm run server:dev
```

### 2. Run Unit Tests
To run the Vitest test suite:
```bash
npm test
```

### 3. Install into another React Native app locally
For local app testing without publishing to npm, use the installer. It builds
`@rebynx/core`, copies `@rebynx/core` and `@rebynx/rn` into the target app, fixes
the copied RN package dependency to point at the copied core package, and updates
the app's `package.json` with local `file:` dependencies.

```bash
npm run install:rn-app -- /path/to/your-react-native-app
cd /path/to/your-react-native-app
npm install # or yarn install, depending on the app
```

For the Aeoon app in this workspace:

```bash
npm run install:rn-app -- /Users/winner/work/aeoon-mobile-react-native
cd /Users/winner/work/aeoon-mobile-react-native
yarn install
```

Then add the normal app wiring if it is not already present:

```ts
import { initDevTools, DevToolsOverlay } from '@rebynx/rn';

if (__DEV__) {
  initDevTools({
    url: 'ws://10.0.2.2:9090', // Android emulator; use LAN IP for device/iOS
  });
}
```

```tsx
{__DEV__ ? <DevToolsOverlay /> : null}
```

Start the relay from this repo when you want the browser client:

```bash
npm run server
```

#### Alternative: yalc
Because React Native's Metro packager has known issues resolving symbolic links
(from `npm link`), `yalc` is another good way to test local
modifications:

#### A. Install yalc globally:
```bash
npm install -g yalc
```

#### B. Publish your local packages to the yalc registry:
Whenever you make changes to the codebase and build, run the following:
```bash
# Build the latest code
npm run build

# Publish package core and rn
cd packages/core && yalc publish
cd ../rn && yalc publish
```

#### C. Consume the package in your React Native app:
Navigate to your test React Native application and run:
```bash
# Add the local dependency
yalc add @rebynx/rn

# Install the dependencies
npm install   # or yarn install
```

If you modify Rebynx code again later, simply rebuild and run `yalc push` in the Rebynx package directories to automatically push changes to your application.


## Caveats (honest ones)

- The network hook and tap-to-inspect lean on RN internals
  (`XMLHttpRequest`, `UIManager`). Widely used and stable in practice, but they
  can shift between RN versions — the code degrades instead of crashing.
- Source locations (`__source`) exist only in **dev** builds, which is why
  everything is gated behind `__DEV__`.
- This debugs the React/JS layer, not the native layer — for native modules use
  Xcode / Android Studio.

## License

MIT © Bynx
