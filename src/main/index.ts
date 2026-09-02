import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, relative, dirname, resolve, basename } from 'path'
import {
  promises as fs,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  realpathSync,
  statSync,
  writeFileSync,
  readFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { withinRoot, ignoredInVault } from './paths'
import chokidar, { type FSWatcher } from 'chokidar'
import type { MarkdownFile, MenuState, VaultListing } from '../shared/types'
import { VaultIndex } from './indexer'
import { overlayGraph } from './graph'
import { distill, probeChat, type DistillEmbedder } from './distill/run'
import { StagedRunStore } from './distill/staged'
import { convertDocument } from './distill/convert'
import { mergeRun, unmergeRun, readMergeManifest, readRunMeta } from './distill/artifact'
import { Telemetry } from './telemetry'
import {
  ensureSettingsFile,
  readSettings,
  setThemeMode,
  setTalkEnabled,
  settingsPath as settingsFilePath,
  settingsSyntaxError,
  chatProviderConfig,
  migrateEmbedModel,
  DEFAULT_TOML,
  type ThemeMode
} from './settings'
import { makeChatModel } from './rag/chat'
import { buildAppMenu } from './menu'
import { addRecent } from './recents'
import type {
  Citation,
  TalkStatus,
  DistillRunResult,
  DistillRunInfo,
  DistillDocument,
  DistillMergeResult,
  DistillMergeStatus,
  DistillUnmergeResult
} from '../shared/types'

// Expose SharedArrayBuffer to the renderer so onnxruntime-web can run its WASM
// threaded (embedding otherwise pins a single core). The renderer is never
// crossOriginIsolated (prod loads file://, which can't carry COOP/COEP
// headers), so this Chromium feature flag is the only route to SAB — verified:
// it works from here but NOT as a CLI switch. ort still needs an explicit
// numThreads because its auto path is gated on crossOriginIsolated (see
// embed.worker.ts). Must run before app is ready.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// Name the app so the macOS menu bar / dialogs say "Nodebook", not "Electron".
// (In `npm run dev` the bold app-menu title is still read from the Electron.app
// bundle and shows "Electron"; the packaged build uses productName "Nodebook"
// everywhere. setName fixes the submenu items + dialogs in both.)
app.setName('Nodebook')
app.setAboutPanelOptions({ applicationName: 'Nodebook' })

// Allow relocating the config/userData dir (used by tests for isolation, and
// useful for a portable install). Must run before app is ready.
if (process.env['NODEBOOK_USER_DATA']) {
  app.setPath('userData', process.env['NODEBOOK_USER_DATA'])
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'Nodebook',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload uses only contextBridge + ipcRenderer, so the renderer can
      // run fully sandboxed — a compromised page gets no Node capabilities.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // In e2e the window is driven over CDP and never needs OS focus, so show it
  // inactive — otherwise each test run pops a window that steals the keyboard
  // from whatever the developer is typing into.
  mainWindow.on('ready-to-show', () =>
    process.env['NODEBOOK_E2E'] ? mainWindow?.showInactive() : mainWindow?.show()
  )

  // Open real links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// Vault file discovery
// ---------------------------------------------------------------------------

const MD_EXT = /\.md$/i

/** Walk the vault for markdown files AND directories (so empty folders show). */
async function scanVault(root: string): Promise<VaultListing> {
  const files: MarkdownFile[] = []
  const dirs: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // Skip dotfiles/dirs — this covers .nodebook/ and .git/ explicitly.
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs.push(relative(root, full))
        await walk(full)
      } else if (entry.isFile() && MD_EXT.test(entry.name)) {
        files.push({ path: full, name: entry.name.replace(MD_EXT, ''), rel: relative(root, full) })
      }
    }
  }

  await walk(root)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  dirs.sort((a, b) => a.localeCompare(b))
  return { files, dirs }
}

/** Reject names that aren't a single safe path segment. */
function validName(name: string): string | null {
  const n = name.trim()
  if (!n || n === '.' || n === '..') return null
  if (/[/\\]/.test(n)) return null
  return n
}

/** True only if p is the vault root or strictly inside it. Resolves `..`/`.`
 *  segments first — a raw prefix check passes `/vault/../../etc/passwd`. */
function withinVault(p: string): boolean {
  return !!vaultRoot && withinRoot(vaultRoot, p)
}

// file:read / file:save serve note files (inside the vault) AND the settings
// file (in userData). Anything else is rejected, so a crafted path from the
// renderer can't read/overwrite arbitrary files.
function isAccessibleFile(p: string): boolean {
  return withinVault(p) || resolve(p) === settingsFilePath()
}

/** Absolute paths of every markdown file under `dir` (recursively, skip dotdirs). */
async function markdownUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && MD_EXT.test(e.name)) out.push(full)
    }
  }
  await walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Atomic write — the one place bytes hit disk. tmp + fsync + rename means a
