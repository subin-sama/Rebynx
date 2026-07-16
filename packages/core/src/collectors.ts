import type { Hub } from './hub.js';
import type { LogLevel } from './types.js';
import { formatArg, sanitize, uid } from './util.js';

type Teardown = () => void;

/* ------------------------------------------------------------------ *
 * 1. CONSOLE
 * Wraps console.* so logs are captured while still printing normally.
 * ------------------------------------------------------------------ */
export function installConsole(hub: Hub): Teardown {
  const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
  const original: Partial<Record<LogLevel, (...a: unknown[]) => void>> = {};

  for (const level of levels) {
    original[level] = console[level] as (...a: unknown[]) => void;
    console[level] = ((...args: unknown[]) => {
      hub.emit({
        type: 'log',
        level,
        message: args.map(formatArg).join(' '),
        args: args.map((a) => sanitize(a)),
        source: null,
      });
      original[level]!(...args);
    }) as typeof console.log;
  }

  return () => {
    for (const level of levels) {
      if (original[level]) console[level] = original[level] as typeof console.log;
    }
  };
}

/* ------------------------------------------------------------------ *
 * 2. NETWORK
 * Patches XMLHttpRequest.prototype and fetch rather than RN's private
 * XHRInterceptor. RN and app stacks vary in whether fetch goes through XHR,
 * so covering both public APIs keeps the collector portable.
 * ------------------------------------------------------------------ */
interface XHRMeta {
  reqId: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  start: number;
  suppress?: boolean;
  stack?: string;
}

/**
 * The caller's stack at request time. Under Hermes these frames point at the
 * bundle, so the relay symbolicates them via Metro into a real file:line —
 * see packages/server/src/symbolicate.ts.
 */
function captureStack(): string | undefined {
  const s = new Error().stack;
  return typeof s === 'string' ? s : undefined;
}

let fetchDepth = 0;

function parseHeaders(raw?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function readResponse(xhr: XMLHttpRequest): unknown {
  try {
    const rt = xhr.responseType;
    if (rt === '' || rt === 'text') {
      const txt = xhr.responseText;
      try {
        return JSON.parse(txt);
      } catch {
        return txt && txt.length > 5000 ? txt.slice(0, 5000) + '…' : txt;
      }
    }
    return `[${rt} response]`;
  } catch {
    return undefined;
  }
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  try {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
  } catch {
    // Some RN test/runtime shims expose partial Headers implementations.
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key)] = String(value);
    return out;
  }

  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key] = String(value);
  }
  return out;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const inputHeaders = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  return { ...headersToObject(inputHeaders), ...headersToObject(init?.headers) };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
}

function requestBody(input: RequestInfo | URL, init?: RequestInit): unknown {
  if (init && 'body' in init) return init.body;
  return typeof Request !== 'undefined' && input instanceof Request ? '[Request body]' : undefined;
}

async function readFetchResponseBody(response: Response): Promise<unknown> {
  try {
    const contentType = response.headers?.get?.('content-type') ?? '';
    const clone = response.clone();
    if (contentType.includes('application/json')) {
      return await clone.json();
    }
    const text = await clone.text();
    return text && text.length > 5000 ? text.slice(0, 5000) + '…' : text;
  } catch {
    return undefined;
  }
}

