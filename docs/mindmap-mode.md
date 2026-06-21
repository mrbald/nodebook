# Mindmap mode — design

> **The map is a *view* of the index, not a document you draw.** Nodes are notes;
> edges are triples; both already exist in the index. The user never creates a
> node or drags an edge — their entire job is **curation**: choose the focus,
> filter relations, prune noise, pin landmarks. Layout happens automatically.
> Editing the *map* means editing the *notes*.

This is the inverse of most tools, and it's right for Nodebook because the graph
is already a byproduct of writing: every `[[link]]` and `key:: value` is already
a triple. Asking the user to *also* lay out a canvas would duplicate that work
and create a second source of truth — violating the project's "never a second
source of truth" discipline. Deriving the map keeps it in sync for free.

## Prior art (and where it falls short of "manage, not draw")

- **Obsidian Graph View** — auto-derived (good) but a read-only, untyped
  hairball; can't curate or save a focused subgraph. Nodebook's typed triples
  let us render colored/labeled edges by relation — strictly better.
- **Obsidian Canvas** — 100% manual draw-and-drag, disconnected from the link
  graph. Exactly what we are *not* building.
- **Roam / Logseq** — read-only overview graphs; Logseq's *local* graph (neighbors
  of the current page) is the good idea worth borrowing as the default view.
- **Tinderbox** — powerful manual maps with rule-based "agents" that auto-populate
  — closest to "managed," but draw-first with a steep cliff. We want automation to
  be the default, not an expert add-on.
- **TheBrain** — focus + auto-radial-layout + typed relations + click-to-refocus.
  The best single reference for Nodebook's mode; its shortfall is you still build
  the brain by hand. **Nodebook = TheBrain's focus-centric auto-layout, but the
  brain is already harvested from your notes.**

## Where it lives in the UI

A graph is *cross-note*; the Code/Live/Reading modes are *per-note* text
rendering — so mindmap is **not** a fourth editor mode (that would overload one
control with two altitudes). Instead it's a workspace view that takes over the
center pane (where `MapView` already renders `.map.md`), with two entry points:

- **Local map of the current note** (the common, high-value one) — a button in the
  note status bar / backlinks header: "Focus this note in the map."
- **Global map** — a button in the sidebar header; whole-vault overview.

The left sidebar (tree/search) stays as the way back to text. The **right panel
becomes the curation/inspector** (relation filters, pins, selected-node details)
— this is where "manage, not draw" lives.

## How the graph is built (no new source of truth)

One read-only IPC method, `index:graph`, returns a slice from the existing
`files` + `triples` tables. The renderer never writes graph data back.

- **Nodes** = notes (`files`) ∪ distinct triple objects with no file yet (the
  "ghost" links — render dimmed; they're a real "referenced but not created"
  signal). Name→file resolution reuses the same resolver `App.openLink` uses
  (lift it to a shared helper so the map and editor agree).
- **Edges** = triples, `(subject) --relation--> (object)`. Render **color/label by
  relation** (`links_to` neutral; typed relations get accent colors) — the asset
  no competitor has because none harvest typed triples into a queryable store.
- **Scoping** (cheap with the existing `idx_triples_*` indexes): global (all,
  capped); local (BFS from a focus note to depth *d*); by-relation
  (`WHERE relation IN (...)`).
- **Sync**: subscribe to the same `vault:changed` signal the tree uses; on save,
  triples are delete-then-inserted and the affected slice re-queries. The map is
  a pure function of the index, so it can't drift.

## Auto-layout

- **Default = focus-centric radial / force-directed** (TheBrain-style): focused
  note pinned center, neighbors ringed by depth. Force-directed for global, radial
  for local.
- **Stability over optimality**: seed each relayout from previous positions and
  relax — unchanged nodes barely move, so it stays "your" map. Pinned nodes are
  fixed anchors.
- **Scale guard**: global view defaults to the most-connected subset (top-N hubs)
  with a "showing N of M — expand" affordance; zero/empty states prompt the user
  to add a `[[link]]` or `key:: value`.

## What the user manages (the curation layer — this is the product)

All are **view state** over a derived graph, never geometry edits:

1. **Focus / expand / collapse** — click a node to recenter; expand pulls the next
   depth ring. Navigation, not editing.
2. **Relation filter** — a checklist of relation types; toggle to see different
   *lenses* of the same knowledge. The single most valuable thing typed triples
   unlock.
3. **Pin / unpin** — keep landmarks anchored across refocus/relayout.
4. **Hide / mute** — drop a noisy hub or relation per-view; reversible and listed
   (never *silently* gone).
5. **Promote / demote** — adjust salience (size/label); default size by degree.
6. **Relation-typing bridge** — for an untyped `links_to` edge, "type this
   relation" in the inspector **edits the source note's `key:: value`** (atomic
   write → re-index → edge updates). Management acts on the notes, the source of
   truth — never a separate map file.
7. **Save view → a saved-view artifact** — serialize the curation (focus, filters,
   pins, derived hierarchy). **Note (see [state-and-scopes.md](state-and-scopes.md)):
   the hand-authored `.map.md` outline and generated saved-view *state* are two
   different things** with different round-trip rules — a regenerated view must never
   clobber a document the user hand-edits, so saved-view config is a *separate*
   artifact (frontmatter or a sibling `.view`), not an overwrite of `parseMap`'s
   outline. Hand-authoring still works; it's just no longer the only way to get a map.

## Why this is right (one paragraph)

The triple store is already built and indexed; the only thing missing is a surface
that treats it as the product. Every alternative either makes the user draw
(duplicating work, second source of truth) or renders a read-only hairball that
ignores the typed relations Nodebook uniquely has. "Derive + curate" costs the
user zero layout effort, stays in sync for free, exploits typed relations nobody
else renders, and keeps `.map.md` as a *saved* artifact rather than the *only*
map. It is the literal embodiment of "minimum draw, maximum manage."

See [ROADMAP.md](../ROADMAP.md) for the incremental implementation slices.
