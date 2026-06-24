import {
  Hub,
  MemorySink,
  WebSocketSink,
  installConsole,
  installNetwork,
  trackZustand,
  type DevCommand,
} from '@rebynx/core';

declare const __DEV__: boolean;

export interface InitOptions {
  /** Relay URL for the browser client, e.g. "ws://192.168.1.10:9090".
   *  Omit to run overlay-only. */
  url?: string;
  /** Keep the in-app overlay sink active (default true). */
  inApp?: boolean;
  /** Zustand store(s) to track: { name: store }. */
  zustand?: Record<string, { getState: () => unknown; subscribe: (cb: (s: unknown) => void) => () => void }>;
  /** Ring buffer size kept in-app. */
  bufferSize?: number;
  /** Handle commands sent from the browser (e.g. trigger native inspect). */
  onCommand?: (cmd: DevCommand) => void;
}

/** Shared singletons so the Overlay component and your app see the same hub. */
export const hub = new Hub();
export const memorySink = new MemorySink();

let started = false;

/**
 * Call once, early (before stores/network ideally). No-ops in production.
 *
 * For Redux, this can't auto-wire — add the middleware at store creation:
 *   import { createReduxMiddleware } from '@rebynx/core';
 *   import { hub } from '@rebynx/rn';
 *   const store = configureStore({ middleware: (g) => g().concat(createReduxMiddleware(hub)) });
 */
export function initDevTools(options: InitOptions = {}): void {
  if (!__DEV__ || started) return;
  started = true;

  const { url, inApp = true, zustand, bufferSize, onCommand } = options;

  // re-create hub with custom buffer size if requested
  if (bufferSize) (hub as any).buffer?.clear?.();

  const handleCommand = (cmd: DevCommand) => {
    if (cmd.type === 'clear') {
      hub.clear();
    }
    memorySink.onCommand(cmd);
    onCommand?.(cmd);
  };

  if (inApp) hub.addSink(memorySink);
  if (url) hub.addSink(new WebSocketSink(url, handleCommand));

  installConsole(hub);
  installNetwork(hub);

  if (zustand) {
    for (const [name, store] of Object.entries(zustand)) trackZustand(hub, store, name);
  }
}

export { hub as devtoolsHub };
export { DevToolsOverlay } from './Overlay';
