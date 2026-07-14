// @vitest-environment happy-dom
//
// Tests the browser client (public/app.js). Written in JS so it can import the
// static client module directly; tsc ignores .js, vitest runs it.
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp, syntaxHighlight, jsonBlock, STATE_SNIPPETS } from '../public/app.js';

function setupDom() {
  document.body.innerHTML =
    `<span id="app-status"></span><div id="tabs"></div><main id="main"></main><span id="flash"></span>`;
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
