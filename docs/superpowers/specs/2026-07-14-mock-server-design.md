# Design: Mock API server from saved flows

**Date:** 2026-07-14
**Status:** Approved

## Problem

Rebynx can already capture network traffic and save it as a named **flow**
(`flows/<id>.json`, one `FlowCall` per request with method/url/status/request/
response). CLAUDE.md notes the format is "designed to also feed future replay +
mock." This adds that: **replay saved traffic as a real HTTP API** so an app can
point its base URL at it and get the recorded responses back — for offline dev,
reproducing a captured scenario, and demos.

The mock must be composable at **two granularities**: a whole flow, and
individual API calls (picked from a flow's detail). Both feed one shared mock.

## Run model

A second `http.Server` runs **in the same process as the relay** on port
**9091** (relay port + 1; override with `DEVTOOLS_MOCK_PORT`). The desktop app
picks this up unchanged — the mock lives inside `createRelayServer()`. The app
under test sets its base URL to `http://<LAN-IP>:9091`.

Controlled entirely from the browser client's **Flows tab** (no terminal), which
matches the Reactotron-style UX: toggles start/stop mocking and the client shows
the mock URL to copy.

## Mock registry — the composable set

The relay holds an in-memory registry of what is currently mocked:

- `enabledFlows: Set<flowId>` — whole flows
- `enabledCalls: Set<"flowId#seq">` — individual calls

**Effective routes** are rebuilt on every change: load each enabled flow's calls,
add each enabled individual call, **dedupe by `flowId#seq`** (so enabling a flow
and one of its calls doesn't double-count), then group by `METHOD path` into an
ordered list — the **sequence** for that endpoint. Enabled flows contribute in
enable order (calls by `seq`); individually-enabled calls append after.

The mock server **runs whenever ≥1 source is active** and stops when the registry
empties or the user hits Stop. Rebuilding reads flows from disk (they are small);
a flow deleted while mocked is simply skipped on the next rebuild.

**Conflict = sequence merge** (decided): if a whole flow and an individual call
both define `GET /profile`, their responses concatenate into one sequence rather
than one overriding the other. The user composes the set they want.

## Matching & replay — `packages/server/src/mock.ts` (pure core + server)

`matchCall(routes, method, pathname, cursor)` — pure. `routes` is the grouped map
`{ "METHOD path": FlowCall[] }`. Match by **method + path only** (query and host
stripped). `cursor` is a `Map<key, number>`: each hit returns the call at the
cursor and advances it, **clamping at the last** — so an endpoint called N times
in the flow replays its N responses in order, then repeats the final one. Returns
`null` when no route matches the key.

`createMockServer(getRoutes)` → `http.Server`. `getRoutes()` is a callback
returning the current route map, so the registry can change **without restarting**
the server. Per request:

- `OPTIONS` → `204` with permissive CORS headers (preflight).
- Match via `matchCall`; on hit write the saved `status`, the saved `response.headers`
  **minus `content-length` / `content-encoding` / `transfer-encoding`** (recomputed),
  and the `response.body` (object → `JSON.stringify`, string → as-is). Always add
  permissive CORS (`access-control-allow-origin: *`). Default `content-type:
  application/json` when the saved call had none.
- No match → `404` with a JSON hint `{ error, method, path, hint }`.

Kept free of relay/registry concerns so it unit-tests against a temp routes map.

## Control endpoints — `packages/server/src/server.ts`

`createRelayServer` gains a `MockController` closure holding the registry, the
mock `http.Server | null`, and the port. New routes (handled before `/flows`):

- `POST   /mock/flow/:id`            → enable a whole flow
- `DELETE /mock/flow/:id`            → disable a whole flow
- `POST   /mock/call/:flowId/:seq`   → enable one call
- `DELETE /mock/call/:flowId/:seq`   → disable one call
- `DELETE /mock`                     → stop + clear the whole registry
- `GET    /mock`                     → status

`GET /mock` returns:
```json
{ "active": true, "port": 9091, "url": "http://<LAN-IP>:9091",
  "flows": ["login-happy"], "calls": ["checkout#3"],
  "endpoints": [ { "method": "GET", "path": "/v1/profile", "count": 2 } ] }
```
Any mutating route rebuilds the effective routes and starts/stops the mock server
as needed, then returns the same status shape. Enabling a missing flow/call →
`404`. Mock port is `opts.mockPort ?? Number(process.env.DEVTOOLS_MOCK_PORT) ?? 9091`.

## Client — `packages/server/public/app.js` + `index.html`

- **Flows list:** each row gets a **Serve as mock** toggle (whole flow); the row
  is highlighted while that flow is enabled.
- **Flow detail:** each call row gets a **Mock** toggle (individual call);
  enabled calls are highlighted.
- **Mock banner** at the top of the Flows tab (list and detail): shown when the
  mock is active — the copyable base URL `http://<LAN-IP>:9091`, the count of
  active endpoints, and a **Stop** button (calls `DELETE /mock`).
- Entering the Flows tab does `GET /mock` to sync toggle/banner state; each toggle
  POSTs/DELETEs then refreshes from the returned status.

Reuses existing chrome: `.flow-row`, `.json-block`/copy for the URL, the Setup
tab's connect-URL styling for the banner.

## Testing (TDD)

- **`mock.test.ts`** — `matchCall`: matches by method+path, advances the cursor
  through repeated calls, clamps on the last, returns null on no match, ignores
  query. `createMockServer`: boot on an ephemeral port, `fetch` a mocked path →
  saved status + body; second identical request → next response in sequence; an
  unknown path → 404; `OPTIONS` → 204 + CORS; route map swapped live via the
  callback takes effect without restart.
- **`server.test.ts`** — `POST /mock/flow/:id` then `GET /mock` lists that flow's
  endpoints; `POST /mock/call/:flowId/:seq` enables just that one; `DELETE`
  variants remove; `DELETE /mock` clears and reports `active:false`; enabling a
  missing flow → 404.
- **`app.test.js`** — a Flows row renders the Serve toggle and clicking it hits
  `POST /mock/flow/:id`; the detail view renders per-call Mock toggles hitting
  `/mock/call/...`; when status is active the banner shows the URL + endpoint
  count + Stop.

## Out of scope (YAGNI)

Simulated latency from the saved `duration`; matching on request body or query;
per-call override instead of sequence merge; editing individual response fields;
persisting the mock registry across a relay restart; serving mocks over HTTPS.
