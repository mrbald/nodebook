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

## View modes

Switch from the bottom-right status bar, or with the keyboard:

| Mode | Shortcut | Shows |
|---|---|---|
| **Code** | ⌘1 | Raw Markdown + syntax highlighting; ⌘/Ctrl-click follows a link |
| **Live** | ⌘2 | Markers hidden except under the cursor (the default) |
| **Reading** | ⌘3 | Fully styled, read-only |

**⌘E** toggles Live ⇄ Reading · **⌘S** saves · **⌘P** prints / exports a PDF.
