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

## Packages

| Package | What |
| --- | --- |
| `@rebynx/core` | platform-agnostic engine: collectors, hub, sinks (zero deps) |
| `@rebynx/rn` | React Native client: `initDevTools()` + `<DevToolsOverlay/>` |
| `@rebynx/server` | Node relay + browser client + jump-to-code endpoint |

## Develop

```bash
pnpm install
pnpm build:core      # compile the engine
pnpm server          # start the relay (http://localhost:9090)
```

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
