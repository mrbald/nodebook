# Distill a document — book → cited mindmap of editable notes

> A third capability that **composes** the other two. [talk-to-docs.md](talk-to-docs.md)
> pulls answers *from* documents; this pushes a whole document's key knowledge
> *out* into structured, editable, **cited** notes — which then flow through the
> normal index and the derived map ([auto-mindmap.md](auto-mindmap.md)).

## The idea

Feed Nodebook a book (PDF / EPUB / DOCX / HTML / long markdown). It distills the
key knowledge — concepts, claims, entities, and how they relate — into a cluster
of **editable markdown notes**, each carrying a **reference back to the exact
source span** it came from. The "mindmap of the book" is then just the normal
derived map over those generated notes.

> **Status: built and shipped.** A run reads the **whole** document, stages its
> notes in `<vault>/.distill/<run>/` behind that run's own database, and **Merge**
> is the promote step that copies them into the vault. Staging is not a `scope`
> column — it is a separate database, which is a stronger firewall; see
> [state-and-scopes.md](state-and-scopes.md). What is still research is the
> *cumulative* side: making one concept out of two books' notes automatically
> ([body-of-knowledge.md](body-of-knowledge.md)). Merge only ever proposes; a
> name clash is never treated as identity without the user's tick.

## Why it fits (and reuses almost everything)

