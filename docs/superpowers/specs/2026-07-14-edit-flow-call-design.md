# Design: Edit a saved call's payload / response / status

**Date:** 2026-07-14
**Status:** Approved

## Problem

Saved flows feed the mock server. To shape a mock into the scenario you want
(change a value, flip a flag, simulate an error code) you must be able to edit a
captured call. Add in-place editing of a call's **request body (payload)**,
**response body**, and **status** in the flow detail view. Headers, url, and
method stay as captured.

Because the mock server reads flows from disk on (re)build, an edit persisted to
`flows/<id>.json` is served by the mock — and the edit endpoint rebuilds the
mock routes so a running mock reflects the change immediately.

## Storage — `packages/server/src/flows.ts`

`updateCall(dir, id, seq, patch)` where `patch: { requestBody?, responseBody?, status? }`:

- Load the flow (via `getFlow`); return `null` if the id or `seq` is unknown.
- Apply only the provided fields: `requestBody` → `call.request.body`,
  `responseBody` → `call.response.body`, `status` (a number) → `call.status` and
  recompute `call.ok = status < 400`. Presence is checked with `in` so a body can
  be set to `null`.
- Write the flow back (same pretty-JSON format) and return the updated `Flow`.

## Endpoint — `packages/server/src/server.ts`

`PATCH /flows/:id/calls/:seq`:

- Parse the JSON body (400 on invalid), call `updateCall`, return the updated flow
  (200) or `{ error: 'not found' }` (404).
- If the mock registry is non-empty, call `rebuildRoutes()` afterwards so a live
  mock serves the edited call without a re-toggle.

Handled by a closure inside `createRelayServer` (it needs `rebuildRoutes`),
wired into the request chain before `handleFlows`.

## Client — `packages/server/public/app.js` + `index.html`

In the flow **detail** view, each call row gets an **Edit** button. State
`editingCall` holds the `seq` currently being edited (one at a time).

- Editing a call replaces its read-only Request/Response panels with an editor:
  a `status` `<input>`, a **payload** `<textarea>` and a **response body**
  `<textarea>` (both pretty-printed JSON), plus **Save** / **Cancel**.
- **Save**: `JSON.parse` each textarea; on a parse error show an inline message and
  do not send. Otherwise `PATCH /flows/:id/calls/:seq` with
  `{ requestBody, responseBody, status }`, then reload the flow (`openFlow`) and
  clear `editingCall`; a flash confirms.
- **Cancel**: clear `editingCall` and re-render (discards changes).

## Testing (TDD)

- **`flows.test.ts`** — `updateCall` edits the response body, request body, and
  status; recomputes `ok`; persists to disk; returns `null` for an unknown id or
  seq; leaves other calls untouched.
- **`server.test.ts`** — `PATCH /flows/:id/calls/:seq` returns the updated flow;
  after enabling the flow as a mock and PATCHing a response body, the mock server
  serves the **new** body; invalid JSON → 400; unknown seq → 404.
- **`app.test.js`** — clicking Edit shows the editor (status input + two
  textareas); Save posts `PATCH` with the parsed bodies + status; invalid JSON in
  a textarea shows an error and sends nothing.

## Out of scope (YAGNI)

Editing headers / url / method; adding or deleting calls; undo/history; a JSON
tree editor (plain textareas); editing multiple calls at once.
