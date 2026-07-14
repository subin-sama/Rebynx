# Design: State tab — "Current" combined view

**Date:** 2026-07-14
**Status:** Approved

## Problem

The State tab is a timeline: one row per state event, each hiding its snapshot
behind a `<details>`. To see the whole current data tree you must find the latest
action and expand it. Add a **Current** view that shows the latest state of every
store merged into one tree, so all the data is visible at once. Make it the
default; keep the timeline behind a toggle.

Each state event is `{ type:'state', store, action?, state }` where `state` is the
store's full snapshot (for Redux, the combined root reducer). "Current" = the most
recent `state` per `store`.

## UI

The State tab gains a toggle at the top: **[Current] [Timeline]** (same styling as
the Setup adapter picker). `stateView` defaults to `'current'`.

- **Current**: one syntax-highlighted, copyable `jsonBlock('current state', {…})`
  where the object is `{ [store]: latestState }` for every store seen. Updates
  live as state events arrive. Empty → "no state yet — wire a store adapter (see
  Setup)".
- **Timeline**: the existing per-action rows (unchanged).

## Client changes — `packages/server/public/app.js`

- State: `let stateView = 'current';` and `const latestState = {}`.
- `ingest`: for `e.type === 'state'`, set `latestState[e.store] = e.state`
  (regardless of the active tab, so switching to State later is up to date).
- `clearAll`: also reset `latestState` (delete all keys).
- `fullRender`: when `active === 'state'`, delegate to `renderStateTab()`:
  - renders the toggle, then either the current tree, or
    `<div class="state-rows">…rowState()…</div>` for the timeline.
- `liveRow`: 
  - `active === 'state' && stateView === 'current'` → on a state event, re-render
    just the current tree (`jsonBlock` of `latestState`); return.
  - Timeline mode: append into the tab's row container. To coexist with the
    always-present toggle, state rows live in a `.state-rows` child; append + the
    MAX_EVENTS cap operate on that child (other tabs keep appending to `#main`).
    The `#main` element remains the scroll container for near-bottom autoscroll.
- Toggle click (`.state-view-opt`) in the `#main` delegated handler → set
  `stateView`, re-render the State tab.

Bounded by the existing `MAX_EVENTS` cap; the Current view is a single tree, so it
is cheap to (re)render even for a chatty store.

## Testing — `packages/server/src/app.test.js` (happy-dom)

- Default `stateView` is `'current'`; the State tab shows a `current state` block.
- Two stores (e.g. `redux`, `cart`) → Current shows both latest states merged; a
  newer event for a store replaces its value.
- Toggling to Timeline shows per-action rows; back to Current shows the tree.
- `clearAll` empties the current tree.

## Out of scope

Diffing between actions, time-travel, editing state.
