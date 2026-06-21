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

## What's genuinely new vs. risky

- **Format ingestion** (PDF/EPUB → markdown, page anchors) is the one real new
  dependency surface; markdown/text books need none.
- **Fidelity.** Grounding every claim in a clickable span is the anti-hallucination
  safeguard — the user *verifies*, not trusts. Lead with citations; prefer extract
  + locate over free paraphrase.
- **Cost.** A whole book is many chunks; cluster-first + representative sampling
  keeps the LLM bounded. The provider abstraction lets the user pick local vs cloud.
- **Re-run vs. edits.** Extraction is a *generate-a-draft* step the user then owns;
  re-running must not clobber edits (track generated-vs-edited, or emit into a fresh
  namespace). A real design point, not an afterthought.

## Phasing

- **D1. Markdown/text books** (no new deps) → chunk + embed + cluster + extract →
  cited notes. Proves the whole loop on the easy format.
- **D2. Provenance UX** — `cite::` opens the source span; a "sources" inspector.
- **D3. PDF/EPUB ingestion** + page/§ anchors.
- **D4. Quality** — extractive grounding, dedup across clusters, re-run safety.

Depends on talk-to-docs (embeddings + the model-provider abstraction) and composes
with auto-mindmap (clustering + map). Effectively **talk-to-docs inverted**:
exhaustive push-distill instead of question-pull, sharing the same substrate.
