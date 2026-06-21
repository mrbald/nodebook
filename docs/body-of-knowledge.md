# Body of knowledge — one growing graph, kept stable

> **Status: research, not committed.** This is the speculative far end. It is
> **firewalled from the v1 build** (explicit-graph mindmap + the shipped semantic
> search): entity resolution, canonical merges, and stable incremental updates need
> the durable-state model and the commit protocol in
> [state-and-scopes.md](state-and-scopes.md) pinned down first. Treat the below as a
> direction to validate, not a plan to build next.

> Reconciles the two modes the design implies. [distill-documents.md](distill-documents.md)
> makes *perspective artifacts* (a fresh map per source/angle). This is the other
> mode: one **canonical, cumulative** graph grown incrementally from many sources
> over time — and the hard part, keeping it **stable** as it grows.

## One source of truth, many views

"Fresh map per run" is right for *lenses on a single source*. But the **body of
knowledge is the vault itself** — the union of everything you've written and
ingested — and its graph is the always-on derived view. Reconciled:

- **One canonical graph** = the full derived graph over all notes (your "brain"). It
  already grows incrementally: every save / new file re-indexes, and the graph is a
  pure function of the index ([mindmap-mode.md](mindmap-mode.md)).
- **Many maps** = saved `.map.md` *views/lenses* over (subsets of) that graph, plus
  the throwaway distill artifacts. Views, never the source of truth.

So ingesting a book has two possible destinations: a **standalone perspective
artifact** (distill mode), or **merged into the canonical KB** (this mode). Same
pipeline, different target.

## Incremental growth is mostly already there

Adding a document = adding its (extracted) notes to the vault → the index
delete-then-inserts them → the derived graph reflects them. The *data* layer is
already incremental. Two things are new for a cumulative KB:

1. **Entity resolution** — the same concept from different sources must be **one
   node**, not duplicates.
2. **Stability** — adding info must *update* the map without scrambling it.

## Entity resolution (don't fork the same concept)

When ingesting, a new "Reinforcement Learning" concept must recognize an existing
"RL" note. Mechanism, conservative by default:

- embedding-kNN of the new concept's vector against existing concept nodes → merge
  **candidates** above a margin;
- the LLM (optional) confirms + canonicalizes the name;
- record a `same_as::` / alias triple (the store already takes arbitrary relations),
  or merge — **suggested, user-confirmed, never silent**. "Manage, don't draw"
  applies to merges too.

The merge decision itself is a **tier-1 durable decision that lives in markdown**
(the `same_as::` field → a triple), so it survives a `.nodebook` rebuild — it was
never in the cache. See [state-and-scopes.md](state-and-scopes.md); whole-note
centroids are also a poor matching substrate, so resolution operates on
*concept-grain* (`extracted` scope) vectors, not note centroids.

A concept then accumulates **multi-source provenance**: `cite:: BookA §3`,
`cite:: BookB §7`, your own note — the inspector shows every source that fed it.
Provenance across sources is a feature, not bookkeeping.

## A definition of stability (the crux)

**An update is *stable* if a bounded input change produces a bounded, *explainable*
output change.** Three axes:

1. **Identity** — a surviving node keeps its id, colour, name, and cluster unless new
   evidence *specifically* reclassifies it. No gratuitous renaming/recolouring.
2. **Space** — existing nodes move by a bounded amount; your spatial memory survives.
3. **Structure** — clusters persist across updates; they split/merge only when the
   data demands it, and such changes are **surfaced, not silent**.

### Mechanisms

- **Seeded layout** — warm-start the force sim from previous positions; pinned
  landmarks fixed; relax, don't restart. (Already the plan in mindmap-mode.)
- **Label-aligned clustering** — Louvain is unstable run-to-run, so after recompute
  **match new clusters to old by max overlap** (Jaccard/Hungarian) and carry over
  id/colour/name; only genuinely new clusters get new identities. (Or seed
  label-propagation with the prior labels.)
- **Stable ids** — notes already have stable paths; merged concepts get a canonical
  id + aliases, so identity survives a merge.
- **Hysteresis** — require a margin before re-clustering or re-merging, so structure
  doesn't flicker on noise (the same instinct as "never flip on a single sample").
- **Change-surfacing** — every update emits a **diff**: "new cluster *X*; notes A, B
  joined *Y*; 'RL' ≈ 'Reinforcement Learning' — merge?" The user accepts structural
  deltas. The map *proposes* changes; it never silently reshuffles. This is the real
  antidote to churn.

So "incremental" here is less about online algorithms (recompute is cheap at vault
scale) than about **seeding from prior state + aligning identities + surfacing
deltas**.

Crucially, this staging applies to the **semantic layer only** — entity merges and
cluster re-identification. The **explicit link graph stays live and deterministic**
(adding a `[[link]]` just adds an edge; no confirmation, no churn). That split — and
why mindmap-mode's "pure function of the index" and this doc's "proposed, accepted
deltas" are *both* true once separated — is the contract in
[state-and-scopes.md](state-and-scopes.md).

## Phases (compose with auto-mindmap + distill)

- **K1. Merge target** — distill/ingest can land into the canonical vault (not just a
  standalone artifact); multi-source `cite::` accumulation.
- **K2. Entity-resolution suggestions** — embedding-kNN merge candidates +
  user-confirmed `same_as`; optional LLM canonicalization.
- **K3. Stable update** — seeded layout + label-aligned clusters + hysteresis.
- **K4. Change-surfacing** — the per-update diff/inspector ("what changed, confirm").

Built on the index (already incremental), the embeddings (resolution + clustering),
and the provider abstraction (optional LLM). Stability is **curated**, like
everything else in Nodebook: the KB grows by your confirmation, not by silent global
recompute.
