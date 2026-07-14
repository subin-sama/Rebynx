# Design: State current view — JSON tree with change-flash + polish

**Date:** 2026-07-14
**Status:** Approved

## Problem

The live current-state pane is a flat `<pre>`. In a large state it's hard to spot
what a new action changed. Turn it into a collapsible JSON **tree** whose changed
nodes **flash** (and scroll into view) on each event, so the change is obvious.
Plus general UI polish + subtle animation.

## JSON tree — `packages/server/public/app.js` (pure, exported)

`jsonTree(obj)` renders `{ [store]: state }` as nested nodes. Each node carries a
`data-path` (dot notation, e.g. `redux.cart.total`) matching the paths `diffState`
produces, so a change can be located by selector.

- **Object** → collapsible `.jt-node.jt-obj` (a `.jt-branch` header row + a
  `.jt-kids` container that recurses). Clicking the header toggles `.collapsed`.
- **Array / primitive** → leaf `.jt-node.jt-leaf` whose value is `syntaxHighlight(value)`
  (arrays stay whole, matching `diffState`).

## Flash on change — `createApp`

- The live current pane renders `jsonTree(latestState)` (replacing the `<pre>`).
- On a state event, before overwriting `latestState[store]`, diff old→new and keep
  the changed paths **prefixed by the store** (`store` + `.` + `diffState` path) in
  `lastChangedPaths`.
- After `renderStateDetail()` re-renders the tree (live + not paused), call
  `flashChanges(lastChangedPaths)`: add `.flash` to each `[data-path]` node (a CSS
  background pulse that fades) and `scrollIntoView` the first one.
- Click on `.jt-branch` toggles collapse. (Re-render on each live event resets
  collapse; Pause freezes the pane for uninterrupted navigation.)
- The selected-action pane keeps its `diffState` "changes" block + snapshot.

## CSS — `index.html`

- `.jt-tree/.jt-node/.jt-branch/.jt-kids/.jt-caret/.jt-key/.jt-punc/.jt-leafval`
  (indent guide line, caret, monospace values, `white-space: pre-wrap` for arrays).
- `.jt-obj.collapsed > .jt-kids { display: none }`.
- `@keyframes jt-flash` (yellow → transparent) on `.jt-node.flash > .jt-row`.
- Polish: `@keyframes fade-in` on new `.state-item` rows; smooth `transition` on
  tab/hover/buttons; slightly refined spacing/borders.

## Testing — `packages/server/src/app.test.js`

- `jsonTree({ redux: { cart: { total: 250 } } })` contains `data-path="redux"`,
  `"redux.cart"`, `"redux.cart.total"`, and the highlighted value.
- Live view: after two state events that change a value, the changed node
  (`[data-path="redux.cart.total"]`) gains `.flash`; an unchanged node does not.
- Collapsing: the tree exposes `.jt-branch` toggles.

## Out of scope

In-place tree patching (we re-render live + rely on Pause), array element-level
diffing, virtualized rendering.
