# Automatic structure — centers, clusters, and the semantic graph

> Companion to [mindmap-mode.md](mindmap-mode.md). That doc covers **deriving +
> curating** the explicit link graph (triples). This one covers making it
> **legible automatically**: where the centers are, what the clusters are, and
> what is *related but not linked* — using graph algorithms, the talk-to-docs
> embeddings, and (optionally, for the last mile only) an LLM.

## The shape question: tree, or directed graph?

Asking is right, because the data and the idiom disagree:

- A note graph (`[[wikilinks]]` + typed `key:: value` fields) is a **general
  directed multigraph** — it has **cycles** (A↔B), **hubs**, and is **non-planar**
  in general. It is *not* a tree, and can't be flattened to one (or to a planar
  graph) without throwing away the cross-links that *are* the knowledge.
- A "mind map" is conventionally a **radial tree** (one center, branches).

Resolution: **the model is a graph; we render two projections of it.**

- **Graph view (primary)** — force-directed layout of the *real* graph. Centers
  and clusters **emerge from the physics** (below). We don't constrain to planar —
  force layout handles edge crossings fine; visual clutter is managed by
  *filtering* (relation type, centrality threshold), not by flattening.
- **Outline view (derived)** — a hierarchical tree **computed** from clustering
  (clusters → sub-clusters → notes): the digestible "mind map." It is a lossy,
  regenerated *summary* of the graph, never hand-built — and it is exactly what
  "Save view → `.map.md`" serializes.

So: **graph-primary, tree-derived.** One index, two lenses.

## Two graphs we already have

1. **Explicit graph** — the `triples` table: `(subject) --relation--> (object)`.
   Always available, zero new cost.
2. **Semantic graph** — the talk-to-docs embeddings (sqlite-vec). A per-note vector
   is the **mean (centroid) of its chunk vectors**; cosine-kNN over those gives
   **"related but not linked"** edges — latent structure the explicit graph misses.
   Available when talk-to-docs is enabled; **reuses the existing vectors** (no new
   embedding cost).

The automagic layer fuses them: explicit edges = what you *wrote*; semantic edges
= what you *meant*.

## Naming what you described (the toolkit)

| Your words | Proper term | What it is | Cost |
|---|---|---|---|
| "centers of gravity" | **Centrality** | degree (most-linked) → **PageRank** / eigenvector (important via important neighbors). Drives node **size**. | pure TS (power iteration) |
| "clusters" (links) | **Community detection** | **Louvain/Leiden** (modularity) or label-propagation on the link graph. Drives node **color**. | pure TS |
| "clusters" (meaning) | **Embedding clustering** | **k-means** / **HDBSCAN** (auto-k, density) / **spectral** (eigen-decomp of the similarity Laplacian) over note centroids. | linear algebra on vectors |
| "attractors" | force **basins** / cluster **centroids** | a force-directed sim has gravity wells; the centroid vector is a cluster's center of mass. | d3-force |
| "embedding-space linear algebra" | **PCA / UMAP projection** | SVD/UMAP → 2D *semantic* layout (near = similar), independent of links. | PCA pure; UMAP a lib |

All of the math is **deterministic** — no LLM. PageRank, Louvain, k-means, and PCA
are short, pure, golden-testable functions, the same ethos as the harvest parser,
the chunker, and the telemetry histogram.

## Where the LLM helps (the "mechanical last mile" — your read is exactly right)

The algorithms produce *structure*; the LLM produces *labels and narrative*. It is
**optional** (everything works unlabeled — color by community, size by centrality)
and goes through the existing `provider.ts` abstraction (search-only / local /
cloud):

1. **Name a cluster** — its notes' titles + one representative chunk each → a 2–4
   word theme. Batched, cheap.
2. **Suggest missing links** — the high-value one: pairs that are **semantically
   near (embedding-kNN) but unlinked** → "connect these?", with the LLM proposing
   the relation label. Surfaces latent structure worth writing down. The kNN is
   math; the LLM only *phrases* the suggestion.
3. **Derive the outline** — turn flat clusters + centroids into a nested hierarchy.
4. **Summarize a region** for the inspector.

The split you intuited holds: **clustering = linear algebra; the LLM = the names.**

## Phasing (additive to mindmap-mode's slices)

- **A. Graph render** (= mindmap-mode MVP) — `index:graph` slice + force/radial
  canvas. *Prerequisite.*
- **B. Centrality** — degree → PageRank; size nodes by it. Pure TS, golden-tested.
  No deps, no embeddings.
- **C. Communities** — Louvain / label-propagation on links; color by cluster.
  Pure TS. *Now there are "centers + clusters" with zero AI.*
- **D. Semantic overlay** (talk-to-docs on) — per-note centroid vectors → kNN
  "similar" edges + embedding clustering + an optional PCA/UMAP 2D "semantic
  layout" toggle.
- **E. LLM last-mile** (opt-in) — cluster names, missing-link suggestions, outline.
- **F. Derived outline → `.map.md`** — tree projection + save.

**B + C deliver the automagic feel with no new dependencies and no AI**; D + E are
the semantic/LLM enrichment the talk-to-docs investment unlocks.

## Decisions to settle when we build

1. **Primary view** — graph-primary + tree-derived (recommended), or tree-first?
2. **First clustering substrate** — link communities (always available, no deps)
   first with embeddings as an enhancement (recommended), or embedding-first?
3. **Render / algorithm tech** — pure-TS algorithms (matches the codebase ethos,
   golden-testable) + **d3-force** for layout on a canvas island; vs an all-in-one
   (**graphology + sigma.js** ships Louvain / PageRank / ForceAtlas2 + WebGL, but
   is a heavier dep). Recommended: pure-TS algos + d3-force/canvas, escalate to
   WebGL only if vaults get large.

See [ROADMAP.md](../ROADMAP.md) and [mindmap-mode.md](mindmap-mode.md) for the
explicit-graph foundation this builds on.
