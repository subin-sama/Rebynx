import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hub } from './hub.js';
import {
  installConsole,
  installNetwork,
  createReduxMiddleware,
  trackZustand,
  trackStore,
  trackAsyncStorage,
  trackMMKV,
  trackJotai,
  trackMobX,
} from './collectors.js';

describe('collectors', () => {
  let hub: Hub;
  let emittedEvents: any[];

  beforeEach(() => {
    hub = new Hub();
    emittedEvents = [];
    hub.addSink({
      name: 'test',
      send: (e) => emittedEvents.push(e),
    });
  });

  describe('installConsole', () => {
    let originalLog: typeof console.log;

    beforeEach(() => {
      originalLog = console.log;
    });

    afterEach(() => {
      console.log = originalLog;
    });

    it('should patch console.log and capture log event', () => {
      const mockOriginal = vi.fn();
      console.log = mockOriginal; // Mock original first

      const uninstall = installConsole(hub);

      console.log('hello world', { a: 1 });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('log');
      expect(emittedEvents[0].level).toBe('log');
      expect(emittedEvents[0].message).toBe('hello world {"a":1}');
      expect(emittedEvents[0].args).toBeDefined();

      uninstall();
    });
  });

  describe('installNetwork', () => {
    const originalFetch = globalThis.fetch;
    const originalXHR = (globalThis as any).XMLHttpRequest;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      (globalThis as any).XMLHttpRequest = originalXHR;
    });

    it('should capture fetch requests', async () => {
      (globalThis as any).XMLHttpRequest = undefined;
      const response = new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-test': 'yes' },
      });
      globalThis.fetch = vi.fn(async () => response) as any;

      const uninstall = installNetwork(hub);

      const res = await fetch('https://example.test/items', {
        method: 'POST',
        headers: { 'x-client': 'test' },
        body: JSON.stringify({ name: 'Ada' }),
      });

      expect(res.status).toBe(201);
      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[0]).toMatchObject({
        type: 'network',
        phase: 'start',
        method: 'POST',
        url: 'https://example.test/items',
        reqHeaders: { 'x-client': 'test' },
        reqBody: JSON.stringify({ name: 'Ada' }),
      });
      expect(emittedEvents[1]).toMatchObject({
        type: 'network',
        phase: 'end',
        method: 'POST',
        url: 'https://example.test/items',
        status: 201,
        ok: true,
        resHeaders: { 'content-type': 'application/json', 'x-test': 'yes' },
        resBody: { ok: true },
      });

      uninstall();
    });

    it('should capture XHR requests', () => {
      globalThis.fetch = undefined as any;

      class MockXHR {
        static last: MockXHR;
        status = 204;
        responseType = '';
        responseText = '{"done":true}';
        private listeners: Record<string, () => void> = {};
        private rawHeaders = 'x-response: ok';

        constructor() {
          MockXHR.last = this;
        }

        open(_method: string, _url: string) {}
        send(_body?: unknown) {}
        setRequestHeader(_key: string, _value: string) {}
        addEventListener(event: string, listener: () => void) {
          this.listeners[event] = listener;
        }
        getAllResponseHeaders() {
          return this.rawHeaders;
        }
        finish() {
          this.listeners.loadend();
        }
      }

      (globalThis as any).XMLHttpRequest = MockXHR;
      const uninstall = installNetwork(hub);

      const xhr = new XMLHttpRequest();
      xhr.open('PUT', 'https://example.test/users/1');
      xhr.setRequestHeader('x-client', 'test');
      xhr.send(JSON.stringify({ name: 'Grace' }));
      MockXHR.last.finish();

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[0]).toMatchObject({
        type: 'network',
        phase: 'start',
        method: 'PUT',
        url: 'https://example.test/users/1',
        reqHeaders: { 'x-client': 'test' },
        reqBody: JSON.stringify({ name: 'Grace' }),
      });
      expect(emittedEvents[1]).toMatchObject({
        type: 'network',
        phase: 'end',
        method: 'PUT',
        url: 'https://example.test/users/1',
        status: 204,
        ok: true,
        resHeaders: { 'x-response': 'ok' },
        resBody: { done: true },
      });

      uninstall();
    });
  });

  describe('createReduxMiddleware', () => {
    it('should log action and dispatch changes to hub', () => {
      const state = { count: 0 };
      const store = {
        getState: () => state,
      };
      const middleware = createReduxMiddleware(hub, 'my-redux-store');

      const next = vi.fn((action) => {
        state.count = 1;
        return 'result';
      });

      const action = { type: 'INCREMENT' };
      const res = middleware(store)(next)(action);

      expect(res).toBe('result');
      expect(next).toHaveBeenCalledWith(action);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('state');
      expect(emittedEvents[0].store).toBe('my-redux-store');
      expect(emittedEvents[0].action).toBe('INCREMENT');
      expect(emittedEvents[0].state).toEqual({ count: 1 });
    });
  });

  describe('trackZustand', () => {
    it('should subscribe and emit updates', () => {
      let listener: any;
      const store = {
        getState: () => ({ name: 'initial' }),
        subscribe: (cb: any) => {
          listener = cb;
          return () => {};
        },
      };

      trackZustand(hub, store, 'my-zustand');

      // Initial state event
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].state).toEqual({ name: 'initial' });

      // Trigger change
      listener({ name: 'updated' });
      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[1].state).toEqual({ name: 'updated' });
    });
  });

  describe('trackAsyncStorage', () => {
    it('should patch AsyncStorage operations and emit state changes', async () => {
      const mockStorage = {
        data: new Map<string, string>(),
        getAllKeys: async function() {
          return Array.from(this.data.keys());
        },
        multiGet: async function(keys: string[]) {
          return keys.map(k => [k, this.data.get(k) || 'null']);
        },
        setItem: async function(key: string, value: string) {
          this.data.set(key, value);
        },
        removeItem: async function(key: string) {
          this.data.delete(key);
        },
        clear: async function() {
          this.data.clear();
        },
      };

      const uninstall = trackAsyncStorage(hub, mockStorage, 'async-store');

      // Initial get should be called (async, let's wait a tick)
      await new Promise(r => setTimeout(r, 0));
      expect(emittedEvents.length).toBeGreaterThanOrEqual(1);

      // Perform setItem
      await mockStorage.setItem('key1', JSON.stringify({ ok: true }));
      await new Promise(r => setTimeout(r, 0));

      const lastEvent = emittedEvents[emittedEvents.length - 1];
      expect(lastEvent.type).toBe('state');
      expect(lastEvent.store).toBe('async-store');
      expect(lastEvent.state).toEqual({ key1: { ok: true } });

      uninstall();
    });
  });

  describe('trackMMKV', () => {
    it('should subscribe to MMKV changes and emit', () => {
      let listener: any;
      const mockStorage = {
        data: new Map<string, any>([['key1', '{"ok":true}']]),
        getAllKeys: function() {
          return Array.from(this.data.keys());
        },
        getString: function(k: string) {
          return this.data.get(k);
        },
        getNumber: vi.fn(),
        getBoolean: vi.fn(),
        addOnValueChangedListener: (cb: any) => {
          listener = cb;
          return () => {};
        },
      };

      trackMMKV(hub, mockStorage, 'mmkv-store');

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].state).toEqual({ key1: { ok: true } });

      // Change data
      mockStorage.data.set('key1', '{"ok":false}');
      listener('key1');

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[1].state).toEqual({ key1: { ok: false } });
    });
  });

  describe('trackJotai', () => {
    it('should subscribe to Jotai atoms and emit changes', () => {
      const atom1 = { name: 'atom1' };
      const store = {
        get: (atom: any) => atom === atom1 ? 'val1' : null,
        sub: vi.fn((atom: any, cb: any) => {
          return () => {};
        }),
      };

      trackJotai(hub, store, { atom1 }, 'jotai-store');

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].state).toEqual({ atom1: 'val1' });
      expect(store.sub).toHaveBeenCalled();
    });
  });

  describe('trackMobX', () => {
    it('should subscribe using autorun and emit changes', () => {
      const state = { name: 'mobx-initial' };
      const toJS = (val: any) => ({ ...val });
      let reaction: any;
      const autorun = (cb: any) => {
        reaction = cb;
        cb();
        return () => {};
      };

      trackMobX(hub, state, toJS, autorun, 'mobx-store');

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].state).toEqual({ name: 'mobx-initial' });

      // Trigger change
      state.name = 'mobx-updated';
      reaction();

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[1].state).toEqual({ name: 'mobx-updated' });
    });
  });
});
