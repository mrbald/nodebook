# Nodebook — Markdown & Syntax

Nodebook reads and writes plain Markdown files. On top of standard Markdown it
adds a few light conventions for linking and structured knowledge. This page is
shown in **Reading** mode — press **⌘1** (Code) to see its raw source.

## Markdown flavor

Nodebook supports **CommonMark** plus **GitHub Flavored Markdown (GFM)**:

- Headings `#` … `######`, **bold**, *italic*, `inline code`, ~~strikethrough~~
- Lists (`-`, `1.`) and task lists `- [ ]` / `- [x]`
- Links `[text](url)`, images `![alt](url)`, and bare/autolinked URLs
- Blockquotes `>`, horizontal rules `---`, and tables
- Fenced code blocks with **per-language highlighting** — put the language
  after the opening fence:

```js
const greet = (name) => `hello, ${name}`
```

````
```python
def greet(name): return f"hello, {name}"
```
````

## Wikilinks

Link between notes with double brackets:

- `[[Note Name]]` — link by note title / filename
- `[[folder/Note]]` — link by path
- `[[Note|shown text]]` — custom display text
- `[[Note#Heading]]` — point at a heading

Type `[[` to autocomplete from your vault. Wikilinks are clickable, and every
note lists its **backlinks** (which notes link here) in the right-hand panel.

## Fields — `key:: value`

Add structured data to a note with inline fields:

```
status:: active
author:: [[Ada Lovelace]]
due:: 2026-07-01
```

Each `key:: value` line becomes a **triple** `(this note, key, value)` in the
index — the same store that powers backlinks. (A `[[link]]` is just the triple
`(this note, links_to, target)`.) Fields inside fenced code blocks are ignored.

## Maps — `.map.md`

A file whose name ends in `.map.md` renders as a collapsible **map** instead of
text:

- **Indentation = containment** — nested bullets become a tree
- A `## Edges` section with `[[A]] relation [[B]]` lines declares relations

## Knowledge map

Click **⊹ Map** in the bottom bar to see the current note as a dot, with lines to
the notes it links to. The map is drawn for you from your links — you never arrange
it by hand, and nothing here changes your notes.

- **Getting around** — **drag a note to arrange it**, drag the empty space to move
  the whole map, scroll to zoom. **Click a note** to see its details in the panel on
  the right; **double-click** to recentre the map on it, or use **Open ↗** in the
  panel to open it in the editor. **−/+** show fewer or more steps out from the note;
  **Global** shows the whole vault instead of just this note's neighbourhood;
  **⟲ reset view** undoes your zoom, pan, and any drags or pins.
- **The panel on the right** — with nothing selected it shows the map's totals and the
  colour legend. **Click a note** and it shows that note's links — out and in, plus
  **Expand** (pull in that note's own links without growing the rest of the map) and
  **Pin** (keep the note fixed so it anchors the map while the rest rearranges).
- **Big vaults** — **Global** shows the most-connected notes first; a **show more**
  appears in the panel when there are extra notes beyond what's drawn.
- **Naming a link** — for a plain `[[link]]`, the **+ name** button in the panel lets
  you label the relationship (say `cites` or `author`). It's written straight back into
  the note as a `key:: value` field, so the map and your notes never disagree — and the
  link is redrawn in its new colour.
- **Layout** — the **layout** dropdown chooses an **organic web** (force), a tidy
  **hierarchical tree** that reads like a mind map, a **radial** view that rings notes
  around the one in focus, or **groups**, which gathers each cluster of related notes
  into its own area.
- **What the picture means** — **bigger dots are more connected** (your hub notes);
  **line colour is the link type** (a plain `[[link]]` vs. a `key:: value`); a
  **dashed outline** is a note you've linked to but haven't created yet.
- **Colour** — the **colour** button recolours the dots: by **links** (notes that
  clump together get the same colour), by **folder** (which folder each note is in),
  or by **meaning** (groups by topic — needs Talk to docs on).
- **Tidying the view** (just this view — your notes are untouched) — **click a link
  type in the legend** to show/hide it; **right-click a dot to hide it** for now;
  **reset** brings everything back. Closing the map forgets these tweaks.
- **✨ Related** (only when Talk to docs is on) — adds **dashed green lines** to notes
  that *seem related by meaning* even though you never linked them: a hint of links
  you might want to add. The **✨ Related** button turns it off.

## Talk to docs — semantic search

AI-assisted **search by meaning** over your notes, on top of keyword search. It is
**off by default**; turn it on from the **✨ Search by meaning** link under the
search box.

- **Local & private** — embeddings are computed on your machine with a small model
  that downloads once on enable. Your notes never leave your computer; no API key.
- Once on, the search box **fuses keyword + meaning** automatically — there is no
  mode to switch. A **✨** marks hits surfaced by meaning.
- Indexing runs in the background; new and edited notes are re-embedded on save.
- Fully **reversible** — *Turn off* drops the embeddings (they live in
  `<vault>/.nodebook/`, rebuildable by re-enabling).

## Ask your notes

A chat that **answers questions from your notes**, with the source notes listed. It
appears as **💬 Ask your notes** in the sidebar once you've set a chat provider in
Settings (`[talk.chat]`).

- **Set a provider** — choose one in Settings (`[talk.chat] provider`):
  - `ollama` — **local & private, no key.** A model on your own machine via
    [Ollama](https://ollama.com): install it, run `ollama pull llama3.2`, set
    `model = "llama3.2"`. Nothing leaves your computer.
  - `anthropic` — Claude (cloud); set `ANTHROPIC_API_KEY` in your environment.
  - `openai-compat` — any OpenAI-style endpoint (OpenAI, a gateway, or LM Studio)
    via `baseUrl`; set `OPENAI_API_KEY` if it needs one.
  - `none` keeps things search-only.

  Prefer the environment variable for keys; you *can* put one in the settings
  file, but it's stored in plain text.
- **Grounded + cited** — only the most relevant passages from your notes are sent to
  the model (never your whole vault); the answer streams in, and the notes it used are
  listed as **Sources** you can click to open.
- Best with Talk-to-docs **on** (its embeddings power the retrieval).

## Performance telemetry

Set `[telemetry] enabled = true` in Settings to show a tiny widget at the left of
the status bar: a **rolling 5-minute** view of **event-loop lag** (a log-bucketed
histogram, <1 ms … ≥8192 ms), CPU, and memory. Click it for max / p99 / mean and
the worst recent spikes. The goal: never land a sample in the slowest bucket.
Off by default. ("Measure everything" — inspired by the *ufw/pfw* metrics library.)

## View modes

Switch from the bottom-right status bar, or with the keyboard:

| Mode | Shortcut | Shows |
|---|---|---|
| **Code** | ⌘1 | Raw Markdown + syntax highlighting; ⌘/Ctrl-click follows a link |
| **Live** | ⌘2 | Markers hidden except under the cursor (the default) |
| **Reading** | ⌘3 | Fully styled, read-only |

**⌘E** toggles Live ⇄ Reading · **⌘S** saves · **⌘P** prints / exports a PDF.
