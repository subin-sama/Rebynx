// Rebynx browser client — served statically (no build step), also imported by
// app.test.ts. Zero side effects on import: index.html calls createApp().start().

export const PLUGINS = [
  { id: 'logs', label: 'Logs', accepts: (e) => e.type === 'log' },
  { id: 'network', label: 'Network', accepts: (e) => e.type === 'network' },
  { id: 'state', label: 'State', accepts: (e) => e.type === 'state' },
  { id: 'inspect', label: 'Inspect', accepts: (e) => e.type === 'inspect' },
];

// How to wire each state manager into the State tab (shown in the Setup tab).
// Console + network hook automatically; state must be connected explicitly, so
// these snippets tell you exactly how — always with the SAME `devtoolsHub`.
export const STATE_SNIPPETS = [
  {
    id: 'redux',
    label: 'Redux / Saga',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { createReduxMiddleware } from '@rebynx/core';

// RTK — add next to your saga middleware:
const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefault) =>
    getDefault().concat(sagaMiddleware, createReduxMiddleware(devtoolsHub)),
});
sagaMiddleware.run(rootSaga);

// plain redux:
//   createStore(rootReducer,
//     applyMiddleware(sagaMiddleware, createReduxMiddleware(devtoolsHub)));`,
  },
  {
    id: 'zustand',
    label: 'Zustand',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackZustand } from '@rebynx/core';

trackZustand(devtoolsHub, useBearStore, 'bear');
// or at init:  initDevTools({ url, zustand: { bear: useBearStore } });`,
  },
  {
    id: 'mmkv',
    label: 'MMKV',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackMMKV } from '@rebynx/core';
import { storage } from './mmkv'; // your MMKV instance

trackMMKV(devtoolsHub, storage, 'mmkv');`,
  },
  {
    id: 'async',
    label: 'AsyncStorage',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackAsyncStorage } from '@rebynx/core';
import AsyncStorage from '@react-native-async-storage/async-storage';

trackAsyncStorage(devtoolsHub, AsyncStorage, 'async-storage');`,
  },
  {
    id: 'jotai',
    label: 'Jotai',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackJotai } from '@rebynx/core';
import { getDefaultStore } from 'jotai';

trackJotai(devtoolsHub, getDefaultStore(), { count: countAtom, user: userAtom }, 'jotai');`,
  },
  {
    id: 'mobx',
    label: 'MobX',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackMobX } from '@rebynx/core';
import { toJS, autorun } from 'mobx';

trackMobX(devtoolsHub, myObservableState, toJS, autorun, 'mobx');`,
  },
  {
    id: 'custom',
    label: 'Custom',
    code: `import { devtoolsHub } from '@rebynx/rn';
import { trackStore } from '@rebynx/core';

// any store with a snapshot + a change subscription:
trackStore(devtoolsHub, {
  name: 'cart',
  getState: () => cart.value,
  subscribe: (cb) => cart.onChange(cb),
});`,
  },
];

export const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Keep only the most recent N events (and DOM rows). A chatty app — e.g. a
// redux-saga store emitting a state snapshot per action — otherwise grows the
// events array and the DOM without bound, so re-rendering (clearing a filter,
// switching tabs) eventually freezes the UI.
export const MAX_EVENTS = 1000;

const time = (ts) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');

/** Pretty-print a value as JSON with lightweight token colouring. `indent` 0 = compact. */
export function syntaxHighlight(value, indent = 2) {
  const json = JSON.stringify(value, null, indent);
  if (json === undefined) return esc(String(value));
  return esc(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'j-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'j-key' : 'j-str';
      else if (match === 'true' || match === 'false') cls = 'j-bool';
      else if (match === 'null') cls = 'j-null';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

/** A copyable, highlighted JSON panel. The <pre>'s textContent is the raw JSON. */
export function jsonBlock(label, value) {
  return `<div class="json-block">
    <div class="json-bar"><span class="json-label">${esc(label)}</span><button class="copy-btn" type="button">Copy</button></div>
    <pre>${syntaxHighlight(value)}</pre>
  </div>`;
}

const isPlainObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-diff two state snapshots into a flat, path-keyed change list:
 * `[{ path, kind: 'added'|'removed'|'changed', from?, to? }]`. Arrays and
 * primitives are compared whole (by JSON), objects are walked key by key.
 */
export function diffState(prev, next, path = '', out = []) {
  if (!isPlainObj(prev) || !isPlainObj(next)) {
    if (JSON.stringify(prev) !== JSON.stringify(next)) out.push({ path, kind: 'changed', from: prev, to: next });
    return out;
  }
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in prev)) out.push({ path: p, kind: 'added', to: next[k] });
    else if (!(k in next)) out.push({ path: p, kind: 'removed', from: prev[k] });
    else if (isPlainObj(prev[k]) && isPlainObj(next[k])) diffState(prev[k], next[k], p, out);
    else if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out.push({ path: p, kind: 'changed', from: prev[k], to: next[k] });
  }
  return out;
}

