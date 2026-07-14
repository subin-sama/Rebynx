// @vitest-environment happy-dom
//
// Tests the browser client (public/app.js). Written in JS so it can import the
// static client module directly; tsc ignores .js, vitest runs it.
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp, syntaxHighlight, jsonBlock, STATE_SNIPPETS, MAX_EVENTS, diffState, jsonTree } from '../public/app.js';

function setupDom() {
  document.body.innerHTML =
    `<span id="app-status"></span><input id="filter" /><div id="tabs"></div><main id="main"></main><span id="flash"></span>`;
}

const netEvent = (n, extra = {}) => ({
  id: 'n' + n,
  ts: 1700000000000 + n,
  type: 'network',
  phase: 'end',
  reqId: 'r' + n,
  method: 'GET',
  url: 'https://api.test/step/' + n,
  status: 200,
  ok: true,
  duration: 10,
  reqHeaders: {},
  reqBody: null,
  resHeaders: { 'content-type': 'application/json' },
  resBody: { step: n },
  ...extra,
});

describe('syntaxHighlight', () => {
  test('wraps keys, strings, numbers, booleans and null in classed spans', () => {
    const html = syntaxHighlight({ a: 'x', n: 2, b: true, z: null });
    expect(html).toContain('<span class="j-key">"a":</span>');
    expect(html).toContain('<span class="j-str">"x"</span>');
    expect(html).toContain('<span class="j-num">2</span>');
    expect(html).toContain('<span class="j-bool">true</span>');
    expect(html).toContain('<span class="j-null">null</span>');
  });

  test('escapes angle brackets from string values (no HTML injection)', () => {
    const html = syntaxHighlight({ h: '<img src=x>' });
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('jsonBlock', () => {
  test('the <pre> text round-trips to the original JSON, so Copy yields clean JSON', () => {
    document.body.innerHTML = jsonBlock('Response', { a: 1, s: 'hi', arr: [1, 2] });
    const pre = document.querySelector('pre');
    expect(JSON.parse(pre.textContent)).toEqual({ a: 1, s: 'hi', arr: [1, 2] });
    expect(document.querySelector('.copy-btn')).toBeTruthy();
    expect(document.querySelector('.json-label').textContent).toBe('Response');
  });
});

describe('incremental rendering', () => {
  beforeEach(setupDom);

  // Regression for the reported bug: opening a payload then any event arriving
  // used to rebuild #main, collapsing the <details> and clearing the selection.
  test('an incoming event appends a row without collapsing an open <details>', () => {
    const app = createApp(document);
    app.setActive('network');
    app.ingest(netEvent(1));

    const firstRow = document.querySelector('#main .row');
    firstRow.querySelector('details').open = true; // user expands to read the response

    // a different event streams in (previously this clobbered the whole panel)
    app.ingest({ id: 's1', ts: 1700000000500, type: 'state', store: 'redux', action: 'X', state: { a: 1 } });
    app.ingest(netEvent(2));

    const rows = document.querySelectorAll('#main .row');
    expect(rows.length).toBe(2); // both network rows; the state event isn't in this tab
    expect(rows[0]).toBe(firstRow); // first row node was NOT rebuilt
    expect(rows[0].querySelector('details').open).toBe(true); // still open
  });

  test('a network row updates in place when its end phase arrives', () => {
    const app = createApp(document);
    app.setActive('network');
    app.ingest({ id: 'a', ts: 1700000000600, type: 'network', phase: 'start', reqId: 'r9', method: 'GET', url: 'https://api.test/pending' });
    expect(document.querySelectorAll('#main .row').length).toBe(1);

    app.ingest({ id: 'b', ts: 1700000000601, type: 'network', phase: 'end', reqId: 'r9', method: 'GET', url: 'https://api.test/pending', status: 200, ok: true, duration: 5, resBody: { done: true } });
    expect(document.querySelectorAll('#main .row').length).toBe(1); // same row, updated — not a duplicate
    expect(document.querySelector('#main .status').textContent).toContain('200');
  });

  test('events for other tabs update counts but do not touch the active panel', () => {
    const app = createApp(document);
    app.setActive('network');
    app.ingest(netEvent(1));
    const firstRow = document.querySelector('#main .row');

    app.ingest({ id: 'l1', ts: 1700000000700, type: 'log', level: 'info', message: 'hello', args: ['hello'] });

    expect(document.querySelectorAll('#main .row').length).toBe(1); // log not shown in network tab
    expect(document.querySelector('#main .row')).toBe(firstRow); // untouched
    // tab counts reflect both events
    expect(document.querySelector('.tab[data-tab="logs"] .count').textContent).toBe('1');
    expect(document.querySelector('.tab[data-tab="network"] .count').textContent).toBe('1');
  });
});

describe('setup / connection', () => {
  beforeEach(setupDom);

  test('lands on the Setup tab by default', () => {
    const app = createApp(document);
    expect(app.active).toBe('setup');
  });

  test('shows the connect URL and install steps with the LAN address', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '192.168.1.42', apps: 0 }); // sets info + renders (active is setup)

    const text = document.getElementById('main').textContent;
    expect(text).toContain('ws://192.168.1.42:'); // host = the relay's LAN address (port = location.port)
    expect(text).toContain('npm i -D @rebynx/rn');
    expect(text).toContain('initDevTools');

    // the URL block is copyable — its <pre> text is exactly the URL
    const pre = [...document.querySelectorAll('#main pre')].find((p) => p.textContent.startsWith('ws://'));
    expect(pre.textContent).toMatch(/^ws:\/\/192\.168\.1\.42:\d+$/);
  });

  test('presence flips the header pill and the setup banner to connected', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '10.0.0.5', apps: 0 });
    expect(document.getElementById('app-status').textContent).toContain('waiting');
    expect(document.getElementById('setup-banner').textContent).toContain('Waiting');

    app.handlePresence(2);
    expect(app.appsConnected).toBe(2);
    expect(document.getElementById('app-status').textContent).toContain('2 apps connected');
    expect(document.getElementById('app-status').className).toContain('on');
    expect(document.getElementById('setup-banner').textContent).toContain('2 app');
  });

  test('ignores a non-numeric presence value', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '10.0.0.5', apps: 1 });
    app.handlePresence('nope');
    expect(app.appsConnected).toBe(1);
  });
});

