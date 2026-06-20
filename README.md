# Nodebook

A source-mode Markdown notebook with live preview, `[[wikilinks]]`, backlinks,
and a local full-text + relation index. Your notes stay plain `.md` files on
disk; the index is a rebuildable cache.

Built on Electron + React + CodeMirror 6, with a `better-sqlite3` (FTS5 +
triple store) index in the main process.

## Prerequisites

- **Node.js 20.19+ or 22.12+** and npm.
- A C/C++ toolchain — `better-sqlite3` is a native module and is compiled
  during install.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux: `build-essential` (gcc/g++, make) and Python 3.
  - Windows: the "Desktop development with C++" workload (Visual Studio Build
    Tools).

## Quick start

```bash
npm install      # installs deps and rebuilds better-sqlite3 for Electron
npm run dev      # launches the app with hot reload
```

In the app: click **Open vault**, pick a folder of `.md` files, then click a
note to edit it.

### If `npm run dev` fails with `Error: Electron uninstall`

Electron's prebuilt binary did not download during install. Fetch it once:

```bash
node node_modules/electron/install.js
```

Then re-run `npm run dev`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development with hot reload. |
| `npm run build` | Build the production bundles into `out/`. |
| `npm start` | Preview the production build. |
| `npm run typecheck` | Type-check the main/preload and renderer projects. |
| `npm test` | Run the fast unit tests (Vitest, no browser). |
| `npm run test:e2e` | Build, then run the end-to-end tests (Playwright drives the real app). |

Packaging into a distributable (`.dmg`/`.AppImage`/`.exe`) uses
`electron-builder` and the config in `electron-builder.yml`; a packaging script
will be added when the app is ready to ship.

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
document once and reads debounced content back out. Saves are atomic
(write temp file, `fsync`, rename). On save — and on external edits caught by a
file watcher — the changed file is re-parsed and its rows in the index are
replaced (delete-then-insert). The index lives in `<vault>/.nodebook/` and is
safe to delete; it rebuilds on next open.
