/**
 * Shared event model. Everything that flows app -> sinks -> UI is a DevEvent.
 * These types are platform-agnostic on purpose: the same shapes are produced
 * in React Native and consumed in the browser client, so they MUST stay
 * JSON-serialisable (no class instances, no functions — run values through
 * `sanitize()` before they reach here).
 */

export type Millis = number;
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface Base {
  /** monotonic id assigned by the Hub */
  id: string;
  /** Date.now() at emit time */
  ts: Millis;
}

export interface LogEvent extends Base {
  type: 'log';
  level: LogLevel;
  /** pre-formatted single-line message for quick display */
  message: string;
  /** sanitised original args for expandable inspection */
  args: unknown[];
  /** "file:line" of the call site when resolvable */
  source?: string | null;
}

export interface NetworkEvent extends Base {
  type: 'network';
  /** correlates the 'start' and 'end' phases of one request */
  reqId: string;
  phase: 'start' | 'end';
  method?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  duration?: Millis;
  reqHeaders?: Record<string, string>;
  reqBody?: unknown;
  resHeaders?: Record<string, string>;
  resBody?: unknown;
  /** Raw Error.stack captured where the request was made (the relay symbolicates it). */
  stack?: string;
  /** "file:line" of the calling code — filled in by the relay via Metro. */
  source?: string | null;
  /** Name of the function that made the call — filled in by the relay. */
  callFn?: string;
}

export interface StateEvent extends Base {
  type: 'state';
  /** logical store name, e.g. "redux" | "cart" | "auth" */
  store: string;
  /** action type for redux-like stores */
  action?: string;
  /** sanitised payload / non-type fields of the dispatched action (redux) */
  payload?: unknown;
  /** sanitised full snapshot */
  state: unknown;
}

export interface InspectEvent extends Base {
  type: 'inspect';
  name?: string;
  /** "file:line" — powers jump-to-code */
  source?: string | null;
  fileName?: string;
  lineNumber?: number;
  props?: unknown;
  style?: unknown;
  /** component ancestry, leaf-last */
  hierarchy?: Array<{ name: string; source?: string | null }>;
}

export type DevEvent = LogEvent | NetworkEvent | StateEvent | InspectEvent;

/** What collectors hand to Hub.emit — id/ts are stamped by the Hub. */
export type Emittable =
  | Omit<LogEvent, 'id' | 'ts'>
  | Omit<NetworkEvent, 'id' | 'ts'>
  | Omit<StateEvent, 'id' | 'ts'>
  | Omit<InspectEvent, 'id' | 'ts'>;

/** Commands flow the other way: browser/overlay -> app. */
export interface DevCommand {
  type: 'clear' | 'inspect-at' | 'ping' | (string & {});
  payload?: unknown;
}

/** A destination for events. Add as many as you want; they run in parallel. */
export interface Sink {
  name: string;
  send(event: DevEvent): void;
  dispose?(): void;
}

/**
 * A panel definition. Both the in-app overlay and the browser client read the
 * same registry, so a new tab is added in one place. `accepts` decides which
 * events land in this panel.
 */
export interface Plugin {
  id: string;
  label: string;
  accepts: (e: DevEvent) => boolean;
}

/** Wire envelope used between app, relay and browser. */
export type WireMessage =
  | { kind: 'hello'; role: 'app' | 'browser' }
  | { kind: 'event'; event: DevEvent }
  | { kind: 'command'; command: DevCommand }
  | { kind: 'presence'; apps: number };
