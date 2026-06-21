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

## Knowledge features — committed vs research (read before building)

An independent spec review drew a firewall worth keeping explicit (see
[docs/state-and-scopes.md](docs/state-and-scopes.md)):

- **Committed / buildable now** — the **explicit-graph mindmap** (derive + curate
  from triples; live, deterministic) and the **already-shipped semantic search**.
  These rest on stable foundations and need no new persistent-state model.
- **Research / not committed** — the **cumulative body of knowledge**: entity
  resolution, canonical merges, and stable incremental graph updates
  ([docs/body-of-knowledge.md](docs/body-of-knowledge.md)), plus **distill→canonical
  merge** ([docs/distill-documents.md](docs/distill-documents.md)). These need a
  durable-decision model, explicit scopes, a commit protocol, and scale targets
  pinned down *first*. Distill's standalone (`distill-staged`) path is buildable;
  the merge-into-canonical path is not, yet.

Net: build the mindmap + lean on shipped search; treat the KB/merge layer as a
direction to validate, not the next sprint.

## Mindmap mode — "manage, don't draw"

Full design in [docs/mindmap-mode.md](docs/mindmap-mode.md). Philosophy: the map
is a **view of the index**, auto-laid-out from notes + links + triples; the user
**curates** (focus, filter by relation, pin, hide, promote) rather than drawing
nodes or dragging edges. Editing the map means editing the notes.

Incremental slices (each independently shippable):

1. ✅ **Local map (MVP) — shipped.** `index:graph` depth-1 slice (pure builder,
   golden-tested; `.map.md` views excluded); a `GraphView` island renders a
   force-directed layout (pure, golden-tested) with relation-coloured edges, ghost
   nodes, click-to-recenter; status-bar **⊹ Map** entry.
2. ✅ **Explore — shipped.** Wheel-zoom-to-pointer + drag-pan; depth 1–3 stepper;
   Local/Global toggle (whole-vault, degree-capped); live re-query on save via an
   `index:changed` signal.
3. ✅ **Auto-structure (B+C) — shipped.** PageRank → node size (centres of gravity);
   deterministic label-propagation communities → node colour (clusters). Pure +
   golden-tested.
4. ✅ **Semantic overlay (D) — shipped.** With talk-to-docs on, an opt-in **✨ Related**
   overlay adds dashed edges from the focus note to its semantically-nearest
   *unlinked* notes (per-note embedding centroids + cosine kNN in main). "What you
   meant" on top of "what you wrote".
5. ✅ **Curation — shipped.** Filter link types (click the legend), hide noisy nodes
   (right-click), reset — session view-state, never touches notes. Plain-language
   **Knowledge map** section added to in-app Help.
   *Deferred on purpose (the "explain it simply or nerdify/discard" filter): **save
   view → `.map.md`*** (complex round-trip — needs the saved-view artifact from
   docs/state-and-scopes.md), **pin/drag** (needs incremental relayout; fights
   auto-layout), **Louvain** (invisible polish; the tested label-propagation is
   fine). Still open & simple: embedding-space clustering as a colour mode.
2. **Curation** — relation filter (the killer feature the typed triples unlock),
   focus/expand/collapse, stable relayout (seed from previous positions).
3. **Pin / hide / promote + global map** — view-state curation; degree-threshold
   scale guard + "showing N of M" + empty states.
4. **Save view → `.map.md`; relation-typing bridge** — "Save view" writes a
   `.map.md` snapshot (reuses `parseMap`/`MapView`); inspector "type this
   relation" edits the source note's `key:: value` and re-indexes.
5. **Polish** — edge labels/legend per theme, hover preview, ⌘G/View-menu entry,
   large-vault perf (Barnes-Hut, culling).

### Automatic structure (centers, clusters, semantic graph)