// crash mid-write can never truncate or corrupt the user's note: the rename is
// atomic, so a reader sees either the old file or the complete new one.
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
}

// ---------------------------------------------------------------------------
// Index lifecycle — one VaultIndex + one chokidar watcher per open vault. The
// DB lives in <vault>/.nodebook/ (gitignored, rebuildable). Re-indexing is
// idempotent (delete-then-insert), so a save firing both our own re-index and
// the watcher's change event is harmless.
// ---------------------------------------------------------------------------

let index: VaultIndex | null = null
let watcher: FSWatcher | null = null
let vaultRoot: string | null = null
let distillRuns: StagedRunStore | null = null
const distillAbort = new Map<string, AbortController>()
// Exactly one distill run at a time: a second would race the first on the same
// run directory and clobber its AbortController. Claimed synchronously at the
// top of `distill:run`, released in its finally.
let activeRunId: string | null = null
// Documents the user picked to distill: an opaque id → the absolute path. The
// renderer only ever holds the id, so it cannot name a path of its own to run.
const pickedDocs = new Map<string, string>()
const telemetry = new Telemetry()

// Pending distill embed round-trips (the renderer WASM embedder answers main's
// requests over IPC), keyed by their reply channel. Tracked globally so a
// vault close can fail them fast instead of leaving `ipcMain.once` listeners —
// and the run awaiting them — hanging forever.
const pendingEmbeds = new Map<string, (err: Error) => void>()

// Staleness baseline for file:save — the mtime of each file as of the last
// time the app knowingly read or wrote it. A save whose on-disk mtime differs
// from the baseline would clobber someone else's bytes (an external edit, or a
// relation typed from the map while the buffer was dirty), so it is refused
// and the renderer surfaces the conflict. NOTE: index:typeRelation
// deliberately does NOT update the baseline — that mismatch is exactly what
// stops a stale editor buffer from overwriting the appended relation.
const knownMtime = new Map<string, number>()

/** Record `path`'s current mtime as the save-staleness baseline. */
function trackMtime(path: string): void {
  try {
    knownMtime.set(path, Math.floor(statSync(path).mtimeMs))
  } catch {
    knownMtime.delete(path) // vanished — recreating it later is always allowed
  }
}

async function closeVault(): Promise<void> {
  if (watcher) await watcher.close()
  watcher = null
  for (const ctrl of distillAbort.values()) ctrl.abort()
  distillAbort.clear()
  // Fail any in-flight embed round-trip now — otherwise its `ipcMain.once`
  // listener (and the run awaiting it) would hang until the timeout, or
  // forever if the renderer never replies (e.g. it reloaded mid-run).
  for (const fail of [...pendingEmbeds.values()]) fail(new Error('Vault closed while waiting to embed.'))
  pendingEmbeds.clear()
  pickedDocs.clear()
  distillRuns?.close()
  distillRuns = null
  index?.close()
  index = null
  vaultRoot = null
  knownMtime.clear()
}

async function indexPath(path: string): Promise<void> {
  if (!index) return
  try {
    const content = await fs.readFile(path, 'utf8')
    const { mtimeMs } = await fs.stat(path)
    index.indexFile(path, content, Math.floor(mtimeMs))
  } catch {
    // File vanished between event and read — treat as removal.
    index.removeFile(path)
  }
}

/** Tell the renderer the vault's file/dir set changed so it re-lists. */
function notifyVaultChanged(): void {
  mainWindow?.webContents.send('vault:changed')
}

/** Tell the renderer some notes were (re)chunked and need embedding. */
function notifyTalkDirty(): void {
  if (index?.talkOn) mainWindow?.webContents.send('talk:dirty')
}

/** Tell the renderer the index content changed (e.g. a save added a link), so
 *  derived views like the knowledge map can re-query. */
function notifyIndexChanged(): void {
  mainWindow?.webContents.send('index:changed')
}

/** Wikilink targets referenced in `text` — `[[Target]]` / `[[Target|Display]]`
 *  — matching the renderer's wikilink markdown rule (target is before `|` and
 *  `#`). Used to tell which retrieved sources an "Ask" answer actually cites.
 *  (Duplicated in the renderer's citations.ts: main and renderer don't share a
 *  module boundary — see tsconfig.node.json / tsconfig.web.json.) */
function wikilinkTargetsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    out.push(m[1].split('|')[0].split('#')[0].trim())
  }
  return out
}

function talkStatus(): TalkStatus {
  const enabled = readSettings().talk.enabled
  const counts = index?.talkCounts() ?? { total: 0, pending: 0 }
  return { enabled, ready: !!index?.talkReady, total: counts.total, pending: counts.pending }
}

/** Read + chunk every vault note not already chunked (used on live enable; the
 *  open scan already chunks when talk was pre-enabled, so those are skipped). */
