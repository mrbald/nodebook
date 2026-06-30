import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, relative, dirname, sep, basename } from 'path'
import {
  promises as fs,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync
} from 'fs'
import chokidar, { type FSWatcher } from 'chokidar'
import type { MarkdownFile, MenuState, VaultListing } from '../shared/types'
import { VaultIndex } from './indexer'
import { overlayGraph } from './graph'
import { distill, probeChat, type DistillEmbedder } from './distill/run'
import { StagedRunStore } from './distill/staged'
import { convertDocument } from './distill/convert'
import { mergeRun, unmergeRun, readMergeManifest } from './distill/artifact'
import { Telemetry } from './telemetry'
import {
  ensureSettingsFile,
  readSettings,
  setThemeMode,
  setTalkEnabled,
  settingsPath as settingsFilePath,
  chatProviderConfig,
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
  DistillMergeResult,
  DistillMergeStatus
} from '../shared/types'

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
      sandbox: false,
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

/** True only if p is the vault root or strictly inside it (no `/vault2` prefix trick). */
function withinVault(p: string): boolean {
  return !!vaultRoot && (p === vaultRoot || p.startsWith(vaultRoot + sep))
}

// file:read / file:save serve note files (inside the vault) AND the settings
// file (in userData). Anything else is rejected, so a crafted path from the
// renderer can't read/overwrite arbitrary files.
function isAccessibleFile(p: string): boolean {
  return withinVault(p) || p === settingsFilePath()
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
const telemetry = new Telemetry()

async function closeVault(): Promise<void> {
  if (watcher) await watcher.close()
  watcher = null
  for (const ctrl of distillAbort.values()) ctrl.abort()
  distillAbort.clear()
  distillRuns?.close()
  distillRuns = null
  index?.close()
  index = null
  vaultRoot = null
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
  for (const f of listing.files) await indexPath(f.path)
  console.log(`[index] ${root}:`, index.stats())

  // Watch for external edits. Ignore dotfiles/dirs (covers .nodebook/ + .git/).
  watcher = chokidar.watch(root, {
    ignored: (p: string) => /(^|[/\\])\.[^/\\]/.test(p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  watcher
    .on('add', (p: string) => {
      if (MD_EXT.test(p)) void indexPath(p).then(notifyTalkDirty)
      notifyVaultChanged()
    })
    .on('change', (p: string) => {
      if (MD_EXT.test(p))
        void indexPath(p).then(() => {
          notifyTalkDirty()
          notifyIndexChanged()
        })
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
function rendererEmbedder(): DistillEmbedder {
  let seq = 0
  return {
    embed(texts: string[]): Promise<Float32Array[]> {
      const id = ++seq
      const channel = `distill:embed:res:${id}`
      return new Promise((resolve, reject) => {
        if (!mainWindow) {
          reject(new Error('No window available to embed with'))
          return
        }
        ipcMain.once(channel, (_e, vectors: number[][], err?: string) => {
          if (err) reject(new Error(err))
          else resolve(vectors.map((v) => Float32Array.from(v)))
        })
        mainWindow.webContents.send('distill:embed:req', id, texts)
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
      s.canAsk === menuState.canAsk
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
    notifyVaultChanged()
    return newPath
  })

  // Delete a file or folder (recursive). Updates the index. Returns success.
  ipcMain.handle('fs:delete', async (_e, target: string): Promise<boolean> => {
    if (!withinVault(target) || target === vaultRoot) return false
    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      return false
    }
    if (stat.isDirectory()) {
      for (const p of await markdownUnder(target)) index?.removeFile(p)
      await fs.rm(target, { recursive: true, force: true })
    } else {
      index?.removeFile(target)
      await fs.rm(target, { force: true })
    }
    notifyVaultChanged()
    return true
  })

  ipcMain.handle('file:read', (_e, path: string) => {
    if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
    return fs.readFile(path, 'utf8')
  })

  ipcMain.handle('file:save', async (_e, path: string, content: string) => {
    if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
    atomicWrite(path, content)
    // Re-index synchronously from the bytes we just wrote (no fs round-trip).
    if (index && withinVault(path)) {
      const { mtimeMs } = await fs.stat(path)
      index.indexFile(path, content, Math.floor(mtimeMs))
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
    (_e, focusPath: string | null, opts?: { depth?: number; cap?: number }) =>
      index?.graph(focusPath, opts) ?? { nodes: [], edges: [] }
  )

  // --- Talk to docs -------------------------------------------------------
  ipcMain.handle('talk:status', () => talkStatus())

  // Turn on (or resume) the feature: persist the flag, load the vector layer,
  // record the model's dims, and chunk any not-yet-chunked notes.
  ipcMain.handle('talk:enable', async (_e, dims: number): Promise<TalkStatus> => {
    const path = ensureSettingsFile()
    atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), true))
    index?.enableTalk()
    if (Number.isFinite(dims) && dims > 0) index?.setEmbedDims(dims)
    await chunkUnchunkedFiles()
    return talkStatus()
  })

  // Turn off + drop the derived embeddings/chunks (rebuildable by re-enabling).
  ipcMain.handle('talk:disable', (): TalkStatus => {
    const path = ensureSettingsFile()
    atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), false))
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
      for await (const token of model.chat({
        system,
        messages: [{ role: 'user', content: question }]
      })) {
        e.sender.send('talk:ask:token', token)
      }

      const seen = new Set<string>()
      const citations: Citation[] = []
      for (const c of chunks) {
        if (!seen.has(c.file)) {
          seen.add(c.file)
          citations.push({ path: c.file, title: noteName(c.file) })
        }
      }
      e.sender.send('talk:ask:done', { citations })
    } catch (err) {
      e.sender.send('talk:ask:error', err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('talk:semanticEdges', (_e, paths: string[], k?: number) =>
    index?.talkSemanticEdges(paths, k, readSettings().talk.relatedMinScore) ?? []
  )

  // --- Distill a document -------------------------------------------------
  // Pick a markdown/text book to distill (a file dialog; any readable file).
  ipcMain.handle('distill:pick', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: 'Distill a document',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'epub', 'md', 'markdown', 'txt', 'text'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // Run the distill pipeline on a document → a staged, cited run-artifact. The
  // chunks are embedded via the renderer bridge; extraction uses the chat model;
  // output lands in the run's own db (never the canonical index).
  ipcMain.handle('distill:run', async (_e, filePath: string): Promise<DistillRunResult> => {
    if (!index || !vaultRoot || !distillRuns) throw new Error('Open a vault first.')
    const cfg = chatProviderConfig()
    if (!cfg) throw new Error('Distill needs a chat provider — set [talk.chat] in Settings.')
    const chat = makeChatModel(cfg)
    // Fail fast: confirm the model actually responds (key valid, local server up)
    // BEFORE the expensive embedding, not half-way through the run.
    try {
      await probeChat(chat, AbortSignal.timeout(15_000))
    } catch (err) {
      throw new Error(
        `Can't start distilling — the chat model didn't respond. Check [talk.chat]: the provider, an API key (Anthropic/OpenAI), or that your local server (LM Studio/Ollama) is running at the right baseUrl. ${err instanceof Error ? err.message : ''}`.trim(),
        { cause: err }
      )
    }
    // Convert to markdown first (PDF via pdf.js; markdown/text pass through). The
    // rest of the pipeline is format-agnostic.
    const text = await convertDocument(filePath)
    const source = { file: basename(filePath), text }
    const runId = distillRunId(filePath)
    const ctrl = new AbortController()
    distillAbort.set(runId, ctrl)
    try {
      const result = await distill(
        source,
        { embedder: rendererEmbedder(), chat },
        {
          signal: ctrl.signal,
          onProgress: (p) => mainWindow?.webContents.send('distill:progress', runId, p)
        }
      )
      distillRuns.create(runId, source, result.notes)
      return { runId, stats: result.stats }
    } finally {
      distillAbort.delete(runId)
    }
  })

  ipcMain.handle('distill:cancel', (_e, runId: string) => {
    distillAbort.get(runId)?.abort()
  })

  ipcMain.handle(
    'distill:graph',
    (_e, runId: string, focus: string | null, opts?: { depth?: number; cap?: number }) =>
      distillRuns?.graph(runId, focus ?? null, opts) ?? { nodes: [], edges: [] }
  )

  // Overlay: the vault + this run, unioned live (no writes) — the "how they'd
  // play together" preview. Built from raw rows of both indexes.
  ipcMain.handle(
    'distill:overlayGraph',
    (_e, runId: string, focus: string | null, opts?: { depth?: number; cap?: number }) => {
      if (!index || !distillRuns) return { nodes: [], edges: [] }
      return overlayGraph(index.graphRows(), distillRuns.rows(runId), focus ?? null, opts)
    }
  )

  ipcMain.handle('distill:listRuns', () => distillRuns?.list() ?? [])

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

  // Undo a merge: delete exactly what it wrote and de-index it.
  ipcMain.handle('distill:unmerge', (_e, runId: string): boolean => {
    if (!vaultRoot || !index) return false
    for (const p of unmergeRun(vaultRoot, runId)) index.removeFile(p)
    notifyVaultChanged()
    notifyIndexChanged()
    return true
  })

  ipcMain.handle('distill:mergeStatus', (_e, runId: string): DistillMergeStatus => {
    if (!vaultRoot) return { merged: false }
    const m = readMergeManifest(vaultRoot, runId)
    return m ? { merged: true, folder: m.folder, count: m.files.length } : { merged: false }
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

  // Quick theme switch from the status bar — edits settings.toml in place
  // (preserving comments) and returns the freshly-parsed Settings.
  ipcMain.handle('settings:setThemeMode', (_e, mode: ThemeMode) => {
    const path = ensureSettingsFile()
    atomicWrite(path, setThemeMode(readFileSync(path, 'utf8'), mode))
    return readSettings()
  })

  // Restore the settings file to the shipped factory defaults; returns the new
  // TOML text so the open settings editor can refresh in place.
  ipcMain.handle('settings:reset', () => {
    atomicWrite(settingsFilePath(), DEFAULT_TOML)
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
let menuState: MenuState = { hasVault: false, hasNote: false, canSave: false, canAsk: false }

/** Rebuild + install the application menu (after recents or enabled-state change). */
function refreshAppMenu(): void {
  buildAppMenu(() => mainWindow, menuState)
}

app.whenReady().then(() => {
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
