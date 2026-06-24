import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hub } from './hub.js';
import {
  installConsole,
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
