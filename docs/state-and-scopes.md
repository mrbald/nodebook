# State ownership & scopes (the contract)

> Resolves the two structural gaps an independent review flagged: durable
> *decisions* were being treated as "rebuildable cache," and every domain (your
> notes, extracted claims, canonical entities, distill runs, saved views) shared
> one vault-wide union with no boundary. This doc is the contract the mindmap /
> auto-structure / distill / body-of-knowledge docs build on — read it first.

## Three tiers of state — what is source of truth, what is not

"Plain `.md` is the only source of truth; `.nodebook` is a rebuildable cache" holds
— but only once we say which tier each piece of state is in.

1. **Decisions — source of truth, in the vault as markdown.** Anything a human
   *chose* that can't be re-derived: typed relations, **merge/alias decisions**
   (`[[RL]] same_as:: [[Reinforcement Learning]]` — already a `key:: value` → a
   triple), pins, "name this cluster X". These live *in notes* (or a saved-view
   artifact) and survive a `.nodebook` rebuild **because they were never in
   `.nodebook`**.
2. **Saved views — source of truth, explicit artifact.** Focus, filters, pins, a
   frozen cluster hierarchy: a *named* thing the user chose to keep. Today that's
   `.map.md` — but `.map.md` is overloaded (below); saved-view *config* needs its
   own representation, distinct from a hand-authored outline.
3. **Derived presentation — genuinely cache, losable.** Layout positions, cluster
   colours/ids for continuity, embedding vectors, centrality scores. Recomputable
   from tiers 1–2 + the notes; losing it on rebuild costs a recolour/relayout, never
   a decision. *This* is what `.nodebook` may hold.

Rule of thumb: **if a rebuild would lose a human decision, that state is in the
wrong tier.** Decisions → markdown; only cosmetics → the cache.

## `.map.md` is two things — split them

Current `.map.md` (`parseMap.ts`) is a **human-authored outline + explicit edges**
(tier 1). The mindmap/auto docs also wanted it to carry **saved-view state**
(focus/filters/pins/derived hierarchy — tier 2). Different files, different
round-trip rules:

- **Outline map** — hand-edited; the human owns every line.
- **Saved view** — *generated* from curation; regenerating must never clobber hand
  edits. Keep it a separate artifact (frontmatter or a sibling `.view`), so "Save
  view" can't rewrite a document the user is editing.

## Scopes (domains) — not one vault-wide union

Search, centrality, clustering, and export must know *which* notes participate.
Folder prefixes are not a boundary; the index needs an explicit `scope`:

| Scope | What | In search? | In canonical graph? |
|---|---|---|---|
| `source` | notes you wrote | yes | yes |
| `extracted` | claims/mentions pulled from a doc | configurable | only after promote |
| `canonical` | merged entities (the KB) | yes | yes |
| `distill-staged` | a distill run not yet adopted | scoped to that run | **no** |
| `view` | saved-view artifacts | no (they're config) | n/a |

**Distill output lands in `distill-staged`** and reaches the canonical graph only
through an explicit **promote/merge** step — so throwaway runs can't distort search,
centrality, clustering, or entity resolution. Implemented as a `scope` column on
`files` / `chunks` that the relevant queries filter by, **not folders**.

## Live-derived vs staged-confirmed (resolving the contradiction)

Two update regimes, kept apart:

- **Explicit graph + centrality = live, deterministic.** Adding a `[[link]]` adds an
  edge; PageRank/degree recompute cheaply and shift smoothly — no confirmation, no
  churn. This is mindmap-mode's "pure function of the index", and it stays true *for
  this layer*.
- **Semantic merges + cluster re-identification = staged, confirmed.** Entity
  resolution and cluster splits/merges are *proposals* the user accepts; not silent,
  not live. "Stability," diffs, and hysteresis live here, on the semantic layer
  **only** — never on the explicit graph.

The earlier docs conflated these; they are separated here.

## Still open (deferred to the cumulative-KB research, not committed)

Honest gaps that do **not** block the v1 build (explicit mindmap + semantic search),
to be specified before any canonical-KB / entity-resolution code:

- **Scale targets** — concrete N (notes / chunks / nodes / edges) the renderer and
  the single synchronous `better-sqlite3` must hold; batching strategy for
  large write bursts (a distilled book = thousands of inserts) so the main loop
  doesn't stall.
- **Concept-level vectors for resolution** — whole-note centroids are a poor merge
  substrate for multi-topic and generated notes; resolution needs vectors at the
  *claim/concept* grain (an `extracted`-scope concern).
- **Claim-level provenance** — `cite::` is note-level and drifts after edits; true
  per-claim provenance, conflicting claims, and converter-dependent page anchors are
  unsolved and currently oversold as the anti-hallucination guarantee.
- **Commit protocol** — import transactions, recompute boundaries, pre-confirmation
  vs committed graph state, and rollback/unmerge for a staged merge.