async function chunkUnchunkedFiles(): Promise<void> {
  if (!index || !vaultRoot) return
  for (const p of await markdownUnder(vaultRoot)) {
    if (index.isChunked(p)) continue
    try {
      index.chunkFile(p, await fs.readFile(p, 'utf8'))
    } catch {
      // unreadable / vanished — skip
    }
  }
}

async function openVault(root: string): Promise<VaultListing> {
  await closeVault()
  vaultRoot = root
  index = new VaultIndex(join(root, '.nodebook', 'index.db'))
  distillRuns = new StagedRunStore(root)
  // If talk-to-docs is on, turn the vector layer on *before* the scan so each
  // indexed file is chunked in the same pass (content-hash gated, so unchanged
  // notes on reopen are skipped and never re-embedded).
  if (readSettings().talk.enabled) index.enableTalk()

  const listing = await scanVault(root)
  // Incremental re-open: skip files whose stored mtime matches the disk (their
  // rows are already correct — re-parsing the whole vault made every open
  // O(vault) instead of O(changed)). mtime 0 in the index means "unknown" and
  // never matches, so those files re-index. When talk is on, an unchanged file
  // is only skipped if its chunks exist (talk may have been enabled elsewhere).
  const known = index.knownFiles()
  for (const f of listing.files) {
    let mtime: number
    try {
      mtime = Math.floor((await fs.stat(f.path)).mtimeMs)
    } catch {
      continue // vanished mid-scan — nothing to index
    }
    const stored = known.get(f.path)
    if (stored !== undefined && stored !== 0 && stored === mtime) {
      if (!index.talkOn || index.isChunked(f.path)) {
        knownMtime.set(f.path, mtime) // still the save-staleness baseline
        continue
      }
    }
    await indexPath(f.path)
  }
  // Drop rows of files deleted while the app was closed (the watcher only
  // catches deletions that happen while we're running).
  const present = new Set(listing.files.map((f) => f.path))
  for (const p of known.keys()) if (!present.has(p)) index.removeFile(p)
  console.log(`[index] ${root}:`, index.stats())

  // Watch for external edits. Ignore dotfiles/dirs *relative to the vault*
  // (covers .nodebook/ + .git/ without killing the watcher for a vault that
  // itself lives under a dotted ancestor like ~/.local/share/notes).
  watcher = chokidar.watch(root, {
    ignored: ignoredInVault(root),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  watcher
    .on('add', (p: string) => {
      if (MD_EXT.test(p)) void indexPath(p).then(notifyTalkDirty)
      notifyVaultChanged()
    })
    .on('change', (p: string) => {
      if (MD_EXT.test(p)) {
        // Tell the renderer which note changed so a clean open buffer can
        // reload (it compares content, so our own save echoes are a no-op).
        mainWindow?.webContents.send('file:changed', p)
        void indexPath(p).then(() => {
          notifyTalkDirty()
          notifyIndexChanged()
        })
      }
    })
    .on('unlink', (p: string) => {
      if (MD_EXT.test(p)) index?.removeFile(p)
      notifyVaultChanged()
    })
    .on('addDir', notifyVaultChanged)
    .on('unlinkDir', notifyVaultChanged)

  return listing
}

// Bridge distill's embedding to the renderer's WASM embedder. The embedder lives
// in the renderer (the same one "talk" uses); main owns the run db + chat. One
// request/response round-trip per batch, correlated by a sequence id.
//
// The reply channel is namespaced with the run's own id (`token`), not just a
// per-run-local sequence number — two concurrent runs each starting their
// sequence at 1 would otherwise share `distill:embed:res:1` and cross-resolve
// each other's vectors. A per-batch timeout (5 min — the first batch may need
// to download the embedding model) and cleanup on vault close mean a run fails
// fast instead of hanging if the renderer never replies (e.g. a reload mid-run).
function rendererEmbedder(token: string): DistillEmbedder {
  let seq = 0
  return {
    embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      const id = ++seq
      const channel = `distill:embed:res:${token}:${id}`
      return new Promise((resolve, reject) => {
        if (!mainWindow) {
          reject(new Error('No window available to embed with'))
          return
        }
        if (signal?.aborted) {
          reject(new Error('Distill cancelled while embedding.'))
          return
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          ipcMain.removeListener(channel, onReply)
          pendingEmbeds.delete(channel)
          signal?.removeEventListener('abort', onAbort)
        }
        // Cancel must not wait out an in-flight batch: drop the pending promise
        // now (same cleanup as the timeout) — a late renderer reply finds no
        // listener and is ignored.
        const onAbort = (): void => {
          cleanup()
          reject(new Error('Distill cancelled while embedding.'))
        }
        const onReply = (_e: unknown, vectors: number[][], err?: string): void => {
          cleanup()
          if (err) reject(new Error(err))
          else resolve(vectors.map((v) => Float32Array.from(v)))
        }
        const timer = setTimeout(
          () => {
            cleanup()
            reject(new Error("Timed out waiting for the renderer to embed a batch (5 min) — it may have reloaded."))
          },
          5 * 60_000
        )
        pendingEmbeds.set(channel, (err) => {
          cleanup()
          reject(err)
        })
        signal?.addEventListener('abort', onAbort)
        ipcMain.once(channel, onReply)
        mainWindow.webContents.send('distill:embed:req', token, id, texts)
      })
    }
  }
}

/** A safe, readable run id from a document path (basename, sanitized). */
function distillRunId(file: string): string {
  const base = basename(file).replace(/\.[^.]+$/, '')
  return (
    base
      .replace(/[^A-Za-z0-9 ._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 80) || 'run'
  )
}

/** De-collide a run id against already-staged runs: distilling two documents
 *  with the same basename must not silently replace the earlier run. */
function uniqueRunId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function registerIpc(): void {
  ipcMain.handle('vault:pick', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      properties: ['openDirectory'],
      title: 'Open vault'
    })
    if (res.canceled || res.filePaths.length === 0) return null
    // Canonicalize so the scan, the chokidar watcher, and file paths all agree
    // (macOS /var → /private/var). Otherwise a file can be indexed twice.
    return realpathSync(res.filePaths[0])
  })

  ipcMain.handle('vault:open', (_e, root: string) => {
    addRecent(root) // remember it for File ▸ Open Recent, then refresh the menu
    refreshAppMenu()
    return openVault(root)
  })

  // The renderer reports which actions apply so the menu can grey out the rest;
  // rebuild only when the state actually changes (note switches are frequent).
  ipcMain.on('menu:state', (_e, s: MenuState) => {
    if (
      s.hasVault === menuState.hasVault &&
      s.hasNote === menuState.hasNote &&
      s.canSave === menuState.canSave &&
      s.canAsk === menuState.canAsk &&
      s.distilling === menuState.distilling
    )
      return
    menuState = s
    refreshAppMenu()
  })

  ipcMain.handle('vault:list', (_e, root: string) => scanVault(root))

  // Create a new (possibly empty) vault folder via a directory dialog.
  ipcMain.handle('vault:create', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'New vault',
      buttonLabel: 'Create / Open',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return realpathSync(res.filePaths[0])
  })

  // Create a new note inside dirPath (must be under the open vault). Returns the
  // new absolute path, or null on a bad name / collision.
  ipcMain.handle('fs:createFile', async (_e, dirPath: string, name: string): Promise<string | null> => {
    const n = validName(name)
    if (!n || !withinVault(dirPath)) return null
    const fileName = MD_EXT.test(n) ? n : `${n}.md`
    const full = join(dirPath, fileName)
    if (existsSync(full)) return null
    await fs.mkdir(dirPath, { recursive: true })
    const content = `# ${fileName.replace(MD_EXT, '')}\n\n`
    atomicWrite(full, content)
    index?.indexFile(full, content, 0)
    return full
  })

  // Create a new folder inside dirPath (must be under the open vault).
  ipcMain.handle('fs:createDir', async (_e, dirPath: string, name: string): Promise<string | null> => {
    const n = validName(name)
    if (!n || !withinVault(dirPath)) return null
    const full = join(dirPath, n)
    if (existsSync(full)) return null
    await fs.mkdir(full, { recursive: false })
    return full
  })

  // Rename a file or folder within its parent. Updates the index (re-paths the
  // whole subtree for a folder). Returns the new absolute path, or null.
  ipcMain.handle('fs:rename', async (_e, oldPath: string, newName: string): Promise<string | null> => {
    const n = validName(newName)
    if (!n || !withinVault(oldPath) || oldPath === vaultRoot) return null
    let stat
    try {
      stat = await fs.stat(oldPath)
    } catch {
      return null
    }
    const isDir = stat.isDirectory()
    const finalName = !isDir && !MD_EXT.test(n) ? `${n}.md` : n
    const newPath = join(dirname(oldPath), finalName)
    if (newPath === oldPath) return oldPath
    if (existsSync(newPath)) return null

    if (isDir) {
      for (const p of await markdownUnder(oldPath)) index?.removeFile(p)
      await fs.rename(oldPath, newPath)
      for (const p of await markdownUnder(newPath)) await indexPath(p)
    } else {
      index?.removeFile(oldPath)
      await fs.rename(oldPath, newPath)
      await indexPath(newPath)
    }
    knownMtime.delete(oldPath)
    notifyVaultChanged()
    return newPath
  })

  // Delete a file or folder by moving it to the system Trash (recoverable —
  // never a permanent rm). Updates the index. Returns success; false means
  // nothing was deleted (the renderer tells the user).
  ipcMain.handle('fs:delete', async (_e, target: string): Promise<boolean> => {
    if (!withinVault(target) || target === vaultRoot) return false
    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      return false
    }
    // Collect the notes to de-index BEFORE the move empties the folder.
    const under = stat.isDirectory() ? await markdownUnder(target) : [target]
    try {
      await shell.trashItem(target)
    } catch {
      return false // no trash available — leave the files alone
    }
    for (const p of under) {
      index?.removeFile(p)
      knownMtime.delete(p)
    }
    notifyVaultChanged()
    return true
  })

  ipcMain.handle('file:read', async (_e, path: string) => {
    if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
    const content = await fs.readFile(path, 'utf8')
    trackMtime(path) // reading refreshes the save-staleness baseline
    return content
  })

  ipcMain.handle('file:save', async (_e, path: string, content: string, force?: boolean) => {
    if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
    // Refuse to clobber bytes the app didn't write: if the file changed on disk
    // since we last read/wrote it, this save would silently drop that change.
    // The renderer surfaces the conflict and may re-save with force.
    if (!force) {
      const known = knownMtime.get(path)
      if (known !== undefined) {
        let onDisk: number | null = null
        try {
          onDisk = Math.floor((await fs.stat(path)).mtimeMs)
        } catch {
          // vanished — recreating it preserves the user's work
        }
        if (onDisk !== null && onDisk !== known)
          throw new Error('Conflict: the file changed on disk since it was opened.')
      }
    }
    atomicWrite(path, content)
    trackMtime(path)
    // Re-index synchronously from the bytes we just wrote (no fs round-trip).
    if (index && withinVault(path)) {
      index.indexFile(path, content, knownMtime.get(path) ?? 0)
      notifyTalkDirty()
      notifyIndexChanged()
    }
  })

  // Relation-typing bridge: name an untyped link by appending a `key:: value`
  // field to the *source note* (the source of truth), then re-index. Editing the
  // map edits the notes — never a separate map file.
  ipcMain.handle(
    'index:typeRelation',
    async (_e, sourcePath: string, relation: string, target: string) => {
      if (!isAccessibleFile(sourcePath)) throw new Error('Access denied: path outside the vault')
      const rel = relation.trim()
      if (!/^[A-Za-z][\w -]*$/.test(rel)) throw new Error('Invalid relation name')
      const current = readFileSync(sourcePath, 'utf8')
      const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n'
      const content = `${current}${sep}${rel}:: [[${target}]]\n`
      atomicWrite(sourcePath, content)
      if (index && withinVault(sourcePath)) {
        const { mtimeMs } = await fs.stat(sourcePath)
        index.indexFile(sourcePath, content, Math.floor(mtimeMs))
        notifyTalkDirty()
        notifyIndexChanged()
      }
      return true
    }
  )

  // Synchronous save used on window close (beforeunload can't await async IPC).
  // No staleness check: this is the last-chance flush on quit, where dropping
  // the buffer is strictly worse than overwriting.
  ipcMain.on('file:save-now', (e, path: string, content: string) => {
    try {
      if (!isAccessibleFile(path)) {
        e.returnValue = false
        return
      }
      atomicWrite(path, content)
      if (index && withinVault(path)) {
        index.indexFile(path, content, 0)
        notifyIndexChanged()
      }
    } catch {
      // best effort on the way out
    }
    e.returnValue = true
  })

  ipcMain.handle('index:backlinks', (_e, target: string) => index?.backlinks(target) ?? [])

  ipcMain.handle('index:outbound', (_e, sourceFile: string) => index?.outbound(sourceFile) ?? [])

  ipcMain.handle('index:search', (_e, query: string) => index?.search(query) ?? [])

  ipcMain.handle('index:noteNames', () => index?.noteNames() ?? [])

  ipcMain.handle(
    'index:graph',
    (_e, focusPath: string | null, opts?: { depth?: number; cap?: number; showSources?: boolean }) =>
      index?.graph(focusPath, opts) ?? { nodes: [], edges: [], hiddenSources: 0 }
  )

  // --- Talk to docs -------------------------------------------------------
  ipcMain.handle('talk:status', () => talkStatus())

  // Turn on (or resume) the feature: persist the flag, load the vector layer,
  // record the model's dims + configured model id (a model swap gates the
  // stored embeddings exactly like a dims change — see VectorStore.setDims),
  // and chunk any not-yet-chunked notes.
  ipcMain.handle('talk:enable', async (_e, dims: number): Promise<TalkStatus> => {
    const path = ensureSettingsFile()
    atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), true))
    trackMtime(path)
    index?.enableTalk()
    if (Number.isFinite(dims) && dims > 0) {
      index?.setEmbedDims(dims, readSettings().talk.embed.model)
    }
    await chunkUnchunkedFiles()
    return talkStatus()
  })

  // Turn off + drop the derived embeddings/chunks (rebuildable by re-enabling).
  ipcMain.handle('talk:disable', (): TalkStatus => {
    const path = ensureSettingsFile()
    atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), false))
    trackMtime(path)
    index?.disableTalk()
    return talkStatus()
  })

  ipcMain.handle('talk:pending', (_e, limit: number) => index?.talkPending(limit) ?? [])

  ipcMain.handle(
    'talk:putEmbeddings',
    (_e, rows: { id: number; vector: number[] }[]): TalkStatus => {
      index?.putEmbeddings(rows.map((r) => ({ id: r.id, vector: Float32Array.from(r.vector) })))
      return talkStatus()
    }
  )

  ipcMain.handle('talk:search', (_e, query: string, vector: number[]) =>
    index?.talkSearch(query, vector?.length ? Float32Array.from(vector) : null) ?? []
  )

  ipcMain.handle('talk:neighbors', (_e, focusPath: string, k?: number) =>
    index?.talkNeighbors(focusPath, k, readSettings().talk.relatedMinScore) ?? []
  )

  // True when an "Ask" chat provider is configured (provider ≠ none).
  ipcMain.handle('talk:canAsk', () => chatProviderConfig() !== null)

  // "Ask": retrieve grounding chunks → stream a cited answer. Only the retrieved
  // passages are sent to the model (never the whole vault). Everything goes back
  // as ordered events on the sender (tokens → done/error) so the answer can't
  // race the completion signal.
  ipcMain.on('talk:ask', async (e, question: string, vector: number[]) => {
    const noteName = (f: string): string => f.split(/[/\\]/).pop()!.replace(/\.md$/i, '')
    try {
      const cfg = chatProviderConfig()
      if (!cfg) throw new Error('Ask is off — set [talk.chat] provider in Settings.')
      if (!index) throw new Error('Open a vault first.')
      const chunks = index.talkRetrieve(
        question,
        vector?.length ? Float32Array.from(vector) : null,
        8
      )
      const context = chunks
        .map((c, i) => `[${i + 1}] (${noteName(c.file)})\n${c.text}`)
        .join('\n\n')
      const system =
        "You answer the user's question using ONLY the notes provided below. Cite the" +
        ' notes you draw on inline as [[Note Name]]. If the notes do not contain the' +
        ` answer, say so plainly.\n\nNOTES:\n${context || '(no relevant notes found)'}`

      const model = makeChatModel(cfg)
      let answer = ''
      for await (const token of model.chat({
        system,
        messages: [{ role: 'user', content: question }]
      })) {
        answer += token
        e.sender.send('talk:ask:token', token)
      }

      // "used" = the answer actually cites this note via [[wikilink]] — as
      // opposed to being retrieved as context but never drawn on. Citations
      // become attribution (what the answer leans on), not just a dump of
      // whatever was sent to the model.
      const usedNames = new Set(wikilinkTargetsIn(answer))
      const seen = new Set<string>()
      const citations: Citation[] = []
      const sources: string[] = []
      for (const c of chunks) {
        if (!seen.has(c.file)) {
          seen.add(c.file)
          const title = noteName(c.file)
          sources.push(title)
          citations.push({ path: c.file, title, used: usedNames.has(title) })
        }
      }
      e.sender.send('talk:ask:done', { citations, sources })
    } catch (err) {
      e.sender.send('talk:ask:error', err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('talk:semanticEdges', (_e, paths: string[], k?: number) =>
    index?.talkSemanticEdges(paths, k, readSettings().talk.relatedMinScore) ?? []
  )

  // --- Distill a document -------------------------------------------------
  // Pick a document to distill. The renderer gets an OPAQUE id, never the path:
  // main keeps the path→id map, so `distill:run` can only ever run a document
  // the user actually picked in the dialog.
  ipcMain.handle('distill:pick', async (): Promise<DistillDocument | null> => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'Distill a document',
      properties: ['openFile'],
      filters: [
        {
          name: 'Documents',
          extensions: ['pdf', 'epub', 'docx', 'html', 'htm', 'xhtml', 'md', 'markdown', 'txt', 'text']
        }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const file = res.filePaths[0]
    const id = randomUUID()
    pickedDocs.set(id, file)
    return { id, name: basename(file) }
  })

  // e2e only: the native dialog can't be driven from a spec, so tests register
  // a path directly. Guarded by NODEBOOK_E2E so a shipped build has no such door.
  ipcMain.handle('distill:registerPath', (_e, absPath: string): string => {
    if (!process.env.NODEBOOK_E2E) throw new Error('Not available.')
    const id = randomUUID()
    pickedDocs.set(id, absPath)
    return id
  })

  // Run the distill pipeline on a document → a staged, cited run-artifact. The
  // chunks are embedded via the renderer bridge; extraction uses the chat model;
  // output lands in the run's own db (never the canonical index).
  ipcMain.handle('distill:run', async (_e, docId: string): Promise<DistillRunResult> => {
    if (!index || !vaultRoot || !distillRuns) throw new Error('Open a vault first.')
    if (activeRunId !== null)
      throw new Error('A document is already being distilled — wait for it to finish or cancel it.')
    const filePath = pickedDocs.get(docId)
    if (!filePath) throw new Error('Unknown document — pick it again.')
    const cfg = chatProviderConfig()
    if (!cfg) throw new Error('Distill needs a chat provider — set [talk.chat] in Settings.')
    // Claim the single run slot and the id BEFORE the first await, so two
    // clicks in the same tick can't both get past the guard. One document, one
    // run: the id is consumed here.
    pickedDocs.delete(docId)
    const runId = uniqueRunId(distillRunId(filePath), new Set(distillRuns.list()))
    activeRunId = runId
    const ctrl = new AbortController()
    distillAbort.set(runId, ctrl)
    try {
      const chat = makeChatModel(cfg)
      // Fail fast: confirm the model actually responds (key valid, local server up)
      // BEFORE the expensive embedding, not half-way through the run. CLI backends
      // have multi-second cold starts (measured ~6.5s for a trivial codex round-trip).
      try {
        await probeChat(chat, AbortSignal.timeout(30_000))
      } catch (err) {
        throw new Error(
          `Can't start distilling — the chat model didn't respond. Check [talk.chat]: the provider, an API key (Anthropic/OpenAI), that your local server (LM Studio/Ollama) is running at the right baseUrl, or that your CLI is installed and signed in (codex login, claude auth login). ${err instanceof Error ? err.message : ''}`.trim(),
          { cause: err }
        )
      }
      // Convert to markdown first (PDF via pdf.js; markdown/text pass through). The
      // rest of the pipeline is format-agnostic.
      const text = await convertDocument(filePath)
      const source = { file: basename(filePath), text }
      const result = await distill(
        source,
        { embedder: rendererEmbedder(runId), chat },
        {
          signal: ctrl.signal,
          onProgress: (p) => mainWindow?.webContents.send('distill:progress', runId, p)
        }
      )
      distillRuns.create(runId, source, result.notes, { ...result.stats })
      return { runId, stats: result.stats }
    } finally {
      distillAbort.delete(runId)
      activeRunId = null
    }
  })

  ipcMain.handle('distill:cancel', (_e, runId: string) => {
    distillAbort.get(runId)?.abort()
  })

  // Distill views default to SHOWING the source-document node (the vault map
  // hides it): the book is a run's anchor, and a fresh run's notes may have no
  // other edges yet — hiding it there can render the map empty. An explicit
  // showSources still wins (the 📕 toggle).
  const distillOpts = (
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ): { depth?: number; cap?: number; showSources?: boolean } => ({
    ...opts,
    showSources: opts?.showSources ?? true
  })

  ipcMain.handle(
    'distill:graph',
    (
      _e,
      runId: string,
      focus: string | null,
      opts?: { depth?: number; cap?: number; showSources?: boolean }
    ) =>
      distillRuns?.graph(runId, focus ?? null, distillOpts(opts)) ?? {
        nodes: [],
        edges: [],
        hiddenSources: 0
      }
  )

  // Overlay: the vault + this run, unioned live (no writes) — the "how they'd
  // play together" preview. Built from raw rows of both indexes.
  ipcMain.handle(
    'distill:overlayGraph',
    (
      _e,
      runId: string,
      focus: string | null,
      opts?: { depth?: number; cap?: number; showSources?: boolean }
    ) => {
      if (!index || !distillRuns) return { nodes: [], edges: [], hiddenSources: 0 }
      return overlayGraph(index.graphRows(), distillRuns.rows(runId), focus ?? null, distillOpts(opts))
    }
  )

  // Staged runs with enough context to render a list: note count (from the
  // run's meta.json) and whether the run is already merged into the vault.
  ipcMain.handle('distill:listRuns', (): DistillRunInfo[] => {
    if (!distillRuns || !vaultRoot) return []
    const root = vaultRoot
    return distillRuns.list().map((id) => ({
      id,
      notes: readRunMeta(root, id)?.notes ?? 0,
      merged: readMergeManifest(root, id)?.complete === true
    }))
  })

  ipcMain.handle('distill:remove', (_e, runId: string) => distillRuns?.remove(runId))

  // Merge a run into the vault: copy its notes into a namespaced subfolder so the
  // canonical index picks them up. Reversible — a manifest records what we wrote.
  ipcMain.handle('distill:merge', (_e, runId: string): DistillMergeResult => {
    if (!vaultRoot || !index) throw new Error('Open a vault first.')
    const { manifest, written } = mergeRun(vaultRoot, runId)
    for (const p of written) {
      try {
        index.indexFile(p, readFileSync(p, 'utf8'), 0)
      } catch {
        /* unreadable — the watcher will retry */
      }
    }
    notifyVaultChanged()
    notifyIndexChanged()
    notifyTalkDirty()
    return { folder: manifest.folder, count: manifest.files.length }
  })

  // Undo a merge: take back exactly what it wrote and de-index it. Notes the
  // user edited since merging go to the Trash instead of being deleted.
  ipcMain.handle('distill:unmerge', async (_e, runId: string): Promise<DistillUnmergeResult> => {
    if (!vaultRoot || !index) return { removed: 0, trashed: 0 }
    const { removed, trashed } = await unmergeRun(vaultRoot, runId, (p) => shell.trashItem(p))
    for (const p of [...removed, ...trashed]) {
      index.removeFile(p)
      knownMtime.delete(p)
    }
    notifyVaultChanged()
    notifyIndexChanged()
    return { removed: removed.length, trashed: trashed.length }
  })

  ipcMain.handle('distill:mergeStatus', (_e, runId: string): DistillMergeStatus => {
    if (!vaultRoot) return { merged: false }
    const m = readMergeManifest(vaultRoot, runId)
    // A half-written merge (crash between manifest and copy) is not "merged".
    return m?.complete ? { merged: true, folder: m.folder, count: m.files.length } : { merged: false }
  })

  // --- Telemetry (measure everything) -------------------------------------
  // Reconcile the measurement to the settings flag (called by the renderer on
  // load and after a settings change; no TOML write).
  ipcMain.handle('telemetry:apply', (_e, enabled: boolean) => {
    if (enabled) telemetry.start()
    else telemetry.stop()
  })
  ipcMain.handle('telemetry:snapshot', () => (telemetry.running ? telemetry.snapshot() : null))

  ipcMain.handle('settings:path', () => ensureSettingsFile())
  ipcMain.handle('settings:read', () => readSettings())
  // The TOML syntax error in `raw` (or null) — lets the settings editor tell
  // the user their edit broke the file instead of silently reverting values.
  ipcMain.handle('settings:validate', (_e, raw: string) => settingsSyntaxError(raw))

  // Quick theme switch from the status bar — edits settings.toml in place
  // (preserving comments) and returns the freshly-parsed Settings.
  ipcMain.handle('settings:setThemeMode', (_e, mode: ThemeMode) => {
    const path = ensureSettingsFile()
    atomicWrite(path, setThemeMode(readFileSync(path, 'utf8'), mode))
    trackMtime(path)
    return readSettings()
  })

  // Restore the settings file to the shipped factory defaults; returns the new
  // TOML text so the open settings editor can refresh in place.
  ipcMain.handle('settings:reset', () => {
    atomicWrite(settingsFilePath(), DEFAULT_TOML)
    trackMtime(settingsFilePath())
    return DEFAULT_TOML
  })
  // Read-only: the documented defaults for "Reveal defaults" (no file write).
  ipcMain.handle('settings:defaults', () => DEFAULT_TOML)

  // Open external links in the system browser. Restricted to http(s) so a
  // crafted note can't launch file:// or other schemes.
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Export the current page (with print CSS isolating the note) to a PDF file.
  ipcMain.handle('pdf:export', async (e, suggestedName: string): Promise<boolean> => {
    const data = await e.sender.printToPDF({ printBackground: true })
    const res = await dialog.showSaveDialog(mainWindow ?? undefined!, {
      title: 'Export PDF',
      defaultPath: `${suggestedName || 'note'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, data)
    return true
  })
}

// Which menu actions currently apply. The renderer reports this (it owns the UI
// state); main greys out the rest. Conservative until the renderer first reports.
let menuState: MenuState = {
  hasVault: false,
  hasNote: false,
  canSave: false,
  canAsk: false,
  distilling: false
}

/** Rebuild + install the application menu (after recents or enabled-state change). */
function refreshAppMenu(): void {
  buildAppMenu(() => mainWindow, menuState)
}

// One-shot settings migrations, applied at startup and recorded in a marker
// file — so upgrading an old shipped default happens exactly once per install,
// and a user who later deliberately picks that legacy value keeps it. Writes
// go through atomicWrite + trackMtime like every other settings writer, so an
// open settings editor never sees a phantom "changed on disk" conflict.
function applySettingsMigrations(): void {
  const marker = join(app.getPath('userData'), '.migrations')
  const applied = existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []
  const id = 'embed-model-multilingual-e5'
  if (applied.includes(id)) return
  const path = ensureSettingsFile()
  const migrated = migrateEmbedModel(readFileSync(path, 'utf8'))
  if (migrated !== null) {
    atomicWrite(path, migrated)
    trackMtime(path)
  }
  atomicWrite(marker, [...applied, id].join('\n') + '\n')
}

app.whenReady().then(() => {
  applySettingsMigrations()
  registerIpc()
  refreshAppMenu()
  createWindow()
  if (readSettings().telemetry.enabled) telemetry.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when the window is closed, on every platform. (We override the macOS
// "stay alive in the dock" convention — Nodebook is a single-window app.)
app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  telemetry.stop()
  void closeVault()
})