function diffVal(v) {
  const s = JSON.stringify(v);
  const str = s === undefined ? 'undefined' : s;
  return `<span class="diff-val">${esc(str.length > 90 ? str.slice(0, 90) + '…' : str)}</span>`;
}

/** Render a change list from diffState (null = no prior state) as a coloured panel. */
export function diffHtml(changes) {
  const bar = `<div class="json-bar"><span class="json-label">changes</span></div>`;
  if (changes === null) return `<div class="state-diff">${bar}<div class="diff-empty">initial — no prior state</div></div>`;
  if (!changes.length) return `<div class="state-diff">${bar}<div class="diff-empty">no change</div></div>`;
  const rows = changes.map((c) => {
    const sign = c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~';
    const val = c.kind === 'changed'
      ? `${diffVal(c.from)} <span class="diff-arrow">→</span> ${diffVal(c.to)}`
      : diffVal(c.kind === 'added' ? c.to : c.from);
    return `<div class="diff-row diff-${c.kind}"><span class="diff-sign">${sign}</span><span class="diff-path">${esc(c.path)}</span> ${val}</div>`;
  }).join('');
  return `<div class="state-diff">${bar}<div class="diff-body">${rows}</div></div>`;
}

// One entry (key -> value) of the JSON tree. Objects recurse into collapsible
// branches; arrays/primitives are leaves. Each node's data-path is dot notation
// aligned with diffState, so a change can be located + flashed by selector.
function jtEntry(key, value, path) {
  const p = path ? `${path}.${key}` : key;
  if (isPlainObj(value)) {
    const keys = Object.keys(value);
    const kids = keys.length
      ? keys.map((k) => jtEntry(k, value[k], p)).join('')
      : '<div class="jt-row jt-empty">{ }</div>';
    return `<div class="jt-node jt-obj" data-path="${esc(p)}">
      <div class="jt-row jt-branch"><span class="jt-caret"></span><span class="jt-key">${esc(key)}</span><span class="jt-punc">:</span></div>
      <div class="jt-kids">${kids}</div>
    </div>`;
  }
  return `<div class="jt-node jt-leaf" data-path="${esc(p)}">
    <div class="jt-row"><span class="jt-key">${esc(key)}</span><span class="jt-punc">:</span> <span class="jt-leafval">${syntaxHighlight(value, 0)}</span></div>
  </div>`;
}

/** Render `{ [store]: state }` as a collapsible, path-tagged JSON tree. */
export function jsonTree(obj) {
  if (!isPlainObj(obj) || !Object.keys(obj).length) return '<div class="empty">no state yet — wire a store adapter (see Setup)</div>';
  return `<div class="jt-tree">${Object.keys(obj).map((k) => jtEntry(k, obj[k], '')).join('')}</div>`;
}

function srcLink(source) {
  if (!source) return '';
  const i = source.lastIndexOf(':');
  const file = source.slice(0, i);
  const line = source.slice(i + 1);
  return `<span class="src" data-file="${esc(file)}" data-line="${esc(line)}">${esc(source.split('/').pop())}</span>`;
}

// ---- row renderers (pure: event -> html string) ----
export function rowLog(e) {
  return `<div class="row">
    <span class="ts">${time(e.ts)}</span>
    <span class="lvl ${e.level}">${e.level}</span>
    <span class="msg">${esc(e.message)}${argsBlock(e.args)}</span>
    ${srcLink(e.source)}
  </div>`;
}
function argsBlock(args) {
  if (!args || !args.length || (args.length === 1 && typeof args[0] === 'string')) return '';
  return `<details><summary>args</summary>${jsonBlock('args', args)}</details>`;
}

export function rowNet(e) {
  const pending = e.phase !== 'end';
  const statusCls = pending ? 'pending' : e.ok ? 'ok' : 'err';
  const statusTxt = pending ? '···' : e.status;
  return `<div class="row">
    <span class="ts">${time(e.ts)}</span>
    <span class="method">${esc(e.method || '')}</span>
    <span class="status ${statusCls}">${statusTxt}</span>
    <span class="url">${esc(e.url || '')}
      <details><summary>details${e.duration != null ? ' · ' + e.duration + 'ms' : ''}</summary>
        ${jsonBlock('Request', { headers: e.reqHeaders, body: e.reqBody })}
        ${jsonBlock('Response' + (e.status != null ? ' · ' + e.status : ''), { headers: e.resHeaders, body: e.resBody })}
      </details>
    </span>
    <span class="dur">${e.duration != null ? e.duration + 'ms' : ''}</span>
  </div>`;
}

