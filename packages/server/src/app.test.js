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

describe('Flows — mock server', () => {
  beforeEach(setupDom);

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const stubFetch = (map) => {
    globalThis.fetch = (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      const body = map[`${method} ${url}`] ?? map[url] ?? {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    };
  };
  const activeStatus = (over = {}) => ({
    active: true, port: 9091, url: 'http://192.168.1.9:9091',
    flows: [], calls: [], endpoints: [{ method: 'GET', path: '/x/profile', count: 1 }], ...over,
  });

  test('the Flows list renders a Serve-as-mock toggle per flow', async () => {
    stubFetch({ '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }], '/mock': { active: false, flows: [], calls: [], endpoints: [] } });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    expect(document.querySelector('#main .mock-flow[data-id="login"]')).toBeTruthy();
  });

  test('serving a flow shows the banner (with URL) and highlights the row', async () => {
    stubFetch({
      '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }],
      '/mock': { active: false, flows: [], calls: [], endpoints: [] },
      'POST /mock/flow/login': activeStatus({ flows: ['login'] }),
    });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    await app.toggleFlowMock('login');
    expect(document.querySelector('#main .mock-banner')).toBeTruthy();
    expect(document.querySelector('#main .mock-banner').textContent).toContain('192.168.1.9:9091');
    expect(document.querySelector('#main .mock-flow.on[data-id="login"]')).toBeTruthy();
  });

  test('the banner shows LAN / Android-emulator / iOS-simulator URLs', async () => {
    stubFetch({
      '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }],
      '/mock': activeStatus({ flows: ['login'] }),
    });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    const banner = document.querySelector('#main .mock-banner').textContent;
    expect(banner).toContain('192.168.1.9:9091'); // LAN (physical device)
    expect(banner).toContain('10.0.2.2:9091');     // Android emulator
    expect(banner).toContain('localhost:9091');     // iOS simulator
  });

  test('the banner lists each active endpoint as a full, hittable mock URL', async () => {
    stubFetch({
      '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }],
      '/mock': activeStatus({
        flows: ['login'],
        endpoints: [
          { method: 'GET', path: '/mock/api/workingTime', count: 1 },
          { method: 'POST', path: '/mock/oauth/token', count: 1 },
        ],
      }),
    });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    const urls = [...document.querySelectorAll('#main .mock-ep-url')].map((n) => n.textContent);
    expect(urls).toContain('http://192.168.1.9:9091/mock/api/workingTime');
    expect(urls).toContain('http://192.168.1.9:9091/mock/oauth/token');
    // the GET endpoint is an anchor you can open in a browser
    const getEp = [...document.querySelectorAll('#main .mock-ep')].find((el) => el.textContent.includes('workingTime'));
    expect(getEp.querySelector('a')?.getAttribute('href')).toBe('http://192.168.1.9:9091/mock/api/workingTime');
  });

  test('the banner has a replay-timing toggle that posts to /mock/timing', async () => {
    stubFetch({
      '/flows': [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }],
      '/mock': activeStatus({ flows: ['login'] }),
      'POST /mock/timing': activeStatus({ flows: ['login'], timing: true }),
    });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    expect(document.querySelector('#main .mock-timing')).toBeTruthy();
    await app.toggleTiming();
    expect(document.querySelector('#main .mock-timing.on')).toBeTruthy();
  });

  test('stopMock clears the banner', async () => {
    stubFetch({ 'DELETE /mock': { active: false, flows: [], calls: [], endpoints: [] } });
    const app = createApp(document);
    app.mockState = activeStatus({ flows: ['login'] });
    app.flowList = [{ id: 'login', name: 'Login', createdAt: 1, count: 2 }];
    app.setActive('logs');       // avoid loadFlows fetch; render logs then flip
    app.setActive('flows');
    await flush();
    await app.stopMock();
    expect(document.querySelector('#main .mock-banner')).toBeNull();
  });
});

describe('Flows — save/delete without native dialogs (Electron-safe)', () => {
  beforeEach(setupDom);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('Save flow shows an in-app name modal (not window.prompt) and posts the name', async () => {
    const posts = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'POST' && url === '/flows') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'my-flow', name: JSON.parse(opts.body).name }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    };
    const app = createApp(document);
    app.ingest(netEvent(1)); // a captured network call to save
    const p = app.saveFlow();
    await flush();
    const input = document.querySelector('.modal-overlay .modal-input');
    expect(input).toBeTruthy(); // an in-app modal, not window.prompt()
    input.value = 'My Flow';
    document.querySelector('.modal-overlay .modal-ok').click();
    await p;
    expect(posts[0].name).toBe('My Flow');
    expect(document.querySelector('.modal-overlay')).toBeNull(); // modal closed after save
  });

  test('cancelling the name modal does not post', async () => {
    let posted = false;
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'POST') posted = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    };
    const app = createApp(document);
    app.ingest(netEvent(1));
    const p = app.saveFlow();
    await flush();
    document.querySelector('.modal-overlay .modal-cancel').click();
    await p;
    expect(posted).toBe(false);
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  test('Delete flow uses an in-app confirm modal (not window.confirm)', async () => {
    const dels = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'DELETE') { dels.push(url); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }); }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    };
    const app = createApp(document);
    const p = app.removeFlow('my-flow');
    await flush();
    const ok = document.querySelector('.modal-overlay .modal-ok');
    expect(ok).toBeTruthy(); // an in-app confirm modal
    ok.click();
    await p;
    expect(dels.some((u) => u.includes('/flows/my-flow'))).toBe(true);
  });
});

