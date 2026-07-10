// @vitest-environment happy-dom
//
// Tests the browser client (public/app.js). Written in JS so it can import the
// static client module directly; tsc ignores .js, vitest runs it.
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp, syntaxHighlight, jsonBlock } from '../public/app.js';

function setupDom() {
  document.body.innerHTML = `<div id="tabs"></div><main id="main"></main><span id="flash"></span>`;
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
