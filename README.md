# Nodebook

[![CI](https://github.com/mrbald/nodebook/actions/workflows/ci.yml/badge.svg)](https://github.com/mrbald/nodebook/actions/workflows/ci.yml)
[![Security](https://github.com/mrbald/nodebook/actions/workflows/security.yml/badge.svg)](https://github.com/mrbald/nodebook/actions/workflows/security.yml)
[![Protected by Gitleaks](https://img.shields.io/badge/protected%20by-gitleaks-1c1c1c?logo=gitleaks&logoColor=white)](https://github.com/gitleaks/gitleaks)
![code style: eslint](https://img.shields.io/badge/code%20style-eslint-4B32C3?logo=eslint&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/gt9gt7cvwmg)

A source-mode Markdown notebook with a built-in knowledge index. Your notes stay
plain `.md` files on disk; Nodebook adds `[[wikilinks]]`, backlinks, full-text
search, and a relation/triple store on top — a rebuildable cache, never a second
source of truth.

Built on Electron + React + CodeMirror 6, with a `better-sqlite3` (FTS5 + triple
store) index in the main process.

## Features

- **Three editing modes**, switched from a bottom-right status bar (or ⌘1/2/3):
  - **Code** — raw Markdown with syntax highlighting; ⌘/Ctrl-click follows links.
  - **Live** — Obsidian-style hybrid: markers hidden except under the cursor.
  - **Reading** — fully styled, read-only.
- **`[[wikilinks]]`** with `[[`-autocomplete from the vault, clickable pills, and
  a **backlinks panel** grouped by relation type.
- **Full-text search** (FTS5) with highlighted snippets.
- **Talk to docs** — opt-in **AI semantic search** over your notes. Fully local
  and private (on-device embeddings via `transformers.js` + `sqlite-vec`); nothing
  leaves your machine and no API key is needed. Off by default; once enabled, the
  search box fuses keyword + meaning automatically (✨ marks meaning-matched hits).
  See [docs/talk-to-docs.md](docs/talk-to-docs.md).
- **Distill a document** — turn a **PDF, EPUB, .docx, HTML, Markdown or text** file
  into small, linked notes (**File ▸ Distill a Document…**; needs a chat provider).
  Nodebook reads the **whole** document in order, one model call per window sized
  to the model's context, each call carrying the concepts already named — so one
  idea keeps one name and links reach across the book. Every point carries a
  **citation**: a verbatim quote, accepted only where it occurs **uniquely** in the
  document, with the **page or section** beside it; unbacked points are dropped,
  not guessed. Notes are grouped under named **themes**, so the map reads
  book → themes → notes. The run stages in `<vault>/.distill/` behind its own
  index — readable, but invisible to search and the vault graph — until **Merge**
  copies it in; merge plans the write, never overwrites a note of yours, and
  **Undo** trashes (not deletes) anything you edited. The book itself lands once in
  `Sources/`, with **Open original** back to the real file.
  See [docs/distill-documents.md](docs/distill-documents.md).
- **Knowledge index** — `[[links]]` and `key:: value` fields are harvested into a
  triple store (`subject, relation, object`).
- **Knowledge map** — a force-directed graph (the **⊹ Map** button): local or global,
  pan/zoom, **PageRank-sized** nodes (the hubs), **cluster-coloured** communities,
  relation-coloured edges, "ghost" nodes for uncreated links; click to recenter, live
  on save. With Talk-to-docs on, an opt-in **✨ Related** overlay adds dashed edges to
  *semantically similar but unlinked* notes. Derived from the index, never hand-drawn.
- **`.map.md`** files render as a collapsible map (indentation = containment,
  `## Edges` = relations).
- **App-wide themes** (dark/light/system + several presets) — quick-switch from
  the status bar; the whole app and the editor recolor together.
- **Performance telemetry** (opt-in) — a tiny status-bar widget with a
  log-bucketed **event-loop lag** histogram, worst-spike exemplars, and rolling
  CPU/RAM. "Measure everything"; aims to never land a sample in the slowest bucket.
- **Export to PDF** / Print; **explicit-save** model (⌘S) with optional autosave.
- Plain-files first: atomic writes, the index lives in `<vault>/.nodebook/` and
  is safe to delete. Distilled runs you haven't merged yet live in
  `<vault>/.distill/` — durable staging, not a cache: keep it, and back it up if
  those runs matter.

## Prerequisites

- **Node.js 22.13+ or 24+** and npm. Node 20 is no longer enough:
  `better-sqlite3` needs 22 and `pdfjs-dist` needs 22.13.
- **No compiler needed.** The native pieces — `better-sqlite3` (the index) and
  `sqlite-vec` (the vector layer) — ship prebuilt binaries for macOS, Linux and
  Windows on x64 and arm64. `better-sqlite3` is a Node-API addon, so the same
  binary works under both Node and Electron with no rebuild step.
  - Anywhere else (a 32-bit ARM board, FreeBSD, …) there is no prebuilt binary
    and nothing compiles one for you, so you have to build `better-sqlite3`
    from source yourself. That needs a C/C++ toolchain: Xcode Command Line
    Tools (`xcode-select --install`) on macOS, `build-essential` and Python 3
    on Linux, or the "Desktop development with C++" workload on Windows.

## Quick start

```bash
npm install      # installs deps; native modules arrive prebuilt, nothing compiles
npm run dev      # launches the app with hot reload
```

In the app: click **Open vault**, pick a folder of `.md` files, then click a note
to edit it.

### If `npm run dev` fails with `Error: Electron uninstall`

Electron's prebuilt binary did not download during install. Fetch it once:

```bash
node node_modules/electron/install.js
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development with hot reload. |
| `npm run build` | Build the production bundles into `out/`. |
| `npm start` | Preview the production build. |
| `npm run typecheck` | Type-check the main/preload and renderer projects. |
| `npm test` | Run the fast unit tests (Vitest, no browser). |
| `npm run test:e2e` | Build, then run the end-to-end tests (Playwright drives the real app). |

## Downloads & releases

Tagged releases publish signed-or-unsigned installers for **macOS** (`.dmg`/`.zip`),
**Windows** (NSIS installer + portable), and **Linux** (`AppImage`/`.deb`) via
GitHub Actions. See the [Releases](https://github.com/mrbald/nodebook/releases)
page, and [RELEASING.md](RELEASING.md) for the release + code-signing setup.

## Project layout

```
src/
  main/        Electron main process: window, IPC, atomic file writes,
               the SQLite index (indexer.ts) and the harvest parser (harvest/)
  preload/     contextBridge API exposed to the renderer (+ its types)
  renderer/    React app + the CodeMirror 6 editor island (src/editor/)
  shared/      types and the markdown wikilink grammar used by both sides
e2e/           Playwright end-to-end tests and fixture vault
```

## How it works (one paragraph)

The editor is CodeMirror 6 mounted as an imperative island: React hands it the
document once and reads content back out via an update listener. Saves are atomic
(write temp file, `fsync`, rename). On save — and on external edits caught by a
file watcher — the changed file is re-parsed and its rows in the index are
replaced (delete-then-insert). The index lives in `<vault>/.nodebook/` and is
safe to delete; it rebuilds on next open. Distilled runs are kept separately in
`<vault>/.distill/` (a dot-dir, so the same scan/watcher firewall applies): that
is **durable staging**, written atomically, and an unmerged run exists nowhere
else — its own `run.db` is a cache that rebuilds from the run's markdown, but the
markdown itself is not reproducible. Runs left in the old
`<vault>/.nodebook/distill/` are moved across automatically the next time the
vault is opened.

## Contributing & license

Nodebook is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
Commercial licensing (for use that can't comply with the AGPL) may be available
— open an issue to ask. If you'd like to support development, there's a
[Buy Me a Coffee](https://www.buymeacoffee.com/gt9gt7cvwmg) button. ☕

_Most of the code is written with the assistance of industrial coding agents —
primarily Anthropic's Claude — while the original ideas and design are my own._