export function installNetwork(hub: Hub): Teardown {
  const XHR: typeof XMLHttpRequest | undefined = (globalThis as any).XMLHttpRequest;
  const originalFetch: typeof fetch | undefined = (globalThis as any).fetch;

  const teardowns: Teardown[] = [];

  if (XHR) {
    const proto = XHR.prototype as any;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetHeader = proto.setRequestHeader;

    proto.open = function (method: string, url: string, ...rest: unknown[]) {
      (this as any).__dt = {
        reqId: uid('n'),
        method,
        url,
        reqHeaders: {},
        start: 0,
        suppress: fetchDepth > 0,
        // Captured here (not in send) so the frames still include the app code
        // that kicked the request off. The relay turns it into a file:line.
        stack: captureStack(),
      } as XHRMeta;
      return origOpen.call(this, method, url, ...rest);
    };

    proto.setRequestHeader = function (key: string, value: string) {
      const meta = (this as any).__dt as XHRMeta | undefined;
      if (meta) meta.reqHeaders[key] = value;
      return origSetHeader.call(this, key, value);
    };

    proto.send = function (body?: unknown) {
      const meta = (this as any).__dt as XHRMeta | undefined;
      if (meta && !meta.suppress) {
        meta.start = Date.now();
        hub.emit({
          type: 'network',
          phase: 'start',
          reqId: meta.reqId,
          method: meta.method,
          url: meta.url,
          reqHeaders: meta.reqHeaders,
          reqBody: sanitize(body),
          stack: meta.stack,
        });
        this.addEventListener('loadend', () => {
          hub.emit({
            type: 'network',
            phase: 'end',
            reqId: meta.reqId,
            method: meta.method,
            url: meta.url,
            status: this.status,
            ok: this.status >= 200 && this.status < 300,
            duration: Date.now() - meta.start,
            resHeaders: parseHeaders(this.getAllResponseHeaders?.()),
            resBody: sanitize(readResponse(this)),
          });
        });
      }
      return origSend.call(this, body as any);
    };

    teardowns.push(() => {
      proto.open = origOpen;
      proto.send = origSend;
      proto.setRequestHeader = origSetHeader;
    });
  }

  if (originalFetch) {
    (globalThis as any).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqId = uid('n');
      const method = requestMethod(input, init);
      const url = requestInputToUrl(input);
      const start = Date.now();
      hub.emit({
        type: 'network',
        phase: 'start',
        reqId,
        method,
        url,
        reqHeaders: requestHeaders(input, init),
        reqBody: sanitize(requestBody(input, init)),
      });

      try {
        fetchDepth += 1;
        let responsePromise: Promise<Response>;
        try {
          responsePromise = originalFetch(input as any, init as any);
        } finally {
          fetchDepth -= 1;
        }
        const response = await responsePromise;
        hub.emit({
          type: 'network',
          phase: 'end',
          reqId,
          method,
          url,
          status: response.status,
          ok: response.ok,
          duration: Date.now() - start,
          resHeaders: headersToObject(response.headers),
          resBody: sanitize(await readFetchResponseBody(response)),
        });
        return response;
      } catch (error) {
        hub.emit({
          type: 'network',
          phase: 'end',
          reqId,
          method,
          url,
          ok: false,
          duration: Date.now() - start,
          resBody: sanitize(error),
        });
        throw error;
      }
    }) as typeof fetch;

    teardowns.push(() => {
      (globalThis as any).fetch = originalFetch;
    });
  }

  return () => {
    for (const teardown of teardowns.reverse()) teardown();
  };
}

/* ------------------------------------------------------------------ *
 * 3. STATE
 * Adapters are tiny: anything that can give a snapshot + notify on
 * change can be tracked. Ships with redux + zustand helpers; add your
 * own (MobX, Jotai, MMKV…) the same way.
 * ------------------------------------------------------------------ */

/** Redux/RTK: add this to your middleware chain. */
export const createReduxMiddleware =
  (hub: Hub, name = 'redux') =>
  (store: { getState: () => unknown }) =>
  (next: (action: unknown) => unknown) =>
  (action: unknown) => {
    const result = next(action);
    // Capture what was dispatched, not just its type: the FSA `payload` when
    // that's the only non-type field, else the whole action minus `type` (covers
    // thunk-ish actions that spread args at the top level). Omit for bare actions.
    const act = action && typeof action === 'object' ? (action as Record<string, unknown>) : null;
    let payload: unknown;
    if (act) {
      const keys = Object.keys(act).filter((k) => k !== 'type');
      if (keys.length === 1 && keys[0] === 'payload') payload = sanitize(act.payload);
      else if (keys.length) {
        const rest: Record<string, unknown> = {};
        for (const k of keys) rest[k] = act[k];
        payload = sanitize(rest);
      }
    }
    hub.emit({
      type: 'state',
      store: name,
      action: act?.type as string | undefined,
      payload,
      state: sanitize(store.getState()),
    });
    return result;
  };

/** Zustand: pass the store (the hook itself works — it has getState/subscribe). */
export function trackZustand(
  hub: Hub,
  store: { getState: () => unknown; subscribe: (cb: (s: unknown) => void) => () => void },
  name = 'zustand',
): Teardown {
  hub.emit({ type: 'state', store: name, state: sanitize(store.getState()) });
  return store.subscribe((state) => {
    hub.emit({ type: 'state', store: name, state: sanitize(state) });
  });
}

export interface StoreAdapter {
  name: string;
  getState: () => unknown;
  subscribe: (cb: () => void) => () => void;
}
export function trackStore(hub: Hub, adapter: StoreAdapter): Teardown {
  hub.emit({ type: 'state', store: adapter.name, state: sanitize(adapter.getState()) });
  return adapter.subscribe(() => {
    hub.emit({ type: 'state', store: adapter.name, state: sanitize(adapter.getState()) });
  });
}

