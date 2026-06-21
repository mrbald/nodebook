# Nodebook

[![CI](https://github.com/mrbald/nodebook/actions/workflows/ci.yml/badge.svg)](https://github.com/mrbald/nodebook/actions/workflows/ci.yml)
[![Security](https://github.com/mrbald/nodebook/actions/workflows/security.yml/badge.svg)](https://github.com/mrbald/nodebook/actions/workflows/security.yml)
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
- **Knowledge index** — `[[links]]` and `key:: value` fields are harvested into a
  triple store (`subject, relation, object`).
- **`.map.md`** files render as a collapsible map (indentation = containment,
  `## Edges` = relations).
- **App-wide themes** (dark/light/system + several presets) — quick-switch from
  the status bar; the whole app and the editor recolor together.
- **Export to PDF** / Print; **explicit-save** model (⌘S) with optional autosave.
- Plain-files first: atomic writes, the index lives in `<vault>/.nodebook/` and
  is safe to delete.

## Prerequisites

- **Node.js 20.19+ or 22.12+** and npm.
- A C/C++ toolchain — `better-sqlite3` is a native module compiled during install.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux: `build-essential` (gcc/g++, make) and Python 3.
  - Windows: the "Desktop development with C++" workload (Visual Studio Build Tools).

## Quick start

```bash
npm install      # installs deps and rebuilds better-sqlite3 for Electron
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
safe to delete; it rebuilds on next open.

## Contributing & license

Nodebook is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
Commercial licensing (for use that can't comply with the AGPL) may be available
— open an issue to ask. If you'd like to support development, there's a
[Buy Me a Coffee](https://www.buymeacoffee.com/gt9gt7cvwmg) button. ☕

_Most of the code is written with the assistance of industrial coding agents —
primarily Anthropic's Claude — while the original ideas and design are my own._
