# Design: Save Network as a Flow

**Date:** 2026-07-10
**Status:** Approved (Phase 1)

## Problem

While driving a React Native app on an emulator, a developer watches the live
network stream in the Rebynx browser client. Today those requests are ephemeral:
once you `Clear` or reload, the record of "what APIs did this user flow hit" is
gone. We want to **capture the network calls of a user flow and save them as a
named, persisted artifact** — a *flow* — recording each call's URL, request, and
response in order.

A saved flow serves three eventual uses (all sharing one stored format):

1. **Documentation / reference** — read back which APIs a flow calls. *(Phase 1)*
2. **Replay** — re-fire the captured requests. *(future)*
3. **Mock** — serve the captured responses for offline dev/test. *(future)*

This spec covers **Phase 1** only (capture → save → store → view), which fully
delivers use (1) and defines the shared JSON format that (2) and (3) build on.

## Scope

**In scope (Phase 1):**
- A stored *flow* format (JSON on disk, one file per flow).
- Server: REST endpoints to save / list / get / delete flows, backed by a
  disk-storage module.
- Browser client: a **Save flow** action (snapshot of the current Network tab)
  and a **Flows** tab to browse saved flows and their calls.
- Unit tests for the storage module.

**Out of scope (future phases):**
- Replay (server re-firing captured requests).
- Mock (server serving captured responses matched by `method + path`).
- Saving flows from the in-app RN overlay (Phase 1 is browser-client only).
- Flow diffing / regression testing.

## Recording model

**Snapshot of the whole Network tab.** The user's workflow:

1. `Clear` (start from a clean slate).
2. Drive the flow on the emulator; requests stream into the Network tab.
3. Click **Save flow**, give it a name.
4. The client snapshots *all* merged network rows currently held and POSTs them.

No explicit start/stop recording. Snapshot is simpler and matches how the client
already accumulates merged network rows (`netIndex`).

## Data model

A saved flow is one JSON file. `id` is the slug and the filename (`<id>.json`).

```jsonc
{
  "id": "checkout-flow",          // slug; also the filename
  "name": "Checkout Flow",        // human label as typed
  "createdAt": 1720000000000,     // Date.now() at save time (server-stamped)
  "notes": "",                    // optional free-text description
  "calls": [
    {
      "seq": 1,                   // 1-based order within the flow
      "method": "POST",
      "url": "https://api.example.com/cart/checkout",
      "status": 200,
      "ok": true,
      "duration": 234,
      "request":  { "headers": { }, "body": { } },
      "response": { "headers": { }, "body": { } }
    }
  ]
}
```

`method` + the **path** of `url` is the intended match key for future replay/mock
— captured deliberately so those phases need no format change. A `FlowCall` is
essentially a merged `NetworkEvent` (`start` + `end`) reshaped into
`request`/`response` sub-objects.

### Shared types

Add to `packages/core/src/types.ts` (the shared model home):

```ts
export interface FlowCall {
  seq: number;
  method?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  duration?: Millis;
  request:  { headers?: Record<string, string>; body?: unknown };
  response: { headers?: Record<string, string>; body?: unknown };
}

export interface Flow {
  id: string;
  name: string;
  createdAt: Millis;
  notes?: string;
  calls: FlowCall[];
}

/** Lightweight list item (no bodies). */
export interface FlowSummary {
  id: string;
  name: string;
  createdAt: Millis;
  count: number;
}
```

The server imports these type-only. The browser client is a single dependency-free
`index.html`, so it keeps its own inline shape (mirroring how it already inlines
`PLUGINS`).

## Server

### Storage module — `packages/server/src/flows.ts` (new)

Pure-ish functions over a directory, isolated from HTTP so they can be unit-tested
with a temp dir:

- `slugify(name: string): string` — lowercase, non-`[a-z0-9]`→`-`, collapse/trim
  dashes. Empty result falls back to `flow`.
- `safeId(id: string): string | null` — return `id` only if it matches
  `^[a-z0-9-]+$` (no dots, no slashes); otherwise `null`. Guards path traversal.