/** AsyncStorage: patch AsyncStorage to track storage changes. */
export function trackAsyncStorage(
  hub: Hub,
  asyncStorage: any,
  name = 'async-storage',
): Teardown {
  if (!asyncStorage) return () => {};
  const origSetItem = asyncStorage.setItem;
  const origRemoveItem = asyncStorage.removeItem;
  const origClear = asyncStorage.clear;
  const origMultiSet = asyncStorage.multiSet;
  const origMultiRemove = asyncStorage.multiRemove;

  const emitState = async () => {
    try {
      const keys = await asyncStorage.getAllKeys();
      const pairs = await asyncStorage.multiGet(keys);
      const state: Record<string, unknown> = {};
      for (const [k, v] of pairs) {
        try {
          state[k] = JSON.parse(v);
        } catch {
          state[k] = v;
        }
      }
      hub.emit({ type: 'state', store: name, state: sanitize(state) });
    } catch {
      // ignore
    }
  };

  emitState();

  asyncStorage.setItem = async function (key: string, value: string, ...args: any[]) {
    const res = await origSetItem.call(this, key, value, ...args);
    emitState();
    return res;
  };

  asyncStorage.removeItem = async function (key: string, ...args: any[]) {
    const res = await origRemoveItem.call(this, key, ...args);
    emitState();
    return res;
  };

  asyncStorage.clear = async function (...args: any[]) {
    const res = await origClear.call(this, ...args);
    emitState();
    return res;
  };

  if (origMultiSet) {
    asyncStorage.multiSet = async function (kvPairs: [string, string][], ...args: any[]) {
      const res = await origMultiSet.call(this, kvPairs, ...args);
      emitState();
      return res;
    };
  }

  if (origMultiRemove) {
    asyncStorage.multiRemove = async function (keys: string[], ...args: any[]) {
      const res = await origMultiRemove.call(this, keys, ...args);
      emitState();
      return res;
    };
  }

  return () => {
    asyncStorage.setItem = origSetItem;
    asyncStorage.removeItem = origRemoveItem;
    asyncStorage.clear = origClear;
    if (origMultiSet) asyncStorage.multiSet = origMultiSet;
    if (origMultiRemove) asyncStorage.multiRemove = origMultiRemove;
  };
}

/** MMKV: listen to react-native-mmkv storage changes. */
export function trackMMKV(
  hub: Hub,
  storage: any,
  name = 'mmkv',
): Teardown {
  if (!storage) return () => {};

  const emitState = () => {
    try {
      const state: Record<string, unknown> = {};
      for (const key of storage.getAllKeys()) {
        let val: any = storage.getString(key);
        if (val === undefined) {
          val = storage.getNumber(key);
          if (val === undefined || Number.isNaN(val)) {
            val = storage.getBoolean(key);
          }
        } else {
          try {
            val = JSON.parse(val);
          } catch {
            // keep as string
          }
        }
        state[key] = val;
      }
      hub.emit({ type: 'state', store: name, state: sanitize(state) });
    } catch {
      // ignore
    }
  };

  emitState();

  const subscription = storage.addOnValueChangedListener(() => {
    emitState();
  });

  return () => {
    if (subscription && typeof subscription.remove === 'function') {
      subscription.remove();
    } else if (typeof subscription === 'function') {
      subscription();
    }
  };
}

/** Jotai: track jotai atom changes. */
export function trackJotai(
  hub: Hub,
  store: any,
  atoms: Record<string, any>,
  name = 'jotai',
): Teardown {
  if (!store || !atoms) return () => {};

  const emitState = () => {
    try {
      const state: Record<string, unknown> = {};
      for (const [key, atom] of Object.entries(atoms)) {
        state[key] = store.get(atom);
      }
      hub.emit({ type: 'state', store: name, state: sanitize(state) });
    } catch {
      // ignore
    }
  };

  emitState();

  const unsubs = Object.values(atoms).map((atom) => {
    return store.sub(atom, () => {
      emitState();
    });
  });

  return () => {
    for (const unsub of unsubs) unsub();
  };
}

/** MobX: track mobx observable changes. */
export function trackMobX(
  hub: Hub,
  observableState: any,
  toJSFn: (val: any) => any,
  autorunFn: (cb: () => void) => () => void,
  name = 'mobx',
): Teardown {
  if (!observableState || !toJSFn || !autorunFn) return () => {};

  const dispose = autorunFn(() => {
    try {
      const state = toJSFn(observableState);
      hub.emit({ type: 'state', store: name, state: sanitize(state) });
    } catch {
      // ignore
    }
  });

  return dispose;
}


/* ------------------------------------------------------------------ *
 * 4. SOURCE RESOLVER (style + file path)
 * In dev builds, Babel's jsx-source transform stamps every element
 * with __source = { fileName, lineNumber }. That's the "file:line"
 * that powers jump-to-code. The tap-to-inspect side (which needs RN's
 * UIManager) lives in the `rn` package; this helper stays portable.
 * ------------------------------------------------------------------ */
export interface SourceInfo {
  fileName: string;
  lineNumber: number;
}

export function getSource(node: any): SourceInfo | null {
  const s = node?._source ?? node?._debugSource ?? node?.__source;
  if (s && typeof s.fileName === 'string') {
    return { fileName: s.fileName, lineNumber: s.lineNumber ?? 0 };
  }
  return null;
}

export function sourceLabel(info: SourceInfo | null): string | null {
  return info ? `${info.fileName}:${info.lineNumber}` : null;
}