describe('Network — API call site', () => {
  beforeEach(setupDom);

  test('renders the calling function + a clickable file:line link', () => {
    const app = createApp(document);
    app.setActive('network');
    app.ingest(netEvent(1, { source: '/app/src/api.ts:42', callFn: 'callApi' }));
    const row = document.querySelector('#main .row');
    expect(row.textContent).toContain('callApi');
    const src = row.querySelector('.src');
    expect(src).toBeTruthy();
    expect(src.dataset.file).toBe('/app/src/api.ts');
    expect(src.dataset.line).toBe('42');
  });

  test('a call without a resolved source renders no link', () => {
    const app = createApp(document);
    app.setActive('network');
    app.ingest(netEvent(2));
    expect(document.querySelector('#main .row .src')).toBeNull();
  });
});

describe('Export log', () => {
  beforeEach(setupDom);

  const logEvent = (n, message, extra = {}) => ({
    id: 'l' + n, ts: 1700000000000 + n, type: 'log', level: 'log', message, args: [], source: null, ...extra,
  });

  test('exports only the active tab’s events that match the filter', () => {
    const app = createApp(document);
    app.setActive('logs');
    app.ingest(logEvent(1, 'hello world'));
    app.ingest(logEvent(2, 'goodbye'));
    app.ingest(netEvent(1)); // a network event — must not be in a logs export
    const p = app.logExportPayload();
    expect(p.tab).toBe('logs');
    expect(p.events.every((e) => e.type === 'log')).toBe(true);
    expect(p.count).toBe(2);

    app.setFilter('hello');
    const filtered = app.logExportPayload();
    expect(filtered.count).toBe(1);
    expect(filtered.events[0].message).toBe('hello world');
  });

  test('a tab with no plugin (Setup) has nothing to export', () => {
    const app = createApp(document);
    expect(app.logExportPayload()).toBeNull(); // starts on Setup
  });
});

describe('Flows — import mocks', () => {
  beforeEach(setupDom);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('the Flows list renders an Import button', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => [] });
    const app = createApp(document);
    app.setActive('flows');
    await flush();
    expect(document.querySelector('#main .import-mocks')).toBeTruthy();
  });

  test('importMocks posts the mock map to /flows/import', async () => {
    const posts = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'POST' && url === '/flows/import') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: 'aeoon', calls: [] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    };
    const app = createApp(document);
    await app.importMocks('aeoon', { '/api/x': { endpoint: '/api/x', statusCode: '200', resBody: '{}' } });
    expect(posts[0].name).toBe('aeoon');
    expect(posts[0].mocks['/api/x'].endpoint).toBe('/api/x');
  });
});

