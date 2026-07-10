// Rebynx browser client — served statically (no build step), also imported by
// app.test.ts. Zero side effects on import: index.html calls createApp().start().

export const PLUGINS = [
  { id: 'logs', label: 'Logs', accepts: (e) => e.type === 'log' },
  { id: 'network', label: 'Network', accepts: (e) => e.type === 'network' },
  { id: 'state', label: 'State', accepts: (e) => e.type === 'state' },
  { id: 'inspect', label: 'Inspect', accepts: (e) => e.type === 'inspect' },
];

export const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const time = (ts) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');

/** Pretty-print a value as JSON with lightweight token colouring. */
export function syntaxHighlight(value) {
  const json = JSON.stringify(value, null, 2);
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

  let active = 'logs';
  let filter = '';
  const events = [];
  const netIndex = new Map(); // reqId -> merged network row (data)
  const netNodes = new Map(); // reqId -> row element (DOM), for in-place updates
  let flowList = [];
  let flowDetail = null;
  let ws;

  const matches = (e) => !filter || JSON.stringify(e).toLowerCase().includes(filter);

  function renderTabs() {
    const pluginTabs = PLUGINS.map((p) => {
      const n = events.filter((e) => p.accepts(e)).length;
      return `<div class="tab ${p.id === active ? 'active' : ''}" data-tab="${p.id}">${p.label} <span class="count">${n}</span></div>`;
    }).join('');
    const flowsTab = `<div class="tab ${active === 'flows' ? 'active' : ''}" data-tab="flows">Flows <span class="count">${flowList.length}</span></div>`;
    $('tabs').innerHTML = pluginTabs + flowsTab;
  }

  // Full rebuild of #main for the active tab. Used on tab switch / filter /
  // clear / flow nav — NOT on every incoming event (that's what append is for).
  function fullRender() {
    renderTabs();
    if (active === 'flows') return renderFlows();
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
    if (active === 'flows') return;
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
    }

    if (nearBottom) el.scrollTop = el.scrollHeight;
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
    renderTabs();
    liveRow(row);
  }

  function clearAll() {
    events.length = 0;
    netIndex.clear();
    netNodes.clear();
    flowDetail = null;
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
    const name = prompt(`Save ${calls.length} network call(s) as a flow named:`);
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
    fullRender();
  }

  async function openFlow(id) {
    try { flowDetail = await (await fetch('/flows/' + encodeURIComponent(id))).json(); }
    catch { flowDetail = null; }
    fullRender();
  }

  async function removeFlow(id) {
    if (!confirm('Delete this flow?')) return;
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

  function renderFlows() {
    if (flowDetail) return renderFlowDetail();
    const el = main();
    if (!flowList.length) {
      el.innerHTML = `<div class="empty">no saved flows yet — Clear, drive a flow, then “Save flow”</div>`;
      return;
    }
    el.innerHTML = flowList.map((f) => `
      <div class="row flow-row" data-id="${esc(f.id)}">
        <span class="ts">${time(f.createdAt)}</span>
        <span class="flow-name">${esc(f.name)}</span>
        <span class="url"><span class="count">${f.count} call${f.count === 1 ? '' : 's'}</span></span>
        <button class="flow-export" data-id="${esc(f.id)}">Export</button>
        <button class="flow-del" data-id="${esc(f.id)}">Delete</button>
      </div>`).join('');
  }

  function renderFlowDetail() {
    const f = flowDetail;
    const calls = f.calls || [];
    const body = calls.map((c) => {
      const statusCls = c.ok ? 'ok' : c.status ? 'err' : 'pending';
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
      </div>`;
    }).join('');
    main().innerHTML = `
      <div class="flow-head">
        <button class="flow-back">← Flows</button>
        <span class="flow-name">${esc(f.name)}</span>
        <span class="count">${calls.length} call${calls.length === 1 ? '' : 's'} · ${time(f.createdAt)}</span>
      </div>${body || '<div class="empty">no calls in this flow</div>'}`;
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
      const copyBtn = ev.target.closest('.copy-btn');
      if (copyBtn) { ev.stopPropagation(); copyFrom(copyBtn); return; }
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
    fullRender,
    copyFrom,
  };
  return controller;
}