- `saveFlow(dir, input: { name; notes?; calls }): Promise<Flow>` — slugify name to
  a base id; if `<base>.json` exists, append `-2`, `-3`, … until free; stamp
  `createdAt`; write pretty JSON; return the saved `Flow`.
- `listFlows(dir): Promise<FlowSummary[]>` — read `*.json`, return summaries
  (no bodies), newest `createdAt` first. Skips unreadable/malformed files.
- `getFlow(dir, id): Promise<Flow | null>` — `safeId` then read; `null` if missing.
- `deleteFlow(dir, id): Promise<boolean>` — `safeId` then unlink; `false` if absent.

Directory: `flows/` next to the server package, overridable via
`DEVTOOLS_FLOWS_DIR`. Created (recursive) on startup.

### HTTP routes — `packages/server/src/index.ts`

Add a small `readJsonBody(req): Promise<unknown>` helper (the HTTP server does not
parse bodies today) and route these **before** the static-file handler:

| Method + path      | Behavior                                                        |
| ------------------ | --------------------------------------------------------------- |
| `GET /flows`       | `200` → `FlowSummary[]`                                          |
| `GET /flows/:id`   | `200` → `Flow`; `404` if unknown / bad id                       |
| `POST /flows`      | body `{name, notes?, calls}`; `400` if no `name` or bad JSON; `201` → saved `Flow` |
| `DELETE /flows/:id`| `204` on delete; `404` if absent / bad id                       |

Routing stays thin: parse the path, call the storage module, serialize the result.

## Browser client — `packages/server/public/index.html`

### Save flow

- A **Save flow** button, always visible in the header. It snapshots all merged
  network rows regardless of which tab is active.
- On click: if there are no network rows, alert and stop. Otherwise `prompt` for a
  name, build `calls` from the merged network rows (`netIndex` values, in insertion
  order → `seq`), reshape each into `{method, url, status, ok, duration, request,
  response}`, `POST /flows`, then confirm success (e.g. transient message) or show
  the error.

### Flows tab

- Add `Flows` as a fifth tab. It is **special** — not an event filter — so it is
  handled outside the `PLUGINS.accepts` model:
  - Activating the tab calls `GET /flows` and renders the list
    (name · time · call count · **Delete**).
  - Clicking a flow calls `GET /flows/:id` and renders its calls reusing the
    existing `rowNet` style (method / status / url, with request+response inside a
    `<details>` block).
  - **Delete** calls `DELETE /flows/:id` and refreshes the list.
- The existing tab click handler and `render()` branch on `active === 'flows'` to
  route to the flows view instead of the event-list view.

## Error handling

- `POST /flows` with missing/blank `name` → `400`.
- Malformed JSON body → `400`.
- Empty `calls` → allowed by the server, but the client warns before sending.
- `GET`/`DELETE` with an id failing `safeId`, or a missing file → `404`.
- Unexpected fs errors → `500`.
- Path traversal blocked by `safeId` (allow only `[a-z0-9-]`).
- Duplicate names never overwrite — id is suffixed (`-2`, `-3`, …).

## Testing

- **`packages/server/src/flows.test.ts`** (vitest) against a temp dir:
  - `saveFlow` writes a file, stamps `createdAt`, returns the slugged id.
  - Duplicate name → suffixed id, no overwrite.
  - `listFlows` returns summaries (no bodies), newest first, skips malformed files.
  - `getFlow` round-trips a saved flow; unknown id → `null`.
  - `deleteFlow` removes the file; absent → `false`.
  - `safeId` rejects `../`, slashes, dots; `slugify` handles spaces/unicode/empty.
- HTTP routing stays thin enough to verify manually (curl) + by driving the client.

## Future hooks (documented, not built)

- **Replay:** `POST /flows/:id/replay` → server fires each `call` in `seq` order
  using `method` + `url` + `request`, returns per-call results.
- **Mock:** a mock mode where the server matches an incoming `method` + path
  against a flow's `calls` and returns the saved `response`.

Both consume the Phase 1 format unchanged.