describe('Flows — edit a call (payload/response/status)', () => {
  beforeEach(setupDom);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const flow = {
    id: 'edit', name: 'Edit', createdAt: 1, calls: [
      { seq: 1, method: 'GET', url: 'https://api/x', status: 200, request: { headers: {}, body: { a: 1 } }, response: { headers: {}, body: { ok: true } } },
    ],
  };
  const openDetail = async (app) => {
    globalThis.fetch = (url, opts) => {
      if (url === '/flows/edit') return Promise.resolve({ ok: true, status: 200, json: async () => flow });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ active: false, flows: [], calls: [], endpoints: [] }) });
    };
    app.setActive('flows');
    await app.openFlow('edit');
    await flush();
  };

  test('Edit shows a status input + payload and response textareas', async () => {
    const app = createApp(document);
    await openDetail(app);
    app.editCall(1);
    expect(document.querySelector('#main .edit-status')).toBeTruthy();
    expect(document.querySelector('#main .edit-req')).toBeTruthy();
    expect(document.querySelector('#main .edit-res')).toBeTruthy();
  });

  test('Save PATCHes the parsed bodies + status', async () => {
    const app = createApp(document);
    await openDetail(app);
    app.editCall(1);
    const patches = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') { patches.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true, status: 200, json: async () => flow }); }
      if (url === '/flows/edit') return Promise.resolve({ ok: true, status: 200, json: async () => flow });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ active: false, flows: [], calls: [], endpoints: [] }) });
    };
    document.querySelector('#main .edit-res').value = '{"ok":false,"msg":"nope"}';
    document.querySelector('#main .edit-status').value = '500';
    await app.saveCallEdit('edit', 1);
    expect(patches[0].url).toContain('/flows/edit/calls/1');
    expect(patches[0].body.responseBody).toEqual({ ok: false, msg: 'nope' });
    expect(patches[0].body.status).toBe(500);
  });

  test('the call editor renders a highlighted backdrop with coloured JSON', async () => {
    const app = createApp(document);
    await openDetail(app);
    app.editCall(1);
    const wrap = document.querySelector('#main .edit-req').closest('.hl-editor');
    expect(wrap).toBeTruthy();
    const back = wrap.querySelector('.hl-back');
    expect(back.querySelector('.j-key')).toBeTruthy(); // "a": rendered as a key
    expect(back.innerHTML).toContain('j-num');          // the number 1
    // the textarea still holds the raw editable text
    expect(document.querySelector('#main .edit-req').value).toContain('"a": 1');
  });

  test('a JSON-string body is shown as readable JSON and saved back as a string', async () => {
    const jsFlow = {
      id: 'js', name: 'JS', createdAt: 1, calls: [
        { seq: 1, method: 'POST', url: 'https://api/x', status: 200, request: { headers: {}, body: '{"lang":"EN","n":37}' }, response: { headers: {}, body: { ok: true } } },
      ],
    };
    globalThis.fetch = (url) => url === '/flows/js'
      ? Promise.resolve({ ok: true, status: 200, json: async () => jsFlow })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ active: false, flows: [], calls: [], endpoints: [] }) });
    const app = createApp(document);
    app.setActive('flows');
    await app.openFlow('js');
    await flush();
    app.editCall(1);
    // shown as readable JSON, not an escaped one-liner string
    const reqText = document.querySelector('#main .edit-req').value;
    expect(reqText).toContain('"lang": "EN"');
    expect(reqText).not.toContain('\\"');

    const patches = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') { patches.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200, json: async () => jsFlow }); }
      if (url === '/flows/js') return Promise.resolve({ ok: true, status: 200, json: async () => jsFlow });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ active: false, flows: [], calls: [], endpoints: [] }) });
    };
    await app.saveCallEdit('js', 1);
    // saved back in the same wire shape: a JSON string
    expect(typeof patches[0].requestBody).toBe('string');
    expect(JSON.parse(patches[0].requestBody)).toEqual({ lang: 'EN', n: 37 });
    // the response (an object) stays an object
    expect(patches[0].responseBody).toEqual({ ok: true });
  });

  test('the editor edits method, url and headers too', async () => {
    const app = createApp(document);
    await openDetail(app);
    app.editCall(1);
    expect(document.querySelector('#main .edit-method')).toBeTruthy();
    expect(document.querySelector('#main .edit-url')).toBeTruthy();
    expect(document.querySelector('#main .edit-reqh')).toBeTruthy();
    const patches = [];
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') { patches.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200, json: async () => flow }); }
      if (url === '/flows/edit') return Promise.resolve({ ok: true, status: 200, json: async () => flow });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ active: false, flows: [], calls: [], endpoints: [] }) });
    };
    document.querySelector('#main .edit-method').value = 'DELETE';
    document.querySelector('#main .edit-url').value = 'https://api/y';
    document.querySelector('#main .edit-resh').value = '{"content-type":"text/plain"}';
    await app.saveCallEdit('edit', 1);
    expect(patches[0].method).toBe('DELETE');
    expect(patches[0].url).toBe('https://api/y');
    expect(patches[0].responseHeaders).toEqual({ 'content-type': 'text/plain' });
  });

  test('invalid JSON shows an error and sends no PATCH', async () => {
    const app = createApp(document);
    await openDetail(app);
    app.editCall(1);
    let patched = false;
    globalThis.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') patched = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => flow });
    };
    document.querySelector('#main .edit-res').value = '{ not json';
    await app.saveCallEdit('edit', 1);
    expect(patched).toBe(false);
    expect(document.querySelector('#main .edit-error').textContent.length).toBeGreaterThan(0);
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
