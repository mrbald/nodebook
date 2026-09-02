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

## Vaults, notes & the file tree

A **vault** is just a folder of Markdown files. Open one with **File ▸ Open
Vault** (⌘O); ones you've opened before are under **File ▸ Open Recent**. Start a
fresh one with **File ▸ New Vault…**.

- **New note** — **File ▸ New Note** (⌘N), or right-click a folder in the tree.
- **Organise** — right-click any file or folder in the sidebar tree to **rename**
  or **delete** it, or make a **new note/folder** inside it. Deleting moves the
  files to the system **Trash**, so you can get them back. Edits made on disk
  show up in the tree automatically.
- **Save** — **File ▸ Save** (⌘S). Saving is explicit by default; a dot marks an
  unsaved note (turn on autosave in Settings if you prefer).

## Finding notes

Type in the **search box** at the top of the sidebar to find notes by their text,
then click a result to open it. With **Talk to docs** on (below), the same box
also finds notes by *meaning* — those hits are marked with ✨.

## Settings

Open settings with **Preferences** (⌘,) or the **⚙ Settings** button. They're a
small **TOML** file you edit in place; changes apply as soon as you save (⌘S).
**Reveal defaults** shows every option with its default value next to yours, and
**Reset to defaults** restores the original file.

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
  around the one in focus, **groups**, which gathers each cluster of related notes
  into its own area, or **blocks**, which keeps tightly-linked notes together by
  repeatedly splitting the map into halves with the fewest links crossing the divide.
- **What the picture means** — **bigger dots are more connected** (your hub notes);
  **line colour is the link type** (a plain `[[link]]` vs. a `key:: value`); a
  **dashed outline** is a note you've linked to but haven't created yet.
- **Two notes, one name** — if two notes share a name (in different folders) the map
  draws them as **two separate dots**, and the panel says how many links *could point
  to more than one note* — a link like that is matched to a note in the same folder
  when there is one, so the map never quietly merges two notes into one.
- **Colour** — the **colour** button recolours the dots: by **links** (notes that
  clump together get the same colour), by **folder** (which folder each note is in),
  or by **meaning** (groups by topic — needs Talk to docs on).
- **Tidying the view** (just this view — your notes are untouched) — **click a link
  type in the legend** to show/hide it; **right-click a dot to hide it** for now;
  **reset** brings everything back. Closing the map forgets these tweaks.
- **✨ Related** (only when Talk to docs is on) — adds **dashed green lines** to notes
  that *seem related by meaning* even though you never linked them: a hint of links
  you might want to add. The **✨ Related** button turns it off.
- **Focused maps** — the map always starts from the note you have open, so the way to
  map an *aspect* is: open a note at its centre, press **⊹ Map**, and widen with **+**
  until it tells the story. Hide link types (legend) or notes (right-click) that don't
  belong. These tweaks are temporary by design — for a view worth keeping, write a
  `.map.md` note (see **Maps** above): that's a real file, and it renders as a map
  every time you open it.
- **Distilled documents** — notes distilled from a document all link back to it, and
  those "from the same book" lines would swallow the picture. The map hides the
  document's own node by default; the **📕 Source** button brings it back. A whole
  book is never one of the "most connected notes" on a **Global** map either — it
  is what your notes are about, not one of them.
- **Two names, one note** — when you told Merge that a distilled note is the same
  thing as one you already had, the map draws them as one dot and lists the other
  name under **also known as** when you click it. That decision is a plain
  `same_as:: [[Other note]]` line in the note — delete it and they split apart again.

## Talk to docs — semantic search

AI-assisted **search by meaning** over your notes, on top of keyword search. It is
**off by default**; turn it on from the **✨ Search by meaning** link under the
search box.

- **Local & private** — embeddings are computed on your machine with a model that
  downloads once on enable (~285 MB). Your notes never leave your computer; no API key.
- **Any language** — the model understands ~100 languages in one index: write notes
  in English, Russian, Chinese, … and search across all of them in whichever
  language you ask. (All-English vault and want a ~34 MB model instead? Set
  `[talk.embed] model = "Xenova/bge-small-en-v1.5"` in Settings — English-only.)
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
  - `codex-cli` — already pay for **ChatGPT** and have its **Codex** command-line
    app installed and signed in? Turn this on and skip the API key entirely.
    Nodebook runs the Codex app on your own computer; what you ask counts
    against your ChatGPT plan's usage limits, and the answer appears all at
    once rather than streaming in.
  - `claude-cli` — the same, for a **Claude** plan and the **Claude Code**
    command-line app: install it, run `claude auth login`, no API key. What you
    ask counts against your Claude plan's usage limits. Answers stream in as
    they're written. Nodebook runs it with no tools and no access to your files
    — it only answers the question it is given.
  - `cli` (advanced) — runs any command you supply: your question goes to the
    command, and whatever it prints comes back as the answer. For anyone
    comfortable with a terminal.
  - `none` keeps things search-only.

  Prefer the environment variable for keys; you *can* put one in the settings
  file, but it's stored in plain text.
- **Grounded + cited** — only the most relevant passages from your notes are sent to
  the model (never your whole vault); the answer streams in, and under it you can see
  exactly which notes it **cited** and which were merely **sent to the model** — click
  either to open the note.
- Best with Talk-to-docs **on** (its embeddings power the retrieval).

## Distill a document

Turn a long document — a **PDF, EPUB, Word (.docx), HTML, Markdown, or plain-text**
file — into a set of small, linked notes, each backed by **quotes from the
original**. Start it with **File ▸ Distill a Document…** (it needs a chat
provider, same as Ask). Legacy binary `.doc` isn't readable — save it as `.docx`
first.