- **Provenance is already in the chunker.** `chunk.ts` stores `start`/`end` offsets
  and the heading path for every chunk. A generated note keeps provenance in
  **frontmatter** — the source name plus each `cite:` block (chunk id, offset
  range, the exact quote, and `where:` — the page or section a person would name)
  — in single-colon YAML, which `harvest()` never turns into a graph edge; the
  note's **body** carries the real edge, `source:: [[Book]]`.
  `Book` is one short, human title used everywhere — frontmatter, body link, and
  the source's own note file (derived from the filename: a library-dump's
  `Title -- Author -- ...` convention is cut down to title + author, underscores
  become spaces) — so the link always resolves to a real note, never a ghost; the
  original file's path survives in the source store. Clicking a citation opens
  Nodebook's **converted copy** at that span — the *same* citation mechanism
  talk-to-docs P2 chat uses — and the document's own note carries an **Open
  original** button that hands the real file to the OS.
  The derived map hides the source-document node by default (every note in a run
  points to it, so it's a trivial hub, not a useful edge) — a per-run toggle
  brings it back.
- **Themes come after extraction, not before.** The model reads the document in
  order (below); embeddings no longer decide what it reads. Once the notes exist,
  *they* are embedded and grouped, and each group gets a **theme note** its
  members point at with `part_of::`. The map then reads book → themes → notes
  instead of one flat star. Embeddings organise the result; extraction reads
  everything.
- **The output is notes, not a locked artifact** — one source of truth, and the
  user can *correct* the LLM. The book is the *source*; the notes are
  *derived-but-adopted* (a first draft you own). They land in the run's own index
  under `<vault>/.distill/<run>/` and drive *that run's* map; only an explicit
  **Merge** copies them into the vault, where the normal index, search, backlinks
  and canonical graph pick them up (so throwaway runs don't distort it — see
  [state-and-scopes.md](state-and-scopes.md)).

## The pipeline (as built)

`src/main/distill/run.ts` wires it. Every step below is a pure, dependency-free
module with unit tests; the two impure steps — the chat model and the embedder —
arrive as injected interfaces, so the whole orchestrator runs under vitest with
stubs.

1. **Convert → markdown** (`convert.ts`). One switch on the file extension: PDF
   via pdf.js (`## Page N` per page), EPUB via fflate + turndown, DOCX via
   mammoth + turndown, HTML via turndown, markdown/text as-is. A PDF's text
   layer is read with its geometry: items on a line are joined by the gap
   between them (pdf.js already inserts the spaces it saw; joining every item
   with another space doubled them), a duplicate item pdf.js emits for a list
   bullet is dropped, and a line set entirely in a fixed-pitch font is a **code
   listing** — re-laid on a character grid from its x positions and marked
   with markdown's four-space indent, unless the whole document is monospace
   (then it is prose in a typewriter face). The text is then cleaned
   (`cleanPdf.ts`): lines that repeat on 30 % of pages (the running header) and
   bare page numbers are dropped; so is a header or footer that prints the page
   number beside a title that changes every chapter (`102 | Chapter 4: …`),
   found by the one thing that does repeat — the number counting up with the
   pages; a word cut across a line break (ASCII hyphen or the U+2010 hyphen
   InDesign-style layout uses) is rejoined when the joined word occurs
   elsewhere in the text; printed line breaks become real paragraphs; a code
   listing passes through verbatim (never furniture, never joined); and a
   paragraph that would open like a markdown heading or fence is escaped, so a
   `#` in the index never becomes a heading in the chunker's path. The `## Page
   N` headings stay — that heading is the page provenance.
2. **Store the source** (`sources.ts`). The converted text is content-addressed:
   `.distill/sources/<sha1>.md`, plus `.distill/sources.json` mapping the hash to
   the original path, title, format, and the original's size and mtime. The same
   unchanged file converts once and every later run reuses the text. This is also
   what makes **Open original** possible, and what lets two runs of one book share
   a single copy in `Sources/`.
3. **Chunk** (`chunkMarkdown`) — about 1000 weight units with 10 % overlap; each
   chunk keeps its exact offsets (`content.slice(start, end)` is the chunk) and
   its heading path. That is the citation provenance.
4. **Plan the windows** (`windows.ts`). Consecutive chunks are packed, in document
   order, into **windows** as large as the model's declared prompt budget allows.
   The budget is `ChatModel.inputBudget`, overridden by `[talk.chat]
   contextTokens`; the planner first subtracts the fixed prompt text, the concept
   registry and the expected output, so a packed window still fits. **The whole
   document is read** — nothing is sampled — unless it needs more windows than
   `[distill] maxCalls` (default 120). Only then are windows kept at an even
   stride, and `coverage` reports the share of the text, **by weight**, that the
   model was actually shown. The family default budget (16 000 weight, ≈5k tokens)
   is deliberately small for a big-context model: measured on 26 pages of a
   pandas book through `claude-cli`, four-times-larger windows halved the yield
   (Haiku 50 → 24 items, Sonnet 30 at the larger size) — a model writes about as
   many items per call whatever the call's length, so a bigger window buys
   fewer calls at the price of fewer notes per page. A document that needs more
   windows than `maxCalls` is better served by raising `maxCalls` than
   `contextTokens`.
5. **Extract, one call per window, sequentially** (`extract.ts`). Each call carries
   the **concept registry** (`registry.ts`): every title grounded so far, most
   recent first, cut to a weight budget. Without it a model meeting the same idea
   in chapter 9 invents a fresh name for it, and cross-window links are impossible
   — a note cannot link to a title it has never seen. The prompt offers a fixed
   relation vocabulary (`defines`, `part_of`, `example_of`, `causes`,
   `depends_on`, `supports`, `contrasts_with`, `about`); anything else the model
   writes is kept as an edge but typed `related_to`. The reply is read
   leniently (`lenientJson.ts`): a quote the model forgot to escape inside a
   string — Python's `df["data1"]` in a summary — is mended before parsing,
   because a quote only closes a string where the grammar allows one to, and a
   comma only where one of the reply's own keys follows (so prose quoting a
   dict literal cannot end a field early). Over
   the 171-window book that was 4 replies (2 %), each of which had cost a
   second, repair call that recovered fewer items than the first reply held.
   Text a machine cannot mend still gets that one repair call.
6. **Ground every item** (`extract.ts`). A quote must be found in the source text.
   The search widens — the cited chunk, then the window's other chunks, then the
   whole document — and a match is accepted **only when it is unique**: a quote
   that occurs twice is dropped as ambiguous rather than guessed at, and a quote
   found in a different chunk re-attributes the citation instead of being thrown
   away. Matching ignores whitespace entirely, folds every quotation mark to
   one, drops a hyphen or dash standing between two letters (a word cut at a
   line end, a compound the model spelt closed), folds ellipses, ligatures and
   the converter's markdown escapes, but never weakens to a partial match — and
   the citation always shows the source span, not the model's copy. Drops are counted by
   reason (`noEvidence`, `notFound`, `ambiguous`, plus recoveries) and the banner
   says so. *No evidence, no item.*
7. **Dedup and link** (`dedup.ts`, `link.ts`). Near-duplicate titles absorb into
   one surviving note — titles only: a shared citation span used to count as
   identity too, from the days when two sampled clusters quoting one passage
   had extracted the same thing twice, but a window that reads a passage whole
   takes several items from it on purpose (the person and the term they
   coined, `shape` and `dtype` from one sentence). On the pandas book that rule
   made 85 of 132 merges and every one of them was wrong; a shared passage is
   relatedness, which the links already carry. Every `[[target]]` is then remapped through dedup's aliases
   and the final (de-collided) note names, so a rename never leaves a dead link; a
   target that still matches nothing snaps to the nearest name only above a high
   similarity, and otherwise stays a **counted ghost** rather than becoming a
   wrong edge. On top of that, deterministic **mention links**: if note A's own
   text names note B specifically enough, that is an edge the model simply forgot
   to write down.
8. **Theme** (`themes.ts`). The emitted notes are embedded, grouped (about √n
   groups, 3–16), and **all** groups are named in one model call — naming is
   presentation and should not cost a call per group. Both this prompt and the
   extraction prompt make the model **state the source's language first**
   (the schema's first field) before writing anything in it: asked only to
   "write in the same language as the notes", Sonnet without extended thinking
   named an English book's groups in Russian, Polish and Turkish on identical
   prompts (2 of 3 tries); made to state the language, 3 of 3 came back in
   English. The rule names no language of its own — an example language in
   the rule became the output language once. A group whose name never
   arrives falls back to its medoid note's title, so a failed naming call costs
   names, not notes. Each note gets a primary `part_of:: [[Theme]]`.
9. **Emit editable notes** (`emit.ts`). Body `key:: value` edges — `source::`, each
   typed relation, `part_of::`, `mentions::` — drive the `[[links]]` and the map.
   Frontmatter carries `kind:` (`concept|claim|entity|theme|document`), the
   `source:` name and the `cite:` blocks, in single-colon YAML that `harvest()`
   ignores → normal index → the derived mindmap appears for free.

**Resilience.** A call that fails for a passing reason (429, 5xx, a dropped
connection, a CLI non-zero exit) is retried with backoff. A call rejected *for
length* is not retried but **split in two, and both halves are read** — an
optimistic budget costs an extra call and never a passage; splitting is bounded by
a depth limit, and a window still rejected at the bound is marked failed and
counted. A window that keeps failing costs its own window, not the run. Every
finished window is checkpointed to `progress.jsonl`, so a cancelled or crashed run
**resumes** from where it stopped. The one thing that does stop a run is three
failing windows in a row: an expired key should cost three slow calls, not a
hundred.

**Staging, then merge.** A run is a self-contained folder under `<vault>/.distill/`
— a dot-dir the vault scan and the file watcher already skip, which *is* the
firewall. It holds the notes as markdown, `meta.json` (source hash, model,
provider, prompt version, date, settings, coverage) and a `run.db` that is only a
cache of that markdown: delete it and it rebuilds. Staged notes are readable
before merge in a read-only pane, with their citations resolving against the run's
own copy of the document. **Merge** computes a plan first (`mergePlan.ts`): each
note is `new`, `identical` (same bytes — skipped), or `collides` (that name exists
in the vault). A collision is written beside the existing note under a
disambiguated name — `Options (Sapiens)` — because *a name clash is not evidence
of identity*; the dialog offers a per-item "same as the existing note" tick, and
only a tick writes `same_as:: [[Options]]`, which is what `buildGraph` collapses
into one dot. The same idea under *another* name never clashes, so with talk on
the plan also proposes a twin for a `new` note (`sameAs.ts`): the staged notes
are embedded as the index embeds a note and a vault note is proposed only when
the two are each other's closest match — mutual nearest neighbour, floored by
the vault's own "related" threshold, no cutoff to tune. Shown unticked; a tick
writes the same `same_as::` line. A tick means "same as the twin I was shown":
the plan is recomputed at merge time, and a tick whose entry no longer has that
twin — a note of the exact name appeared meanwhile, turning the proposal into a
clash with a stranger — is dropped, never redirected (`confirmedSameAs`). Merge writes its manifest first and copies via temp + rename, so a
crash never leaves un-undoable files; **Undo** hashes each file and sends anything
you edited to the Trash instead of deleting it.

## Ingestion — the converter seam

The seam is `convertDocument()` in `convert.ts`: **one switch on the file
extension**, each arm a pure-JS library. No native build, no Python — the
lean-installer discipline from [talk-to-docs.md](talk-to-docs.md). That switch is
the whole abstraction, and it is deliberately small: adding a format is one more
arm, and everything downstream is format-agnostic. A scanned PDF (no text layer)
fails loudly, so the user re-digitizes it instead of getting a silent empty run.

MarkItDown (Python) is the fidelity bar we compare against, and it stays an
**option, not a promise**:

- **MarkItDown via its MCP server** (`markitdown-mcp`, runnable over NPX, no
  Docker) could become another arm of the switch for users who run it —
  Python-grade fidelity without us shipping Python. Nothing in the app depends on
  it today, and no `DocumentConverter` interface is built: there is one function,
  because one function is what the callers need. If a second converter ever ships
  it gets its own trust / lifecycle / error model, and it stays **out** of
  `provider.ts`, which is embed/chat only.
- The pure-JS Node ports (`markitdown-ts`, `markitdown-js`) are the same kind of
  option — a swap of one arm.
- **Avoid** wrappers that shell out to the Python package (e.g.
  `@mote-software/markitdown`) as a default: they reintroduce a Python dependency.

## What's genuinely new vs. risky

- **Format ingestion** is the one real new dependency surface — mitigated by the
  one-function seam above; markdown/text books need none of it.
- **Fidelity.** Grounding every claim in a clickable span is the anti-hallucination
  safeguard — the user *verifies*, not trusts. Unique-match grounding is what makes
  that real: a quote that could be in two places is dropped, not attached to a
  guess.
- **Cost.** A whole book is many chunks, and the model now sees all of them. The
  bound is `maxCalls`, not sampling: one call per window, windows as large as the
  model's context allows, and an honest coverage number when a document exceeds
  the budget. The provider abstraction lets the user pick local vs cloud.

## Many maps per vault — perspectives, versions, seeds

A distillation **run is not "the map" — it's *a* map**, and that's the right model.
Users understand an LLM run is a fresh generation, so re-running to get a brand-new
map is expected, not a surprise to guard against. This falls straight out of the
existing model where **`.map.md` is just a file**: a vault can hold many.

So a run = a **named, self-contained artifact**. As built, that artifact is
`<vault>/.distill/<runId>/` — the run's notes plus its own `run.db`, rendered by
the same `GraphView` the vault map uses; re-distilling the same document gives
`<name>-2`, `<name>-3`, side by side. (The design originally wrote the view as a
`.map.md` file per run; a per-run database renders the same picture and needs no
round-trip rules.) Because each run lives in its own namespace:

- **No clobbering** — re-running as v2 never touches your edits in v1; you keep,
  compare, or discard whole runs.
- **Perspectives are first-class** — the same book distilled "by theme" vs "by
  chronology" vs "by argument" (different extraction prompts) are just different
  artifacts side by side. Several lenses on one source coexisting *is* the
  knowledge-management win. *Prompt presets are not built yet;* re-running the same
  document already gives you side-by-side runs.
- **Comparable** — each run's `meta.json` stamps the source hash, model, provider,
  prompt version, date, settings and coverage, so runs can be told apart and a
  stale one recognised.

This generalizes beyond distillation: "multiple saved views/perspectives" is
equally useful for the hand-curated map (mindmap-mode's "Save view → `.map.md`" can
write many).

## Phasing

The original D-phases, and where they landed:

- ✅ **D1. Markdown/text books** → cited notes as a named run artifact. Shipped,
  then rebuilt: the pipeline no longer clusters chunks to decide what to read.
- ✅ **D2. Provenance UX** — a citation opens the source at its span; the panel
  lists a note's sources with `where:` ("Page 42"), and the document's note has
  **Open original**.
- ✅ **D3. PDF/EPUB/DOCX/HTML ingestion** via the extension switch, plus page
  anchors and PDF text cleanup.
- ◐ **D4. Perspectives & quality** — per-run metadata, extractive grounding and
  intra-run dedup shipped; **extraction prompt presets** and a "maps in this
  vault" browser are still open (the runs list in the sidebar is the browser's
  first half).

Later work landed outside those phases: reading the whole document with a concept
registry, retry/resume, the merge plan with confirmed `same_as`, the source store,
and themes.

Depends on talk-to-docs (embeddings + the model-provider abstraction) and composes
with auto-mindmap (clustering + map). Effectively **talk-to-docs inverted**:
exhaustive push-distill instead of question-pull, sharing the same substrate.

## Measurement — the eval harness

`npm run eval:distill` runs the real `distill()` pipeline over three fixtures —
`book-en` (seven Federalist Papers essays), `paper.pdf` (a generated ~20-page PDF
with a running header, page-number footers, and deliberately hyphenated line
breaks), and `chapter-ru.md` (a Chekhov story) — against hand-curated golden
concepts and edges (`e2e/fixtures/distill/golden.json`), and reports the metrics in
`src/main/distill/eval/metrics.ts`.

Both tables below use the deterministic stand-ins
(`src/main/distill/eval/stubs.ts`): a feature-hashing embedder and a regex-based
heuristic "chat" model, neither of which understands the text. **These are a floor,
not a target** — they measure the *plumbing* (does everything get read, do quotes
ground, do links resolve), not the quality of a real model's reading. A real
provider run is the actual quality signal to watch.

Reproduce with `npm run eval:distill` — it is deterministic (no network, no key)
and finishes in under a second. To score a real provider instead of the stub, set
`DISTILL_EVAL_PROVIDER` (plus `DISTILL_EVAL_MODEL` / `DISTILL_EVAL_BASE_URL` /
`DISTILL_EVAL_COMMAND` and the usual `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` as
needed), e.g.
`DISTILL_EVAL_PROVIDER=anthropic DISTILL_EVAL_MODEL=claude-sonnet-4-6 npm run eval:distill`.

### Live run — the real app, real vectors, a real model (2026-09-02)

`npm run test:e2e:live` (`e2e/live/distill-live.spec.ts`) drives the built app
over one essay (`federalist-84.md`, 25 KB) with the renderer's real embedding
model and Claude Code's CLI (Sonnet) as the chat provider — the two things the
stubbed suites cannot exercise. It is not part of `npm run test:e2e` (network, a
signed-in `claude`, minutes). It asserts what themes and dedup owe the reader:
every note under exactly one theme, theme names distinct from each other and
from every note's name, and in the document's language. Measured:

| windows | extracted | grounded | dropped | merged | notes | themes | edges | ghosts | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 49 | 49 | 0 | 5 | 44 | 7 | 136 | 0 | 6.4 min, first model download included |

Themes named: Federalist 84 Bill of Rights · Press Liberty Debate · Government
Expense Objection · Impeachment and Treason Provisions · Answering the Distance
Objection · Expanding National Powers · Cited Legal Authorities.

### Real provider — claude-cli, Sonnet, thinking off (2026-09-03)

`DISTILL_EVAL_PROVIDER=claude-cli DISTILL_EVAL_MODEL=sonnet npm run eval:distill`
— the first run of the harness against a real model. The embedder stays the
hash stub (a headless run has no renderer). 24 minutes for the three fixtures.

| fixture | yieldPer10k | coverage | dropped | failedWindows | merged | edgesPerNote | ghostLinkRate | components | duplicateTitleRate | conceptRecall | edgePrecision | edgeRecall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-en | 21.79 | 1.00 | 1.00 | 0.00 | 2.00 | 2.86 | 0.00 | 1.00 | 0.00 | 0.45 | 0.01 | 0.27 |
| paper.pdf | 21.13 | 1.00 | 0.00 | 0.00 | 6.00 | 2.68 | 0.00 | 1.00 | 0.00 | 0.43 | 0.01 | 0.18 |
| chapter-ru.md | 22.17 | 1.00 | 0.00 | 0.00 | 0.00 | 2.95 | 0.01 | 1.00 | 0.00 | 0.32 | 0.03 | 0.19 |

Read against the stub tables below. **Yield** is about one note per 460
characters on all three fixtures, twice the stub's on the English ones; the
stub's higher figure on the Russian story came from its short lines, not from
reading it. **Merges** fall from hundreds to 2 / 6 / 0: a model names a concept
once and reuses the name through the registry, so dedup has little left to do.
**Edges per note** settle near 3, and every fixture is one component with no
duplicate titles and at most one dropped quote. **`conceptRecall`** rises by
0.06–0.14 against the same hand-curated golden, **`edgeRecall`** three- to
fivefold. **`edgePrecision`** stays near 0.01, and that is a fact about the
golden, not the model: it lists a few dozen edges per fixture while a model
writes about three per note, so nearly every edge written is one the golden
never listed. The metric was redefined the next day — see below — and the
same three runs re-scored under the new rule.

### `edgePrecision` redefined — judged edges only (2026-09-03)

The old rule counted every predicted edge in the denominator, so an edge
between two concepts the golden never listed counted as wrong. A golden of
twenty-odd concepts has no opinion on most of a book, and a model that links
its notes three times each was scored against that silence. The new rule
scores only the edges the golden can judge:

- **`edgePrecision`** = of the predicted edges whose both endpoints resolve to
  two different golden concepts, the share that is a golden edge. An edge with
  an endpoint outside the golden is neither a hit nor a miss. Nothing judged
  scores 0, not 1.
- **`edgesJudged`** (new column) = how many predicted edges that was. A
  precision figure over 5 edges and one over 50 are not the same evidence, so
  the count sits beside it.
- Still a lower bound: the golden's edge list is a curated sample, not every
  true relation among its concepts. A real relation it happens not to list is
  scored as wrong. Growing the golden's edge list raises the ceiling; the
  concept list can stay as it is.

Tables dated before 2026-09-03 use the old rule. Every eval run now saves what
it scored (`scripts/out/run-<provider>-<fixture>.json`), and the same command
with `DISTILL_EVAL_REPLAY=1` re-scores those files instead of running the
pipeline, so the next metric change can be read against a real model's output
without paying for the model again.

Stub, re-scored (the pipeline is unchanged; only the last three columns moved):

| fixture | yieldPer10k | coverage | dropped | failedWindows | merged | edgesPerNote | ghostLinkRate | components | duplicateTitleRate | conceptRecall | edgePrecision | edgesJudged | edgeRecall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-en | 10.34 | 1.00 | 0.00 | 0.00 | 339.00 | 7.44 | 0.00 | 1.00 | 0.00 | 0.32 | 0.17 | 6.00 | 0.05 |
| paper.pdf | 14.00 | 1.00 | 0.00 | 0.00 | 225.00 | 6.85 | 0.00 | 1.00 | 0.00 | 0.29 | 0.00 | 2.00 | 0.00 |
| chapter-ru.md | 25.20 | 1.00 | 0.00 | 0.00 | 38.00 | 3.20 | 0.00 | 1.00 | 0.00 | 0.26 | 0.60 | 5.00 | 0.14 |

The stub's regex links land on golden pairs a handful of times per fixture —
too few judged edges to mean anything, which is the point of printing the
count.

Real provider, run again under the new rule — `DISTILL_EVAL_PROVIDER=claude-cli
DISTILL_EVAL_MODEL=sonnet npm run eval:distill`, 23 minutes, 2026-09-03:

| fixture | yieldPer10k | coverage | dropped | failedWindows | merged | edgesPerNote | ghostLinkRate | components | duplicateTitleRate | conceptRecall | edgePrecision | edgesJudged | edgeRecall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-en | 22.17 | 1.00 | 0.00 | 0.00 | 9.00 | 2.80 | 0.00 | 1.00 | 0.00 | 0.27 | 0.50 | 6.00 | 0.14 |
| paper.pdf | 21.65 | 1.00 | 0.00 | 0.00 | 9.00 | 2.89 | 0.00 | 1.00 | 0.01 | 0.43 | 0.50 | 4.00 | 0.09 |
| chapter-ru.md | 22.68 | 1.00 | 3.00 | 0.00 | 0.00 | 2.44 | 0.04 | 1.00 | 0.00 | 0.26 | 0.75 | 4.00 | 0.14 |

Two things to read off it. First, of the edges the golden can judge, the
model gets half to three quarters right — a lower bound, as said above, and
still only four to six judged edges per fixture, because a golden of twenty
concepts meets a run of a hundred notes at a few pairs. The number to grow is
`edgesJudged`, by listing more golden pairs among the concepts already there.
Second, this is a fresh run of the same model over the same fixtures as the
table above, and it is not the same run: `conceptRecall` on `book-en` came
out 0.27 where the earlier run had 0.45, and dedup merged 9 notes where it
had merged 2. Nothing in the pipeline between the two runs touched
extraction; that spread is the model's own. One run is one sample — compare
runs of the same fixture before reading a difference of a few hundredths as
a change in the pipeline.

### Baseline — Phase 1 (2026-09-02, cluster-sampling pipeline)

The starting point, kept for comparison: chunks were embedded, clustered, and only
four representatives per cluster reached the model. The column now called
`failedWindows` was `failedClusters` here — the same metric, renamed when windows
replaced clusters as the unit of reading.

| fixture | yieldPer10k | coverage | dropped | failedWindows | merged | edgesPerNote | ghostLinkRate | components | duplicateTitleRate | conceptRecall | edgePrecision | edgeRecall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-en | 5.36 | 0.34 | 0.00 | 0.00 | 84.00 | 1.83 | 0.01 | 5.00 | 0.00 | 0.27 | 0.00 | 0.00 |
| paper.pdf | 5.89 | 0.39 | 0.00 | 0.00 | 63.00 | 2.07 | 0.01 | 1.00 | 0.00 | 0.14 | 0.00 | 0.00 |
| chapter-ru.md | 13.61 | 0.56 | 0.00 | 0.00 | 18.00 | 1.48 | 0.00 | 1.00 | 0.00 | 0.21 | 0.06 | 0.10 |

### Final — after Phases 2–8 (2026-09-02, whole-document pipeline)

| fixture | yieldPer10k | coverage | dropped | failedWindows | merged | edgesPerNote | ghostLinkRate | components | duplicateTitleRate | conceptRecall | edgePrecision | edgeRecall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-en | 10.34 | 1.00 | 0.00 | 0.00 | 339.00 | 7.47 | 0.00 | 1.00 | 0.00 | 0.32 | 0.00 | 0.05 |
| paper.pdf | 14.00 | 1.00 | 0.00 | 0.00 | 225.00 | 6.82 | 0.00 | 1.00 | 0.02 | 0.29 | 0.00 | 0.00 |
| chapter-ru.md | 25.20 | 1.00 | 0.00 | 0.00 | 38.00 | 3.20 | 0.00 | 1.00 | 0.00 | 0.26 | 0.02 | 0.14 |

(Re-taken after the real-book fixes below: dedup no longer merges on a shared
span — a few fewer merges, a few more notes and edges; the stub's regex
extraction is otherwise untouched by them.)

What changed, and why:

- **`coverage` 0.34–0.56 → 1.00.** The whole document is read now. This is the
  headline result of the rebuild.
- **`yieldPer10k` roughly doubled** on every fixture — more of the text reaches the
  model, so more grounded notes come out of it.
- **`ghostLinkRate` → 0.00 and `components` 5 → 1** on `book-en`. Link remap plus
  the concept registry mean targets resolve and the run is one connected map, not
  five islands.
- **`edgesPerNote` 1.5–2.1 → 3.2–7.4** — the registry lets a window link to
  concepts named in earlier windows, and mention links add the edges the model
  forgot.
- **`conceptRecall` up, `edgePrecision`/`edgeRecall` still near zero.** Recall
  improves because more text is read; the edge scores stay low because the stub
  model writes relations from a regex, not from meaning. Only a real provider run
  can move those, which is exactly why they are reported separately: an acceptance
  gate on edges cannot be met by inventing links.