export function rowState(e) {
  return `<div class="row">
    <span class="ts">${time(e.ts)}</span>
    <span class="store-tag">${esc(e.store)}</span>
    ${e.action ? `<span class="action-tag">${esc(e.action)}</span>` : ''}
    <span class="msg"><details><summary>state</summary>${jsonBlock('state', e.state)}</details></span>
  </div>`;
}

export function rowInspect(e) {
  return `<div class="row">
    <span class="ts">${time(e.ts)}</span>
    <span class="store-tag">${esc(e.name || 'element')}</span>
    ${srcLink(e.source)}
    <span class="msg"><details><summary>props / style</summary>${jsonBlock('props / style', { props: e.props, style: e.style })}</details></span>
  </div>`;
}

const RENDERERS = { logs: rowLog, network: rowNet, state: rowState, inspect: rowInspect };

function htmlToNode(doc, html) {
  const tmp = doc.createElement('div');
  tmp.innerHTML = html.trim();
  return tmp.firstElementChild;
}

/**
 * Build the app over a document. No I/O until start() is called, so tests can
 * drive ingest() against a jsdom/happy-dom document without opening a socket.
 */
export function createApp(doc = globalThis.document) {
  const $ = (id) => doc.getElementById(id);
  const main = () => $('main');

  let active = 'setup';       // land on the Setup/connect tab
  let filter = '';
  const events = [];
  const netIndex = new Map(); // reqId -> merged network row (data)
  const netNodes = new Map(); // reqId -> row element (DOM), for in-place updates
  let flowList = [];
  let flowDetail = null;
  let mockState = { active: false, port: 9091, url: '', flows: [], calls: [], endpoints: [] };
  let appsConnected = 0;      // RN apps currently connected to the relay
  let lanInfo = { lanIp: null };
  let stateAdapter = 'redux'; // which state-manager snippet the Setup tab shows
  let statePaused = false;    // freeze the live current tree so a streaming store is readable
  let selectedState = null;   // a picked past state event (frozen), or null = live current
  const latestState = {};     // { [store]: latest snapshot } for the current tree
  let lastChangedPaths = [];  // tree data-paths changed by the most recent state event
  let ws;

  const matches = (e) => !filter || JSON.stringify(e).toLowerCase().includes(filter);

  function renderTabs() {
    const pluginTabs = PLUGINS.map((p) => {
      const n = events.filter((e) => p.accepts(e)).length;
      return `<div class="tab ${p.id === active ? 'active' : ''}" data-tab="${p.id}">${p.label} <span class="count">${n}</span></div>`;
    }).join('');
    const setupTab = `<div class="tab ${active === 'setup' ? 'active' : ''}" data-tab="setup">Setup</div>`;
    const flowsTab = `<div class="tab ${active === 'flows' ? 'active' : ''}" data-tab="flows">Flows <span class="count">${flowList.length}</span></div>`;
    $('tabs').innerHTML = setupTab + pluginTabs + flowsTab;
  }

  // Full rebuild of #main for the active tab. Used on tab switch / filter /
  // clear / flow nav — NOT on every incoming event (that's what append is for).
  // ---- State tab: Current (merged tree) / Timeline (per-action rows) ----
  // Left pane: one clickable row per state event (ts · store · action).
  function stateItemHtml(e) {
    return `<div class="state-item ${selectedState === e ? 'sel' : ''}" data-sid="${esc(e.id)}">
      <span class="ts">${time(e.ts)}</span>
      <span class="store-tag">${esc(e.store)}</span>
      ${e.action ? `<span class="action-tag">${esc(e.action)}</span>` : ''}
    </div>`;
  }

  function renderStateTimeline() {
    const el = $('state-left');
    if (!el) return;
    const list = events.filter((e) => e.type === 'state' && matches(e)).slice(-MAX_EVENTS);
    el.innerHTML = list.length ? list.map(stateItemHtml).join('') : `<div class="empty">no state yet</div>`;
  }

  // The previous state event for the same store (to diff against), or null.
  function prevStateOf(e) {
    const idx = events.indexOf(e);
    for (let i = idx - 1; i >= 0; i--) {
      if (events[i].type === 'state' && events[i].store === e.store) return events[i];
    }
    return null;
  }

  // Right pane: a picked snapshot (frozen) + what it changed, else the live tree.
  function stateDetailHtml() {
    if (selectedState) {
      const prev = prevStateOf(selectedState);
      const changes = prev ? diffState(prev.state, selectedState.state) : null;
      const payload = selectedState.payload !== undefined ? jsonBlock('payload', selectedState.payload) : '';
      return `<div class="state-detail-bar">
        <span class="json-label">${esc(selectedState.store)}${selectedState.action ? ' · ' + esc(selectedState.action) : ''}</span>
        <button class="state-live">← Live</button>
      </div>${payload}${diffHtml(changes)}${jsonBlock('state', selectedState.state)}`;
    }
    const bar = `<div class="state-detail-bar">
      <span class="json-label">current state — live</span>
      <button class="state-pause ${statePaused ? 'paused' : ''}">${statePaused ? '▶ Resume' : '⏸ Pause'}</button>
    </div>`;
    return bar + jsonTree(latestState);
  }

  function renderStateDetail() {
    const el = $('state-right');
    if (el) el.innerHTML = stateDetailHtml();
  }

  // After a live re-render, flash the nodes this event changed + reveal the first.
  function flashChanges(paths) {
    const right = $('state-right');
    if (!right || !paths || !paths.length) return;
    let first = null;
    for (const p of paths) {
      let node = null;
      try { node = right.querySelector(`.jt-node[data-path="${p}"]`); } catch { node = null; }
      if (node) { node.classList.add('flash'); if (!first) first = node; }
    }
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
  }

  function renderStateTab() {
    netNodes.clear();
    main().innerHTML =
      `<div class="state-split"><div class="state-left" id="state-left"></div><div class="state-right" id="state-right"></div></div>`;
    renderStateTimeline();
    renderStateDetail();
  }

  function selectStateEvent(id) {
    selectedState = events.find((e) => e.type === 'state' && e.id === id) || null;
    const el = $('state-left');
    if (el) el.querySelectorAll('.state-item').forEach((n) => n.classList.toggle('sel', n.dataset.sid === id));
    renderStateDetail();
  }

  function goLiveState() {
    selectedState = null;
    const el = $('state-left');
    if (el) el.querySelectorAll('.state-item.sel').forEach((n) => n.classList.remove('sel'));
    renderStateDetail();
  }

  function togglePause() {
    statePaused = !statePaused;
    if (active === 'state' && !selectedState) renderStateDetail(); // on resume, catch up
  }

  // A state event: append to the left timeline; refresh the right only when it is
  // showing the live current tree (not a frozen selection) and not paused.
  function liveStateRow(e) {
    if (e.type !== 'state' || !matches(e)) return;
    const el = $('state-left');
    if (el) {
      const empty = el.querySelector('.empty');
      if (empty) el.innerHTML = '';
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.appendChild(htmlToNode(doc, stateItemHtml(e)));
      while (el.childElementCount > MAX_EVENTS) el.removeChild(el.firstElementChild);
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
    if (!selectedState && !statePaused) { renderStateDetail(); flashChanges(lastChangedPaths); }
  }

  function fullRender() {
    renderTabs();
    if (active === 'setup') return renderSetup();
    if (active === 'flows') return renderFlows();
    if (active === 'state') return renderStateTab();
    netNodes.clear();
    const el = main();
    const plugin = PLUGINS.find((p) => p.id === active);
    const list = events.filter((e) => plugin.accepts(e) && matches(e));
    if (!list.length) {
      el.innerHTML = `<div class="empty">no ${active} yet</div>`;
      return;
    }
    el.innerHTML = '';
    for (const e of list) {
      const node = htmlToNode(doc, RENDERERS[active](e));
      el.appendChild(node);
      if (e.type === 'network') netNodes.set(e.reqId, node);
    }
  }

  // Incremental: append (or, for a network row's 'end', update in place) a
  // single row without touching existing rows — so an open <details> or a text
  // selection the user is reading/copying survives the next event.
  function liveRow(e) {
    if (active === 'setup' || active === 'flows') return;
    if (active === 'state') { liveStateRow(e); return; }
    const plugin = PLUGINS.find((p) => p.id === active);
    if (!plugin.accepts(e) || !matches(e)) return;

    const el = main();
    const empty = el.querySelector('.empty');
    if (empty) el.innerHTML = '';

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

    if (e.type === 'network' && netNodes.has(e.reqId)) {
      const fresh = htmlToNode(doc, RENDERERS.network(e));
      netNodes.get(e.reqId).replaceWith(fresh);
      netNodes.set(e.reqId, fresh);
    } else {
      const node = htmlToNode(doc, RENDERERS[active](e));
      el.appendChild(node);
      if (e.type === 'network') netNodes.set(e.reqId, node);
      // Keep the DOM bounded — drop the oldest row(s) past the cap.
      while (el.childElementCount > MAX_EVENTS) el.removeChild(el.firstElementChild);
    }

    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  // Drop the oldest events once we exceed the cap, keeping memory + the DOM
  // (and therefore every re-render) bounded no matter how chatty the app is.
  function capEvents() {
    while (events.length > MAX_EVENTS) {
      const dropped = events.shift();
      if (dropped && dropped.type === 'network') {
        netIndex.delete(dropped.reqId);
        netNodes.delete(dropped.reqId);
      }
    }
  }

  function ingest(e) {
    let row = e;
    if (e.type === 'network') {
      const existing = netIndex.get(e.reqId);
      if (existing) {
        Object.assign(existing, e);
        row = existing;
      } else {
        netIndex.set(e.reqId, e);
        events.push(e);
      }
    } else {
      events.push(e);
    }
    // Track the latest snapshot per store + which tree paths this event changed.
    if (e.type === 'state') {
      const prev = latestState[e.store];
      lastChangedPaths = diffState(prev === undefined ? {} : prev, e.state)
        .map((c) => (c.path ? `${e.store}.${c.path}` : e.store));
      latestState[e.store] = e.state;
    }
    capEvents();
    renderTabs();
    liveRow(row);
  }

  function clearAll() {
    events.length = 0;
    netIndex.clear();
    netNodes.clear();
    for (const k of Object.keys(latestState)) delete latestState[k];
    selectedState = null;
    flowDetail = null;
    // Reset the filter too — otherwise a leftover filter keeps hiding the events
    // that stream in after Clear, making the tab look permanently empty.
    filter = '';
    const filterInput = $('filter');
    if (filterInput) filterInput.value = '';
    fullRender();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ kind: 'command', command: { type: 'clear' } }));
    }
  }

  function setActive(tab) {
    active = tab;
    if (active === 'flows') {
      flowDetail = null;
      loadFlows();
    } else {
      fullRender();
    }
  }

  function setFilter(value) {
    filter = value.toLowerCase();
    fullRender();
  }

  // ---- flows ----
  function flash(msg) {
    const el = $('flash');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => el.classList.remove('on'), 2500);
  }

  // In-app dialogs. Electron's BrowserWindow does NOT implement window.prompt()
  // (it returns null), so a prompt-based Save silently fails in the desktop app.
  // These portable modals work in the browser AND Electron (and are testable).
  function askModal({ message, withInput, def = '', okLabel }) {
    return new Promise((resolve) => {
      const overlay = doc.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `<div class="modal">
        <div class="modal-msg"></div>
        ${withInput ? '<input class="modal-input" />' : ''}
        <div class="modal-btns">
          <button class="modal-cancel" type="button">Cancel</button>
          <button class="modal-ok" type="button">${esc(okLabel)}</button>
        </div>
      </div>`;
      overlay.querySelector('.modal-msg').textContent = message;
      const input = overlay.querySelector('.modal-input');
      if (input) input.value = def;
      doc.body.appendChild(overlay);
      if (input && input.focus) { input.focus(); if (input.select) input.select(); }
      const close = (result) => { overlay.remove(); resolve(result); };
      const ok = () => close(withInput ? (input.value.trim() || null) : true);
      const cancel = () => close(withInput ? null : false);
      overlay.querySelector('.modal-ok').addEventListener('click', ok);
      overlay.querySelector('.modal-cancel').addEventListener('click', cancel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
      if (input) input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ok();
        else if (e.key === 'Escape') cancel();
      });
    });
  }

  const askName = (message, def = '') => askModal({ message, withInput: true, def, okLabel: 'Save' });
  const askConfirm = (message) => askModal({ message, withInput: false, okLabel: 'Delete' });

  function buildFlowCalls() {
    return events
      .filter((e) => e.type === 'network')
      .map((e, i) => ({
        seq: i + 1,
        method: e.method, url: e.url, status: e.status, ok: e.ok, duration: e.duration,
        request: { headers: e.reqHeaders, body: e.reqBody },
        response: { headers: e.resHeaders, body: e.resBody },
      }));
  }

  async function saveFlow() {
    const calls = buildFlowCalls();
    if (!calls.length) {
      alert('No network calls to save. Drive a flow first (Clear, then play).');
      return;
    }
    const name = await askName(`Save ${calls.length} network call(s) as a flow named:`);
    if (!name || !name.trim()) return;
    try {
      const res = await fetch('/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), calls }),
      });
      if (res.status === 404) {
        alert('Save endpoint not found (404). The relay server is running an older build without /flows — restart it (e.g. `npm run server:dev`) and try again.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const flow = await res.json();
      flash(`Saved “${flow.name}” · ${calls.length} calls`);
      if (active === 'flows') loadFlows();
    } catch (err) {
      alert('Could not save flow: ' + err.message);
    }
  }

  async function loadFlows() {
    try { flowList = await (await fetch('/flows')).json(); }
    catch { flowList = []; }
    await loadMock();
    fullRender();
  }

  async function openFlow(id) {
    try { flowDetail = await (await fetch('/flows/' + encodeURIComponent(id))).json(); }
    catch { flowDetail = null; }
    await loadMock();
    fullRender();
  }

  async function removeFlow(id) {
    if (!(await askConfirm('Delete this flow?'))) return;
    try { await fetch('/flows/' + encodeURIComponent(id), { method: 'DELETE' }); } catch {}
    if (flowDetail && flowDetail.id === id) flowDetail = null;
    loadFlows();
  }

  // Download the flow JSON (native format) so it can be imported elsewhere,
  // e.g. into api-ui-mapper as mock overrides.
  async function exportFlow(id) {
    try {
      const res = await fetch('/flows/' + encodeURIComponent(id));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const flow = await res.json();
      const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = id + '.json';
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash(`Exported ${id}.json`);
    } catch (err) {
      alert('Could not export flow: ' + err.message);
    }
  }

  // ---- mock server (replay saved flows as a live API) ----
  async function loadMock() {
    try { mockState = await (await fetch('/mock')).json(); } catch { /* keep last */ }
  }

  async function applyMock(res) {
    if (res && res.ok) mockState = await res.json();
    if (active === 'flows') fullRender();
  }

  async function toggleFlowMock(id) {
    const on = mockState.flows.includes(id);
    await applyMock(await fetch('/mock/flow/' + encodeURIComponent(id), { method: on ? 'DELETE' : 'POST' }));
  }

  async function toggleCallMock(flowId, seq) {
    const on = mockState.calls.includes(flowId + '#' + seq);
    await applyMock(await fetch('/mock/call/' + encodeURIComponent(flowId) + '/' + encodeURIComponent(seq), { method: on ? 'DELETE' : 'POST' }));
  }

  async function stopMock() {
    await applyMock(await fetch('/mock', { method: 'DELETE' }));
  }

  function mockBanner() {
    if (!mockState.active) return '';
    const n = mockState.endpoints.length;
    // Full, hittable URLs (base + path) so it's obvious what to call — the flow
    // rows show the ORIGINAL captured host (e.g. 10.0.2.2:3000), not the mock.
    const eps = (mockState.endpoints || []).map((e) => {
      const full = mockState.url + e.path;
      const link = e.method === 'GET'
        ? `<a class="mock-ep-url" href="${esc(full)}" target="_blank" rel="noopener">${esc(full)}</a>`
        : `<span class="mock-ep-url">${esc(full)}</span>`;
      return `<div class="mock-ep"><span class="method">${esc(e.method)}</span>${link}</div>`;
    }).join('');
    return `<div class="mock-banner">
      <div class="mock-banner-row">
        <span class="mock-dot"></span>
        <span>Mock API live · ${n} endpoint${n === 1 ? '' : 's'}</span>
        <button class="mock-stop">Stop</button>
      </div>
      ${codeBlock('point your app’s baseURL here', mockState.url)}
      ${eps ? `<div class="mock-eps">${eps}</div>` : ''}
    </div>`;
  }

  function renderFlows() {
    if (flowDetail) return renderFlowDetail();
    const el = main();
    if (!flowList.length) {
      el.innerHTML = mockBanner() + `<div class="empty">no saved flows yet — Clear, drive a flow, then “Save flow”</div>`;
      return;
    }
    el.innerHTML = mockBanner() + flowList.map((f) => `
      <div class="row flow-row" data-id="${esc(f.id)}">
        <span class="ts">${time(f.createdAt)}</span>
        <span class="flow-name">${esc(f.name)}</span>
        <span class="url"><span class="count">${f.count} call${f.count === 1 ? '' : 's'}</span></span>
        <button class="mock-flow ${mockState.flows.includes(f.id) ? 'on' : ''}" data-id="${esc(f.id)}">${mockState.flows.includes(f.id) ? '✓ Mocking' : '▶ Serve as mock'}</button>
        <button class="flow-export" data-id="${esc(f.id)}">Export</button>
        <button class="flow-del" data-id="${esc(f.id)}">Delete</button>
      </div>`).join('');
  }

  function renderFlowDetail() {
    const f = flowDetail;
    const calls = f.calls || [];
    const body = calls.map((c) => {
      const statusCls = c.ok ? 'ok' : c.status ? 'err' : 'pending';
      const mocked = mockState.calls.includes(f.id + '#' + c.seq);
      return `<div class="row">
        <span class="seq">#${c.seq}</span>
        <span class="method">${esc(c.method || '')}</span>
        <span class="status ${statusCls}">${c.status != null ? c.status : '···'}</span>
        <span class="url">${esc(c.url || '')}
          <details><summary>details${c.duration != null ? ' · ' + c.duration + 'ms' : ''}</summary>
            ${jsonBlock('Request', c.request)}
            ${jsonBlock('Response' + (c.status != null ? ' · ' + c.status : ''), c.response)}
          </details>
        </span>
        <button class="mock-call ${mocked ? 'on' : ''}" data-flow="${esc(f.id)}" data-seq="${esc(c.seq)}">${mocked ? '✓ Mocked' : 'Mock'}</button>
      </div>`;
    }).join('');
    main().innerHTML = `
      <div class="flow-head">
        <button class="flow-back">← Flows</button>
        <span class="flow-name">${esc(f.name)}</span>
        <span class="count">${calls.length} call${calls.length === 1 ? '' : 's'} · ${time(f.createdAt)}</span>
      </div>${mockBanner()}${body || '<div class="empty">no calls in this flow</div>'}`;
  }

  function copyFrom(btn) {
    const block = btn.closest('.json-block');
    const pre = block && block.querySelector('pre');
    if (!pre) return;
    const text = pre.textContent;
    const done = () => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    };
    if (globalThis.navigator?.clipboard?.writeText) {
      globalThis.navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      done();
    }
  }

  // ---- setup / connection ----
  // A copyable plain-text block (reuses the .json-block chrome; the <pre> text is
  // the raw content so copyFrom yields it verbatim).
  function codeBlock(label, text) {
    return `<div class="json-block">
      <div class="json-bar"><span class="json-label">${esc(label)}</span><button class="copy-btn" type="button">Copy</button></div>
      <pre>${esc(text)}</pre>
    </div>`;
  }

  function connectUrl() {
    const host = lanInfo.lanIp || location.hostname || 'localhost';
    const port = location.port || '9090';
    return `ws://${host}:${port}`;
  }

  function updateAppStatus() {
    const el = $('app-status');
    if (!el) return;
    if (appsConnected > 0) {
      el.textContent = `● ${appsConnected} app${appsConnected > 1 ? 's' : ''} connected`;
      el.className = 'app-status on';
    } else {
      el.textContent = '○ waiting for app';
      el.className = 'app-status';
    }
  }

  function renderSetupBanner(el) {
    if (!el) return;
    if (appsConnected > 0) {
      el.className = 'setup-banner ok';
      el.textContent = `✓ ${appsConnected} app${appsConnected > 1 ? 's' : ''} connected`;
    } else {
      el.className = 'setup-banner wait';
      el.textContent = 'Waiting for your app to connect…';
    }
  }

  function renderSetup() {
    const url = connectUrl();
    const port = location.port || '9090';
    main().innerHTML = `
      <div class="setup">
        <div class="setup-banner" id="setup-banner"></div>
        <div class="setup-label">Point your React Native app here</div>
        ${codeBlock('WebSocket URL', url)}
        <div class="setup-label">1 · Install</div>
        ${codeBlock('shell', 'npm i -D @rebynx/rn')}
        <div class="setup-label">2 · Wire it up — top of your entry file</div>
        ${codeBlock('index.js', `import { initDevTools, DevToolsOverlay } from '@rebynx/rn';\n\nif (__DEV__) {\n  initDevTools({ url: '${url}' });\n}\n\n// render <DevToolsOverlay/> once at your app root`)}
        <div class="setup-label">3 · Inspect your state — optional (logs + network need nothing)</div>
        <div class="state-picker">
          ${STATE_SNIPPETS.map((s) => `<button class="state-opt ${s.id === stateAdapter ? 'active' : ''}" data-adapter="${s.id}">${esc(s.label)}</button>`).join('')}
        </div>
        ${codeBlock('store setup', (STATE_SNIPPETS.find((s) => s.id === stateAdapter) || STATE_SNIPPETS[0]).code)}
        <div class="setup-hint">Must use the same <code>devtoolsHub</code> from <code>@rebynx/rn</code> — a fresh <code>Hub</code> won't reach the relay, so State stays empty.</div>
        <div class="setup-note">Android emulator can't reach your LAN IP — use <code>ws://10.0.2.2:${esc(port)}</code>. A physical device uses the LAN address above (same Wi-Fi).</div>
      </div>`;
    renderSetupBanner($('setup-banner'));
  }

  function selectStateAdapter(id) {
    if (STATE_SNIPPETS.some((s) => s.id === id)) stateAdapter = id;
    if (active === 'setup') renderSetup();
  }

  function handlePresence(apps) {
    if (typeof apps !== 'number') return;
    appsConnected = apps;
    updateAppStatus();
    renderSetupBanner($('setup-banner'));
  }

  function handleInfo(info) {
    if (info && typeof info.lanIp === 'string') lanInfo.lanIp = info.lanIp;
    if (info && typeof info.apps === 'number') appsConnected = info.apps;
    updateAppStatus();
    if (active === 'setup') renderSetup();
  }

  async function loadInfo() {
    try { handleInfo(await (await fetch('/info')).json()); }
    catch { handleInfo({ lanIp: location.hostname }); }
  }

  // ---- DOM wiring + socket (browser only) ----
  function start() {
    $('tabs').addEventListener('click', (ev) => {
      const tab = ev.target.closest('.tab');
      if (tab) setActive(tab.dataset.tab);
    });
    $('save-flow').addEventListener('click', saveFlow);
    $('filter').addEventListener('input', (ev) => setFilter(ev.target.value));
    $('clear').addEventListener('click', clearAll);
    main().addEventListener('click', (ev) => {
      const branch = ev.target.closest('.jt-branch');
      if (branch) { ev.stopPropagation(); branch.parentElement.classList.toggle('collapsed'); return; }
      const item = ev.target.closest('.state-item');
      if (item) { ev.stopPropagation(); selectStateEvent(item.dataset.sid); return; }
      if (ev.target.closest('.state-live')) { ev.stopPropagation(); goLiveState(); return; }
      if (ev.target.closest('.state-pause')) { ev.stopPropagation(); togglePause(); return; }
      const stateOpt = ev.target.closest('.state-opt');
      if (stateOpt) { ev.stopPropagation(); selectStateAdapter(stateOpt.dataset.adapter); return; }
      const copyBtn = ev.target.closest('.copy-btn');
      if (copyBtn) { ev.stopPropagation(); copyFrom(copyBtn); return; }
      const mflow = ev.target.closest('.mock-flow');
      if (mflow) { ev.stopPropagation(); toggleFlowMock(mflow.dataset.id); return; }
      const mcall = ev.target.closest('.mock-call');
      if (mcall) { ev.stopPropagation(); toggleCallMock(mcall.dataset.flow, mcall.dataset.seq); return; }
      if (ev.target.closest('.mock-stop')) { ev.stopPropagation(); stopMock(); return; }
      const exp = ev.target.closest('.flow-export');
      if (exp) { ev.stopPropagation(); exportFlow(exp.dataset.id); return; }
      const del = ev.target.closest('.flow-del');
      if (del) { ev.stopPropagation(); removeFlow(del.dataset.id); return; }
      const back = ev.target.closest('.flow-back');
      if (back) { flowDetail = null; fullRender(); return; }
      const frow = ev.target.closest('.flow-row');
      if (frow) { openFlow(frow.dataset.id); return; }
      const s = ev.target.closest('.src');
      if (s) fetch(`/open?file=${encodeURIComponent(s.dataset.file)}&line=${encodeURIComponent(s.dataset.line)}`).catch(() => {});
    });

    connect();
    fullRender();
    loadInfo();
    return controller;
  }

  function connect() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => {
      $('dot').classList.add('on');
      $('conn-text').textContent = 'connected';
      ws.send(JSON.stringify({ kind: 'hello', role: 'browser' }));
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.kind === 'event') ingest(msg.event);
        else if (msg.kind === 'presence') handlePresence(msg.apps);
      } catch {}
    };
    ws.onclose = () => {
      $('dot').classList.remove('on');
      $('conn-text').textContent = 'reconnecting…';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }

  const controller = {
    start,
    ingest,
    clearAll,
    setActive,
    setFilter,
    // introspection for tests
    get active() { return active; },
    get events() { return events; },
    get flowList() { return flowList; },
    set flowList(v) { flowList = v; },
    get flowDetail() { return flowDetail; },
    set flowDetail(v) { flowDetail = v; },
    get mockState() { return mockState; },
    set mockState(v) { mockState = v; },
    loadMock,
    toggleFlowMock,
    toggleCallMock,
    stopMock,
    saveFlow,
    removeFlow,
    get appsConnected() { return appsConnected; },
    get stateAdapter() { return stateAdapter; },
    get statePaused() { return statePaused; },
    fullRender,
    copyFrom,
    handleInfo,
    handlePresence,
    renderSetup,
    selectStateAdapter,
    selectStateEvent,
    goLiveState,
    togglePause,
  };
  return controller;
}
