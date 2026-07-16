# Design: Export log + API call-site (file / function / line)

**Date:** 2026-07-14
**Status:** Approved

Two features, independent of each other.

---

# A. Export log

Download the events of the **active tab**, honouring the current filter, as JSON.

## Client — `packages/server/public/app.js` + `index.html`

- An **Export** button in the header (next to Save flow / Clear), `id="export-log"`.
- `exportLog()`: resolve the active plugin (`PLUGINS.find(p => p.id === active)`);
  if there isn't one (Setup / Flows) `alert` that there's nothing to export and
  return. Otherwise collect `events.filter((e) => plugin.accepts(e) && matches(e))`
  — the same predicate the tab renders with, so the file matches what's on screen.
- Empty list → `alert('No <tab> events to export.')`.
- Download via Blob (same pattern as `exportFlow`): `JSON.stringify({ tab, exportedAt,
  count, events }, null, 2)`, filename `rebynx-<tab>-<ts>.json`; `flash()` on success.

## Testing — `app.test.js`

`exportLog` on the Logs tab collects only log events that match the filter; on
Setup it exports nothing. (Assert via an injected/collected payload rather than a
real download.)

---

# B. API call-site

Show **which file / function / line** issued each API call, and make it a
jump-to-code link.

## Capture — `packages/core/src/collectors.ts`

`installNetwork`'s XHR `open` patch records `new Error().stack` on the request's
meta and emits it as `stack?: string` on the network event (dev-only; creating an
Error per request is cheap). `NetworkEvent` gains `stack?: string`, plus
`source?: string | null` and `callFn?: string` which the relay fills in.

## Parse + symbolicate — `packages/server/src/symbolicate.ts` (new)

- `parseStack(stack): Frame[]` where `Frame = { methodName, file, lineNumber, column }`.
  Handles the three formats seen in the wild:
  - V8: `at fn (file:line:col)` and `at file:line:col`
  - Hermes: `at fn (address at file:line:col)`
  - JSC/Hermes: `fn@file:line:col`
- `firstAppFrame(frames): Frame | null` — skips frames whose file matches
  `node_modules`, `rebynx`, `react-native/Libraries`, `[native code]`,
  `InternalBytecode`; returns the first remaining frame (else the first frame).
  This is what steps over axios/fetch wrappers to reach the app's own code.
- `symbolicate(frames, metroUrl, timeoutMs)` — POST `${metroUrl}/symbolicate` with
  `{ stack: frames }`; returns the symbolicated frames, or `null` on error/timeout
  (Metro not running ⇒ degrade, never throw).

## Relay — `packages/server/src/server.ts`

`RelayOptions.metroUrl` (default `process.env.DEVTOOLS_METRO_URL` or
`http://localhost:8081`). A `resolveCallSite(stack)` closure: `parseStack` →
`firstAppFrame` → `symbolicate`, memoised in a `Map` keyed by
`file:line:column` so a repeated call site never re-POSTs.

On a `network` event carrying a `stack`, the relay **broadcasts immediately** (no
added latency, no reordering), then asynchronously resolves the call site and, on
success, mutates the ring's event object (`source = "file:line"`, `callFn`) and
re-broadcasts that same event. The browser client already merges network events by
`reqId` and patches the row in place, so the call site simply appears on the row a
moment later.

## Client — `packages/server/public/app.js`

`rowNet` renders the call site when `e.source` is set: the function name plus
`srcLink(e.source)` — which already emits a `.src` element wired to
`GET /open?file=&line=`, so clicking jumps to the exact line in the editor.

## Testing (TDD)

- **`symbolicate.test.ts`** — `parseStack` handles all three formats (and ignores
  junk lines); `firstAppFrame` skips node_modules/rebynx/RN-internal frames and
  returns the app frame; `symbolicate` posts the frames and maps the response,
  returns `null` when the endpoint errors or times out.
- **`server.test.ts`** — a network event with a stack is broadcast, then a second
  message for the same `reqId` arrives carrying `source`/`callFn` (Metro stubbed);
  with Metro unreachable, the event still relays once and never throws.
- **`collectors.test.ts`** — an XHR request emits a `stack` string on the event.
- **`app.test.js`** — a network row with `source` + `callFn` renders the function
  name and a `.src` link with the right `data-file` / `data-line`.

## Out of scope (YAGNI)

Symbolicating console/state events; showing the full stack (only the first app
frame); a UI to configure the Metro URL (env/option only); caching across restarts.

## Caveats

B captures on the RN side, so it needs a `core`+`rn` republish + app restart. It
also needs Metro running for real file/line; without it the event still relays,
just without a call site.
