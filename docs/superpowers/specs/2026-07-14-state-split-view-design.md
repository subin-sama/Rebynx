# Design: State tab — left/right split (replaces the Current/Timeline toggle)

**Date:** 2026-07-14
**Status:** Approved

## Problem

The State tab hides its two useful views (action timeline vs current combined
state) behind a Current/Timeline toggle — awkward to work with. Replace the toggle
with a permanent **left/right split**: the action timeline on the left, the state
tree on the right (Redux-DevTools style), both visible at once.

## Layout

`#main` for the State tab becomes a two-pane flex row that fills the height:

- **Left — timeline** (`~38%`, scrolls): a compact, clickable row per state event
  (`ts · store · action`). Newest appended at the bottom; auto-scrolls when the
  user is already at the bottom. The selected row is highlighted.
- **Right — state tree** (flex, scrolls):
  - **No selection (default):** the **current** merged state `{ [store]: latest }`,
    live-updating, with a **⏸ Pause / ▶ Resume** button to freeze it while reading.
  - **An action selected:** that event's `state` snapshot (inherently frozen), with
    a **← Live** button to deselect and return to the live current view.

Selecting a past action naturally solves the "streams too fast to read" problem —
the snapshot is static.

## Client changes — `packages/server/public/app.js`

Replaces the `stateView` toggle (`renderStateTab`/`stateToggle`). Keep
`latestState`, `statePaused`, `currentStateHtml`.

- State: drop `stateView`; add `let selectedState = null` (the selected event or
  null for live).
- `renderStateTab()`: render `.state-split` → `.state-left` (timeline) +
  `.state-right` (detail); call `renderStateTimeline()` + `renderStateDetail()`.
- `renderStateTimeline()`: rows for `events.filter(state & matches)`, capped;
  highlight the selected one.
- `renderStateDetail()`: selection → snapshot + "← Live"; else current tree +
  Pause.
- `liveRow` (state): append the new row to `.state-left` (bounded by `MAX_EVENTS`,
  autoscroll if near bottom); if live (`!selectedState`) and not paused, refresh
  `.state-right`; if a past action is selected, leave the right pane untouched.
- Click handlers in `#main`: `.state-item` → select that event (by `data-sid` =
  event id) + re-render detail + re-highlight; `.state-live` → clear selection,
  re-render detail; `.state-pause` → toggle pause.
- `clearAll`: also clears `selectedState`.

## CSS — `index.html`

`.state-split { display:flex; height:100%; }`, `.state-left` (fixed width, right
border, `overflow:auto`), `.state-right { flex:1; overflow:auto; }`,
`.state-item` (compact clickable row) + `.state-item.sel` (accent highlight),
`.state-detail-bar` / `.state-live`. Reuse existing `.state-pause`, `.json-block`,
`.ts/.store-tag/.action-tag`.

## Testing — `packages/server/src/app.test.js`

- State tab renders a split (`.state-left` + `.state-right`), no Current/Timeline
  toggle.
- Left shows a row per state event; right defaults to the live current merged tree.
- Clicking a left row shows that event's snapshot on the right; "← Live" returns to
  the current tree.
- A new event while an action is selected doesn't change the right pane; while live
  (not paused) it updates; Pause freezes it.
- `clearAll` empties both panes.

## Out of scope

Real time-travel (dispatching to move the app's state), diffing between actions.