describe('state-manager snippets', () => {
  beforeEach(setupDom);

  test('covers every shipped adapter, each wired through the shared devtoolsHub', () => {
    const ids = STATE_SNIPPETS.map((s) => s.id);
    expect(ids).toEqual(['redux', 'zustand', 'mmkv', 'async', 'jotai', 'mobx', 'custom']);
    for (const s of STATE_SNIPPETS) {
      expect(s.code).toContain("devtoolsHub");
      expect(s.code).toContain("@rebynx/rn");
    }
    // each snippet references its adapter's API
    const by = (id) => STATE_SNIPPETS.find((s) => s.id === id).code;
    expect(by('redux')).toContain('createReduxMiddleware(devtoolsHub)');
    expect(by('zustand')).toContain('trackZustand(devtoolsHub');
    expect(by('mmkv')).toContain('trackMMKV(devtoolsHub');
    expect(by('async')).toContain('trackAsyncStorage(devtoolsHub');
    expect(by('jotai')).toContain('trackJotai(devtoolsHub');
    expect(by('mobx')).toContain('trackMobX(devtoolsHub');
    expect(by('custom')).toContain('trackStore(devtoolsHub');
  });

  test('Setup shows a picker for every adapter and the Redux snippet by default', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '10.0.0.5', apps: 0 });
    expect(app.stateAdapter).toBe('redux');
    const opts = [...document.querySelectorAll('#main .state-opt')].map((b) => b.dataset.adapter);
    expect(opts).toEqual(['redux', 'zustand', 'mmkv', 'async', 'jotai', 'mobx', 'custom']);
    expect(document.querySelector('#main .state-opt.active').dataset.adapter).toBe('redux');
    expect(document.getElementById('main').textContent).toContain('createReduxMiddleware(devtoolsHub)');
  });

  test('picking an adapter swaps the shown snippet', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '10.0.0.5', apps: 0 });

    app.selectStateAdapter('zustand');
    expect(app.stateAdapter).toBe('zustand');
    const text = document.getElementById('main').textContent;
    expect(text).toContain('trackZustand(devtoolsHub');
    expect(text).not.toContain('createReduxMiddleware');
    expect(document.querySelector('#main .state-opt.active').dataset.adapter).toBe('zustand');
  });

  test('ignores an unknown adapter id', () => {
    const app = createApp(document);
    app.handleInfo({ lanIp: '10.0.0.5', apps: 0 });
    app.selectStateAdapter('nope');
    expect(app.stateAdapter).toBe('redux');
  });
});

