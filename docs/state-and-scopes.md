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
   `.nodebook`**. *Shipped:* the distill merge dialog is the first producer of
   `same_as::` — it writes the line only when the user ticks "same as the existing
   note", never on a bare name clash — and `buildGraph` is its consumer, folding
   a confirmed pair into one node and keeping the other name as an alias. Delete
   the line and the two notes split apart again.
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

*Shipped, and it is tier 1:* an **unmerged distill run** lives in
`<vault>/.distill/<run>/` as markdown. It is a dot-dir, so the vault scan and the
watcher skip it exactly as they skip `.nodebook/` — but it is **durable staging,
not cache**: the model output in it exists nowhere else and cannot be re-derived
without paying for the run again. It is written atomically, migrated forward, and
worth backing up. The run's own `run.db` beside it *is* cache, and rebuilds from
the markdown when missing. `.nodebook/` goes back to being purely a cache.

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
Folder prefixes are not a boundary. The table below is the **requirement** — which
domains exist and where each may be seen. It was written as one `scope` column on
`files`/`chunks`; what shipped for distill is stronger and is described under it.
No `scope` column exists today.

| Scope | What | In search? | In canonical graph? |
|---|---|---|---|
| `source` | notes you wrote | yes | yes |
| `extracted` | claims/mentions pulled from a doc | configurable | only after promote |
| `canonical` | merged entities (the KB) | yes | yes |
| `distill-staged` | a distill run not yet adopted | scoped to that run | **no** |
| `view` | saved-view artifacts | no (they're config) | n/a |

**Distill output reaches the canonical graph only through an explicit
promote/merge step** — so an unadopted run can't distort search, centrality,
clustering, or entity resolution. That requirement is met.

**Staging is a separate database, not a scope value.** Each run owns a `run.db`
inside `<vault>/.distill/<run>/` — its own `VaultIndex`, never the canonical one.
The firewall is therefore structural: there is no query that could accidentally
return a staged note, because the rows are not in the canonical database at all.
A `scope` column would have needed every query to remember a predicate. **Merge
*is* the promote step**: it copies the run's notes into `Distilled/<run>/` (and
the document itself into `Sources/`, once), and from that moment they are ordinary
vault notes the normal indexer picks up — nothing special about them remains.

**No new scope value was added. `files.kind` carries what a note *is*** —
`document | theme | concept | claim | entity`, read from a note's frontmatter
`kind:` — which is a different axis from scope and answers the questions scope
could not. A `kind: document` note is a whole book: it is searchable and
answerable, but it is left out of the global degree ranking, out of the
colour-by-meaning clustering, and out of "related" suggestions, and it skips the
full parse on index (title + full text + chunks only — the cheap path for a 1 MB
note). `kind: theme` lets the map draw a group differently. The contract's
`source` scope still means "notes you wrote", and merged distill notes are exactly
that once you own them.

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
  doesn't stall. *Partly addressed:* the `kind: document` cheap index path keeps
  the biggest single note off the parser, and the telemetry histogram is the gate
  — but no target number is written down yet.
- **Concept-level vectors for resolution** — whole-note centroids are a poor merge
  substrate for multi-topic and generated notes; resolution needs vectors at the
  *claim/concept* grain. Still open, and it is what stands between the shipped
  name-match merge candidates and real entity resolution
  ([body-of-knowledge.md](body-of-knowledge.md) K2).
- **Claim-level provenance** — ~~`cite::` is note-level and drifts after edits~~.
  *Largely solved:* a citation is a **quote-anchored** span. The stored offsets are
  now exact (`content.slice(start, end)` is the chunk the quote was found in), a
  quote is accepted only where it occurs **uniquely** in the document, and the
  renderer re-locates the span from the quote when the text has moved — so an edit
  shifts the anchor instead of breaking it. Each citation also records `where:`
  (the page or section). What is still open is the harder half: *conflicting*
  claims across sources, and provenance at a grain finer than one quote.
- **Commit protocol** — import transactions, recompute boundaries, pre-confirmation
  vs committed graph state, and rollback/unmerge for a staged merge. *Shipped for
  the distill merge:* the plan is computed and shown before a byte is written, the
  manifest with expected hashes is written first, files are copied via temp +
  rename, and Undo verifies each hash and sends anything you edited to the Trash.
  The general case — many sources committing into one canonical graph — is still
  open.