- **What happens** — Nodebook reads the whole document from start to finish, in
  steps, and asks the model to write one short note per concept. Each step is told
  which concepts the earlier steps already named, so the same idea keeps one name
  and notes link across the document. Every claim in a note carries a **citation**:
  a real quote from the document. If the model can't back a point with a verbatim
  quote, that point is dropped — not guessed.
- **Quotes are checked against the whole document** — a point is kept only when its
  quote is found **exactly once** in the document (if the model pointed at the wrong
  passage, Nodebook finds the right one and corrects it); a quote that isn't there, or
  that could be in two different places, is dropped rather than guessed at. The banner
  after a run says how many were dropped and why.
- **Themes** — a distilled run groups its notes under a handful of theme notes, so
  the map reads book → themes → notes; the sidebar lists a run's themes under it.
- **The notes are linked to each other** — when one note's text names another, Nodebook
  adds a link between them; and when two notes turned out to be the same idea and were
  merged, links written for either name still land on the note that survived.
- **Nothing touches your vault yet** — the result opens as its **own map**, kept in a
  staging area. Explore it like the knowledge map. The **⧉ Overlay** button shows your
  vault and the run *together* (a preview — still nothing written). Where the run and
  your vault both have a note of the same name, you see **both dots joined by a dotted
  line** — the clash a merge would have to settle, shown rather than silently merged.
- **Runs are kept** — every distilled run appears under **Distilled runs** in the
  sidebar until you discard it, so closing the map loses nothing. Click a run to
  reopen its map; **✕** discards it. A run that hasn't been merged yet lives only in
  the vault's `.distill/` folder — keep that folder and back it up if your unmerged
  runs matter. (`.nodebook/` beside it is just a cache and is safe to delete.)
- **Read a run before you merge it** — click a note on the run's map to read it, with
  its quotes, without adding anything to your vault. Click one of its **Sources** and
  the run's own copy of the document opens at that passage, with the quote
  highlighted, so you can check it. **← Back to map** returns.
- **Cancel any time** — the **Cancel** button on the progress toast stops a run.
  Only one document can be distilled at a time.
- **Nothing is wasted** — a run that you cancel, or that stops because the model
  stopped answering, keeps everything it had already read. It stays under
  **Distilled runs** marked *paused*; press **Resume** and it carries on from where
  it stopped instead of starting over. A call that fails for a passing reason (a
  busy server, a dropped connection) is simply tried again, and a passage the model
  never manages to read costs that passage, not the run.
- **What it will cost** — before it starts, the progress toast says how many passages
  the document has and how many steps reading them will take. If a document needs
  more steps than your budget allows, Nodebook asks first, and says what share of
  the text the cheaper answer reads.
- **Merge when happy** — **⤓ Merge** copies the run's notes into your vault under a
  `Distilled/…` folder. It's reversible: **Undo** in the banner removes exactly what
  was written. Any merged note you edited afterwards is moved to the **Trash**
  instead of being deleted, so your edits are always recoverable.
- **Merge never writes over a note of yours** — before it copies anything, Merge tells
  you how many notes are new, how many you already have word-for-word (those are
  skipped), and which share a name with a note you already have. A shared name is
  saved beside yours as “Name (Book)” — because two notes with one name aren't
  necessarily about the same thing. If they *are*, tick **same as the existing note**
  next to it and the map will show them as a single note from then on, with the other
  name listed beside it.
- **Click a citation** — a distilled note lists its **Sources** in the right-hand
  panel — each one shows **where the passage is** (“Page 42”, or the chapter's
  name) and the quote itself. Clicking one opens **Nodebook's own copy** of the
  document at that passage, with the quote highlighted, so you can read around it.
  If that copy is edited later the citation still finds its passage: it is
  anchored to the quote itself, not to a position that drifts.
- **Open the original file** — open the document's own note and the panel shows
  where the file came from, with an **Open original** button that opens it in
  whatever app your system uses for PDFs, EPUBs and the rest.
- **The document is saved once** — merging puts the book itself in a **`Sources/`**
  folder, under its title. Distil the same document again and both runs share that
  one copy; Undo only removes it once no run still points at it.
- **A document is searchable, never a hub** — the book's own note is found by
  search and by Ask, but it isn't drawn as a big dot on your knowledge map and it
  isn't counted as “related” to your notes. It's the thing your notes are about,
  not one of them.
- **PDF text is cleaned up first** — the header and page number printed on every
  page are dropped, words split across a line break (“consid-erations”) are put
  back together, and the printed line breaks become real paragraphs. The page
  numbers stay as headings, so a citation can still say which page it came from.
- **Very long documents** — a run reads everything up to a budget of **120 model
  calls** (`[distill] maxCalls` in Settings). Past that it reads evenly spaced steps
  instead of stopping, and the banner says what share of the text that was. Two more
  settings shape the steps: `[talk.chat] contextTokens` says how much your model
  accepts in one go (bigger = fewer, longer steps), and `[distill] windowSize` forces
  a step size instead of working one out. If your model refuses a step for being too
  long, Nodebook splits it in two and reads both halves — nothing is skipped.
- **The document's node** — every distilled note links back to the document it came
  from. The run's own map shows that node (it's what the run is about), but once
  merged, your vault's knowledge map hides it — otherwise it sits in the middle of a
  giant star and swallows the picture. **📕 Source** toggles it in either view.

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

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open vault | ⌘O |
| New note | ⌘N |
| Save | ⌘S |
| Code / Live / Reading mode | ⌘1 / ⌘2 / ⌘3 |
| Toggle Live ⇄ Reading | ⌘E |
| Knowledge map | ⌘G |
| Settings (Preferences) | ⌘, |
| Print / export PDF | ⌘P |

On Windows and Linux, use **Ctrl** in place of **⌘**.