describe('Clear', () => {
  beforeEach(setupDom);

  // Regression: after Clear, a leftover filter used to keep hiding new logs, so
  // the tab looked permanently empty ("no logs after clear").
  test('resets the filter so new logs are shown after clearing', () => {
    const app = createApp(document);
    app.setActive('logs');
    app.setFilter('checkout');

    const log = (id, msg) => app.ingest({ id, ts: id, type: 'log', level: 'info', message: msg, args: [msg] });
    log(1, 'user tapped login'); // no "checkout" -> filtered out
    expect(document.querySelectorAll('#main .row').length).toBe(0);

    app.clearAll();
    expect(document.getElementById('filter').value).toBe(''); // input reset too

    log(2, 'user opened profile'); // no "checkout"
    expect(document.querySelectorAll('#main .row').length).toBe(1); // now visible
  });
});

describe('State — left/right split', () => {
  beforeEach(setupDom);

  const stateEvent = (id, store, action, state) => ({ id, ts: 1, type: 'state', store, action, state });
  const rightTree = () => JSON.parse(document.querySelector('#main .state-right pre').textContent);
  const treeLeaf = (path) => document.querySelector(`#main .state-right [data-path="${path}"] .jt-leafval`)?.textContent;

  test('renders a split (timeline left, tree right) with no Current/Timeline toggle', () => {
    const app = createApp(document);
    app.setActive('state');
    expect(document.querySelector('#main .state-split')).toBeTruthy();
    expect(document.querySelector('#main .state-left')).toBeTruthy();
    expect(document.querySelector('#main .state-right')).toBeTruthy();
    expect(document.querySelector('#main .state-view-opt')).toBeNull();
  });

  test('left lists a row per event; right defaults to the live current merged tree', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('a', 'redux', 'A', { count: 1 }));
    app.ingest(stateEvent('b', 'cart', 'ADD', { items: [1] }));
    expect(document.querySelectorAll('#main .state-left .state-item').length).toBe(2);
    // right = live current tree with both stores
    expect(document.querySelector('#main .state-right .jt-tree')).toBeTruthy();
    expect(treeLeaf('redux.count')).toBe('1');
    expect(document.querySelector('#main .state-right [data-path="cart.items"]')).toBeTruthy();
  });

  test('clicking an action shows that snapshot on the right; Live returns to current', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('a', 'redux', 'A', { count: 1 }));
    app.ingest(stateEvent('b', 'redux', 'B', { count: 2 })); // current = 2

    app.selectStateEvent('a'); // pick the older snapshot
    expect(rightTree()).toEqual({ count: 1 });
    expect(document.querySelector('#main .state-item.sel')).toBeTruthy();

    // a new event while an action is selected must NOT change the right pane
    app.ingest(stateEvent('c', 'redux', 'C', { count: 3 }));
    expect(rightTree()).toEqual({ count: 1 });

    app.goLiveState(); // back to the live current (latest)
    expect(treeLeaf('redux.count')).toBe('3');
  });

  test('Pause freezes the live current pane while events flow; Resume shows latest', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('a', 'redux', 'A', { count: 1 }));
    app.togglePause();
    expect(app.statePaused).toBe(true);
    app.ingest(stateEvent('b', 'redux', 'B', { count: 2 }));
    expect(treeLeaf('redux.count')).toBe('1'); // frozen
    app.togglePause();
    expect(treeLeaf('redux.count')).toBe('2');
  });

  test('clearAll empties both panes', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('a', 'redux', 'A', { count: 1 }));
    app.clearAll();
    expect(document.querySelectorAll('#main .state-left .state-item').length).toBe(0);
    expect(document.querySelector('#main .state-right pre')).toBeNull();
  });
});

