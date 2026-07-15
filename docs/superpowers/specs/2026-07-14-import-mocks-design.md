# Design: Import api-mapper mocks as a Rebynx flow

**Date:** 2026-07-14
**Status:** Approved

## Problem

Teams keep a mock set in the api-ui-mapper format — a file like
`.api-mapper-mocks.json`, a map of `{ [path]: { endpoint, statusCode, resBody } }`
(`resBody` is a JSON string; there is **no method** and no request body). Rebynx
already exports the other way (`flowToMockOverrides` in api-ui-mapper). This adds
the **import** direction: load such a file into Rebynx as a flow so its mock
server can serve those responses.

## Conversion — `packages/server/src/flows.ts`

`mocksToFlow(mocks, name)` (pure): a mock map → `Flow { name, calls }`. For each
entry (skipping non-object / endpoint-less ones), one `FlowCall`:

- `seq`: 1-based index
- `method`: `'GET'` — the file has none; the matcher's path-only fallback (below)
  makes it answer any method
- `url`: `entry.endpoint` (or the map key)
- `status`: `parseInt(entry.statusCode, 10) || 200`, `ok`: `status < 400`
- `request`: `{ headers: {}, body: null }`
- `response.body`: `JSON.parse(entry.resBody)` when it parses, else the raw
  `resBody` string (mirrors how the mock serves strings verbatim)

Mirrors `flowToMockOverrides` in reverse.

## Endpoint — `packages/server/src/server.ts`

`POST /flows/import` — body `{ name, mocks }`. Validate `mocks` is an object and
`name` is a non-empty string (else 400), `mocksToFlow` → `saveFlow` → 201 with the
flow. Handled in `handleFlows` alongside the other `/flows` routes.

## Matcher path-only fallback — `packages/server/src/mock.ts`

`matchCall` currently keys on `METHOD path`. Add a fallback: when there is no
exact `METHOD path` route, match **any route whose path equals the request path**
(any method) — imported mocks (stored as `GET`) then answer `POST`/`PUT`/… too,
matching how api-mapper serves by path only. An exact `method + path` route always
wins, so captured flows are unaffected. The per-key cursor still drives sequence
replay on whichever key matched.

## Client — `packages/server/public/app.js` + `index.html`

An **Import mocks** button in the Flows list. Clicking it opens a hidden
`<input type="file" accept="application/json,.json">`. On a file being chosen:
read it (`FileReader`/`file.text()`), `JSON.parse`, `askName` pre-filled with the
file's base name, then `POST /flows/import` with `{ name, mocks }` and reload the
list. A parse/HTTP error shows an `alert`. The imported flow then behaves like any
other — toggle **Serve as mock** to serve it.

## Testing (TDD)

- **`flows.test.ts`** — `mocksToFlow` maps status/url/body, `JSON.parse`s a
  JSON-string `resBody` (and keeps a non-JSON `resBody` as a string), skips
  malformed entries, and numbers `seq`.
- **`mock.test.ts`** — a route imported as `GET /x` answers a `POST /x` request
  (path-only fallback); an exact `POST /x` route still wins over a `GET /x` one.
- **`server.test.ts`** — `POST /flows/import` creates and persists a flow whose
  calls come from the mock map; a non-object `mocks` → 400.
- **`app.test.js`** — the Flows list renders an Import button; `importMocks(name,
  mocks)` posts `{ name, mocks }` to `/flows/import` and refreshes.

## Out of scope (YAGNI)

Guessing the method from the endpoint; merging into an existing flow; importing a
request body (the format has none); importing several files at once; a reverse
"export to api-mapper file" button (already covered by the flow Export).
