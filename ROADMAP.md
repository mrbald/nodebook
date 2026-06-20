# Nodebook roadmap

Distilled from a pre-release frontend + UX review. Ordered by priority.
Items marked ✅ are already done.

## Pre-1.0 hardening

- ✅ **Path-traversal guard** on `file:read`/`file:save` IPC (`isAccessibleFile`).
- ✅ **Data-loss on quit** — flush a dirty buffer on close regardless of the
  autosave-on-switch setting.
- ✅ **Version + release gate** — `package.json` at `0.1.0`; release workflow
  verifies the tag matches the version and runs typecheck + unit tests.
- **Accessibility** (next, high value, ~6 small components):
  - Focus-trap + restore + `role="dialog"` for `Prompt`/`Confirm`/`ContextMenu`/
    `StatusSelect` (a shared `useModal` hook).
  - Keyboard operability: `role`/`tabIndex`/Enter on file-tree rows, search
    results, context-menu items, backlink/map links.
- **Error/empty states** — handle a failed vault open / index build; `file:read`
  on a missing file should not surface a raw rejection.
- **CI lint** — add a `lint` script and run it in CI (ESLint is configured but
  unscripted).
- Minor: drop the `undefined!` non-null assertions on `mainWindow` in dialogs;
  confirm `@codemirror/legacy-modes` is actually used (drop if dead).

## Surface the knowledge graph (the differentiator)

The triple store (`subject, relation, object`) is the product's edge, but it's
barely visible in the UI today.

- **Slice 0 — Outbound/Properties panel.** `index:outbound`
  (`SELECT object, relation FROM triples WHERE source_file = ?`) → show the
  current note's *outbound* links and `key:: value` properties next to Backlinks.
  One query + one panel section; do this even if mindmap slips.
- **Onboarding/empty state** that introduces `[[links]]`, `key:: value`,
  backlinks, and maps.

## Mindmap mode — "manage, don't draw"

Full design in [docs/mindmap-mode.md](docs/mindmap-mode.md). Philosophy: the map
is a **view of the index**, auto-laid-out from notes + links + triples; the user
**curates** (focus, filter by relation, pin, hide, promote) rather than drawing
nodes or dragging edges. Editing the map means editing the notes.

Incremental slices (each independently shippable):

1. **Read-only local map (MVP)** — `index:graph` returns a depth-1 slice around a
   focus note; a `GraphView` renders force/radial layout with edges colored by
   relation; entry from the note status bar; live re-query on `vault:changed`.
2. **Curation** — relation filter (the killer feature the typed triples unlock),
   focus/expand/collapse, stable relayout (seed from previous positions).
3. **Pin / hide / promote + global map** — view-state curation; degree-threshold
   scale guard + "showing N of M" + empty states.
4. **Save view → `.map.md`; relation-typing bridge** — "Save view" writes a
   `.map.md` snapshot (reuses `parseMap`/`MapView`); inspector "type this
   relation" edits the source note's `key:: value` and re-indexes.
5. **Polish** — edge labels/legend per theme, hover preview, ⌘G/View-menu entry,
   large-vault perf (Barnes-Hut, culling).

## Other post-1.0

- **Settings UI** — replace (or supplement) the raw-TOML editor with a form.
- **Quick-open / command palette** (⌘P).
- **Structured search** — query the triple store (e.g. `status:: active`,
  notes linking to `[[X]]`).
- Unify the two divergent "collapsible tree" styles (file tree vs. map).
- Auto-update via `electron-updater` + the GitHub Releases feed.
- App icons under `build/` (`icon.icns`/`icon.ico`/`icon.png`).