A layer *on top* of the explicit-graph map: make it legible automatically — design
in [docs/auto-mindmap.md](docs/auto-mindmap.md). Model is a directed graph
(graph-primary, tree-derived). Phases: **B** centrality (PageRank → node size),
**C** community detection (Louvain → color) — both pure-TS, no AI; **D** semantic
overlay reusing the talk-to-docs embeddings ("related but not linked" kNN edges +
clustering + PCA/UMAP layout); **E** optional LLM last-mile (cluster names,
missing-link suggestions) via the existing provider abstraction.

### Distill a document (book → cited, editable notes)

Design in [docs/distill-documents.md](docs/distill-documents.md). Ingest a book →
chunk (offsets = provenance) → embed → cluster → LLM extracts concepts/claims/
relations, each **cited to the source span** → emit *editable* markdown notes
(`[[links]]`, `key:: value`, `cite::`) → normal index → derived mindmap for free.
Talk-to-docs *inverted* (push-distill vs question-pull); reuses the chunker's
offsets, the embeddings, the clustering, and the provider abstraction. Phases:
D1 markdown/text books, D2 provenance UX, D3 PDF/EPUB ingestion (swappable
`DocumentConverter`; pure-JS default, MarkItDown-MCP upgrade), D4 perspectives +
grounding. Many maps per vault — each run is a named artifact (perspective/seed).

### Body of knowledge (cumulative KB + stability)

Design in [docs/body-of-knowledge.md](docs/body-of-knowledge.md). The other mode:
**one canonical graph** grown incrementally from many sources (vs distill's
throwaway lenses) — one source of truth, many `.map.md` views. New concerns:
**entity resolution** (same concept across sources → one node, via embedding-kNN +
user-confirmed `same_as`, never silent) and **stability** (bounded, explainable
change on update: seeded layout + label-aligned clusters + hysteresis +
change-surfacing diffs). Phases: K1 merge target, K2 entity-resolution suggestions,
K3 stable update, K4 change-surfacing.

## Talk to docs (AI semantic search + chat)

Full design in [docs/talk-to-docs.md](docs/talk-to-docs.md). Local-first RAG over
the vault, reusing the SQLite index (+ `sqlite-vec` for vectors, transformers.js
for local embeddings, hybrid FTS5+vector retrieval, pluggable chat LLM).

- ✅ **Chunker** (`src/main/rag/chunk.ts`, golden-tested) — pure, dependency-free.
- ✅ **P0 spike** — sqlite-vec + transformers.js verified under Electron.
- ✅ **P1 — semantic search (shipped)** — renderer WASM embedder (worker) +
  sqlite-vec store + hybrid FTS⊕vector (RRF), surfaced in the sidebar. Fully local,
  off by default, no LLM/keys. e2e-covered (stub embedder) + real-model verified.
- **P2** — "Ask" chat panel + pluggable LLM (Claude default) + citations.
- **P3** — local-LLM option, bundle-vs-download model management, move the embedder
  to a renderer Web Worker tuning / distance-threshold for the ✨ marker.

## Event-loop telemetry ("measure everything") — ✅ shipped

A self-scheduled probe samples main-loop lag into a rolling 5-minute, octave
(power-of-two ms) histogram with worst-N exemplars; whole-app CPU/RAM via
`app.getAppMetrics()`; a tiny toggleable status-bar widget (sparkline + mini
histogram + popover) crediting the `ufw/pfw` repo. Off by default. Golden-tested
core + e2e. *Possible later:* finer (half-octave) buckets / the full pfw
log-linear geometry if percentile precision is wanted; sparkline of lag over time.

## Other post-1.0

- **Settings UI** — replace (or supplement) the raw-TOML editor with a form.
- **Quick-open / command palette** (⌘P).
- **Structured search** — query the triple store (e.g. `status:: active`,
  notes linking to `[[X]]`).
- Unify the two divergent "collapsible tree" styles (file tree vs. map).
- Auto-update via `electron-updater` + the GitHub Releases feed.
- App icons under `build/` (`icon.icns`/`icon.ico`/`icon.png`).