describe('State — action diff', () => {
  beforeEach(setupDom);

  const stateEvent = (id, action, state) => ({ id, ts: 1, type: 'state', store: 'redux', action, state });

  test('diffState reports added / removed / changed by path', () => {
    expect(diffState({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual([
      { path: 'b', kind: 'changed', from: 2, to: 3 },
      { path: 'c', kind: 'added', to: 4 },
    ]);
    expect(diffState({ a: { x: 1 } }, { a: { x: 2 } })).toEqual([{ path: 'a.x', kind: 'changed', from: 1, to: 2 }]);
    expect(diffState({ a: 1 }, {})).toEqual([{ path: 'a', kind: 'removed', from: 1 }]);
    expect(diffState({ a: 1 }, { a: 1 })).toEqual([]);
  });

  test('selecting an action shows what it changed vs the previous state', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('s1', 'LOGIN', { cart: { items: [] } }));
    app.ingest(stateEvent('s2', 'ADD', { cart: { items: [{ sku: 'A1' }] } }));
    app.selectStateEvent('s2');
    const diff = document.querySelector('#main .state-diff');
    expect(diff).toBeTruthy();
    expect(diff.textContent).toContain('cart.items');
  });

  test('the first state for a store shows no prior diff (initial)', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('s1', 'INIT', { a: 1 }));
    app.selectStateEvent('s1');
    expect(document.querySelector('#main .state-diff').textContent.toLowerCase()).toContain('initial');
  });
});

describe('State — JSON tree + change flash', () => {
  beforeEach(setupDom);

  const stateEvent = (id, action, state) => ({ id, ts: 1, type: 'state', store: 'redux', action, state });

  test('jsonTree renders dot-path nodes (matching diffState) with values', () => {
    const html = jsonTree({ redux: { cart: { total: 250 } } });
    expect(html).toContain('data-path="redux"');
    expect(html).toContain('data-path="redux.cart"');
    expect(html).toContain('data-path="redux.cart.total"');
    expect(html).toContain('250');
    expect(html).toContain('jt-branch'); // objects are collapsible
  });

  test('a state change flashes the changed node (not the unchanged one) in the live tree', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('s1', 'A', { cart: { total: 0, items: [] } }));
    app.ingest(stateEvent('s2', 'B', { cart: { total: 250, items: [] } })); // only total changed
    const changed = document.querySelector('#main .state-right [data-path="redux.cart.total"]');
    const unchanged = document.querySelector('#main .state-right [data-path="redux.cart.items"]');
    expect(changed.classList.contains('flash')).toBe(true);
    expect(unchanged.classList.contains('flash')).toBe(false);
  });
});

describe('State — action payload', () => {
  beforeEach(setupDom);

  const stateEvent = (id, action, payload, state) => ({ id, ts: 1, type: 'state', store: 'redux', action, payload, state });
  const rightLabels = () =>
    [...document.querySelectorAll('#main .state-right .json-label')].map((n) => n.textContent);
  const payloadPre = () =>
    [...document.querySelectorAll('#main .state-right .json-block')]
      .find((b) => b.querySelector('.json-label')?.textContent === 'payload')
      ?.querySelector('pre')?.textContent;

  test('selecting an action shows its dispatched payload', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('s1', 'ADD_ITEM', { sku: 'A1', qty: 2 }, { cart: { items: [{ sku: 'A1' }] } }));
    app.selectStateEvent('s1');
    expect(rightLabels()).toContain('payload');
    expect(payloadPre()).toContain('A1');
    expect(payloadPre()).toContain('qty');
  });

  test('an action with no payload shows no payload panel', () => {
    const app = createApp(document);
    app.setActive('state');
    app.ingest(stateEvent('s1', 'RESET', undefined, { cart: { items: [] } }));
    app.selectStateEvent('s1');
    expect(rightLabels()).not.toContain('payload');
  });
});

describe('bounded history (perf)', () => {
  beforeEach(setupDom);

  // Regression: a chatty store used to grow events + the DOM without bound, so
  // clearing a filter / switching tabs eventually froze the UI.
  test('caps retained events and DOM rows so re-render stays bounded', () => {
    const app = createApp(document);
    app.setActive('logs');
    for (let i = 0; i < MAX_EVENTS + 200; i++) {
      app.ingest({ id: 'c' + i, ts: i, type: 'log', level: 'info', message: 'm' + i, args: ['m' + i] });
    }
    expect(app.events.length).toBe(MAX_EVENTS);
    expect(document.querySelectorAll('#main .row').length).toBeLessThanOrEqual(MAX_EVENTS);
    // the oldest events are dropped; the newest are kept
    expect(app.events[app.events.length - 1].message).toBe('m' + (MAX_EVENTS + 199));
    expect(app.events[0].message).toBe('m200');
  });
});
