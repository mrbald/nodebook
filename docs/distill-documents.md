# Distill a document — book → cited mindmap of editable notes

> A third capability that **composes** the other two. [talk-to-docs.md](talk-to-docs.md)
> pulls answers *from* documents; this pushes a whole document's key knowledge
> *out* into structured, editable, **cited** notes — which then flow through the
> normal index and the derived map ([auto-mindmap.md](auto-mindmap.md)).

## The idea

Feed Nodebook a book (PDF / EPUB / long markdown). It distills the key knowledge —
concepts, claims, entities, and how they relate — into a cluster of **editable
markdown notes**, each carrying a **reference back to the exact source span** it
came from. The "mindmap of the book" is then just the normal derived map over
those generated notes.

## Why it fits (and reuses almost everything)

- **Provenance is already in the chunker.** `chunk.ts` stores `start`/`end` offsets
  and the heading path for every chunk. A generated note cites `source:: [[Book]]`
  + `span:: 1234–1456` (or a page/§ anchor); clicking it opens the source at that
  location — the *same* citation mechanism talk-to-docs P2 chat uses.
- **Themes are already in the embeddings.** Embed the book's chunks (the
  talk-to-docs pipeline) → cluster them (auto-mindmap's clustering) → each cluster
  is a candidate top-level branch. Token-efficient: the LLM sees cluster
  representatives, not the whole book on repeat.
- **The output is notes, not a locked artifact** — one source of truth, and the
  user can *correct* the LLM. The book is the *source*; the notes are
  *derived-but-adopted* (a first draft you own). Once emitted they participate in
  search, backlinks, the graph, and the map like any note.

## The pipeline

1. **Ingest → markdown.** PDF/EPUB → markdown + an anchor map (page/§ → offset).
   The messy, format-specific step (a library); everything downstream is
   format-agnostic.
2. **Chunk** (offsets = provenance) → **embed** → **cluster** (semantic themes).
3. **Extract, grounded.** Per cluster (and/or per chunk) the LLM emits key concepts,
   claims, and `(entity) --relation--> (entity)` triples — **each with the citing
   span**. *Extractive-first* (quote + locate) over abstractive, so every statement
   is checkable against the source.
4. **Emit editable notes** with `[[links]]`, `key:: value`, and `cite::`/`source::`
   provenance → normal index → the derived mindmap appears for free.

## Ingestion — the converter (Microsoft MarkItDown & Node options)

MarkItDown (Python) is the quality bar, and it now has Node counterparts, so we
don't need a Python runtime baked into the app. Behind one `DocumentConverter`
interface:

- **Default: a pure-JS converter** that bundles cleanly into Electron — e.g.
  **`markitdown-ts`** (TS, works on buffers/URLs/paths, edge-friendly) or
  **`markitdown-js`** (Node port). Pure JS → no external runtime, ships in the asar.
- **Pluggable upgrade: MarkItDown itself via its MCP server** (`markitdown-mcp`,
  runnable over NPX, no Docker). This reuses the **MCP connection pattern already in
  `provider.ts`** — Nodebook as an MCP *client* of a converter server — giving the
  full Python-grade fidelity for users who run it, without us shipping Python.
- **Avoid** the wrappers that shell out to the Python package (e.g.
  `@mote-software/markitdown`) as the default — they reintroduce a Python dep.

Community ports vary in fidelity/maintenance vs. the Python original; we evaluate
on real PDFs at **D3** and keep the converter swappable. Crucially, **D1 (markdown/
text books) needs no converter at all**, so the interesting loop is built first.

## What's genuinely new vs. risky

- **Format ingestion** is the one real new dependency surface — mitigated by the
  swappable `DocumentConverter` above; markdown/text books need none.
- **Fidelity.** Grounding every claim in a clickable span is the anti-hallucination
  safeguard — the user *verifies*, not trusts. Lead with citations; prefer extract
  + locate over free paraphrase.
- **Cost.** A whole book is many chunks; cluster-first + representative sampling
  keeps the LLM bounded. The provider abstraction lets the user pick local vs cloud.

## Many maps per vault — perspectives, versions, seeds

A distillation **run is not "the map" — it's *a* map**, and that's the right model.
Users understand an LLM run is a fresh generation, so re-running to get a brand-new
map is expected, not a surprise to guard against. This falls straight out of the
existing model where **`.map.md` is just a file**: a vault can hold many.

So a run = a **named, self-contained artifact**: a folder of cited notes + a
`.map.md` view over them, e.g. `distill/sapiens—by-themes/`,
`distill/sapiens—by-argument/`, `distill/sapiens—v2-seed7/`. Because each run lives
in its own namespace:

- **No clobbering** — re-running as v2 never touches your edits in v1; you keep,
  compare, or discard whole runs.
- **Perspectives are first-class** — the same book distilled "by theme" vs "by
  chronology" vs "by argument" (different extraction prompts) are just different
  artifacts side by side. Several lenses on one source coexisting *is* the
  knowledge-management win.
- **Comparable** — stamp each run with light metadata (`perspective::`, `model::`,
  `seed::`, `date::`) so the maps can be diffed/sorted.

This generalizes beyond distillation: "multiple saved views/perspectives" is
equally useful for the hand-curated map (mindmap-mode's "Save view → `.map.md`" can
write many).

## Phasing

- **D1. Markdown/text books** (no new deps) → chunk + embed + cluster + extract →
  cited notes as a named run-artifact. Proves the whole loop on the easy format.
- **D2. Provenance UX** — `cite::` opens the source span; a "sources" inspector.
- **D3. PDF/EPUB ingestion** via the swappable `DocumentConverter` (pure-JS default,
  MarkItDown-MCP upgrade) + page/§ anchors.
- **D4. Perspectives & quality** — extraction prompt presets (by theme / argument /
  chronology), per-run metadata, a "maps in this vault" browser, extractive
  grounding, intra-run dedup.

Depends on talk-to-docs (embeddings + the model-provider abstraction) and composes
with auto-mindmap (clustering + map). Effectively **talk-to-docs inverted**:
exhaustive push-distill instead of question-pull, sharing the same substrate.
