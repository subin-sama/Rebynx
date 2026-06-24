export * from './types.js';
export * from './util.js';
export { Hub } from './hub.js';
export { MemorySink, WebSocketSink } from './sinks.js';
export {
  installConsole,
  installNetwork,
  createReduxMiddleware,
  trackZustand,
  trackStore,
  trackAsyncStorage,
  trackMMKV,
  trackJotai,
  trackMobX,
  getSource,
  sourceLabel,
} from './collectors.js';
export type { StoreAdapter, SourceInfo } from './collectors.js';

import type { DevEvent, Plugin } from './types.js';

/**
 * Default panels. Both the in-app overlay and the browser client render from
 * this list, so adding a tab is a one-liner here (or push to it at runtime).
 * This is the extensibility Flipper had and stock RN DevTools lacks.
 */
export const defaultPlugins: Plugin[] = [
  { id: 'logs', label: 'Logs', accepts: (e: DevEvent) => e.type === 'log' },
  { id: 'network', label: 'Network', accepts: (e: DevEvent) => e.type === 'network' },
  { id: 'state', label: 'State', accepts: (e: DevEvent) => e.type === 'state' },
  { id: 'inspect', label: 'Inspect', accepts: (e: DevEvent) => e.type === 'inspect' },
];
