import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, relative, dirname, resolve, basename } from 'path'
import {
  promises as fs,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  existsSync,
  realpathSync,
  statSync,
  writeFileSync,
  readFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { setImmediate as yieldToLoop } from 'timers/promises'
import { withinRoot, ignoredInVault } from './paths'
import chokidar, { type FSWatcher } from 'chokidar'
import type { MarkdownFile, MenuState, SaveFileResult, VaultListing } from '../shared/types'
import { VaultIndex } from './indexer'
import { overlayGraph, noteName } from './graph'
import { noteVector, sameAsCandidatesYielding, type NoteVec } from './distill/sameAs'
import { chunkMarkdown, embedText } from './rag/chunk'
import { distill, probeChat, estimateDistill, type DistillEmbedder } from './distill/run'
import { normalizeFocus } from './distill/extract'
import { StagedRunStore } from './distill/staged'
import { convertDocumentWithCoverage } from './distill/convert'
import { convertSource, originalPathOf, readSourceText, sha1 } from './distill/sources'
import { distillRunId, uniqueRunId } from './distill/runId'
import {
  mergeRun,
  unmergeRun,
  readMergeManifest,
  readRunMeta,
  readRunJson,
  readRunNotes,
  readStagedNote,
  sourceNoteName,
  contentHash,
  migrateDistillRuns,
  beginRun,
  readRunSource,
  isUnfinishedRun,
  checkpointStore,
  RESERVED_RUN_IDS,
  type RunSource
} from './distill/artifact'
import { mergePlan, twinOf } from './distill/mergePlan'
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
import { ASK_SYSTEM, NO_ASK_EVIDENCE, packAskContext } from './rag/ask'
import { DEFAULT_INPUT_BUDGET, inputBudgetFor } from './rag/provider'
import { buildAppMenu } from './menu'
import { addRecent } from './recents'
import type {
  AskRequest,
  AskResult,
  TalkStatus,
  DistillEstimate,
  DistillRunResult,
  DistillRunInfo,
  DistillDocument,
  DistillMergePlan,
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
let closeReady = false
let pendingClose: { window: BrowserWindow; quit: boolean } | null = null
let closeApproved: BrowserWindow | null = null

function deferClose(window: BrowserWindow, quit: boolean): boolean {
  if (!closeReady || closeApproved === window || window.webContents.isCrashed()) return false
  if (pendingClose) {
    pendingClose.quit ||= quit
  } else {
    pendingClose = { window, quit }
    window.webContents.send('window:close-request')
  }
  return true
}

function createWindow(): void {
  const window = new BrowserWindow({
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
  mainWindow = window

  window.on('close', (event) => {
    if (deferClose(window, false)) event.preventDefault()
  })
  window.on('closed', () => {
    mainWindow = null
    pendingClose = null
    closeApproved = null
    closeReady = false
  })
  window.webContents.on('did-start-loading', () => {
    closeReady = false
    pendingClose = null
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

function atomicWrite(filePath: string, content: string, canReplace?: () => boolean): boolean {
  const tmp = join(dirname(filePath), `.nodebook-write-${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'wx')
  let replaced = false
  try {
    try {
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Recheck after staging the write, immediately before replacing the file.
    if (canReplace && !canReplace()) return false
    renameSync(tmp, filePath)
    replaced = true
    return true
  } finally {
    if (!replaced) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Keep the original save error if cleanup also fails.
      }
    }
  }
}

function readDiskVersion(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
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
const askAbort = new Map<string, AbortController>()
// Exactly one distill run at a time: a second would race the first on the same
// run directory and clobber its AbortController. Claimed synchronously at the
// top of `distill:run`, released in its finally.
let activeRunId: string | null = null
// Documents the user picked to distill: an opaque id → the absolute path. The
// renderer only ever holds the id, so it cannot name a path of its own to run.
type PickedDocument = { path: string; estimated?: Omit<RunSource, 'text'> }
const pickedDocs = new Map<string, PickedDocument>()
const telemetry = new Telemetry()

// Pending distill embed round-trips (the renderer WASM embedder answers main's
// requests over IPC), keyed by their reply channel. Tracked globally so a
// vault close can fail them fast instead of leaving `ipcMain.once` listeners —
// and the run awaiting them — hanging forever.
const pendingEmbeds = new Map<string, (err: Error) => void>()

// What the merge dialog last showed for a run, kept until Merge or vault close:
// the twins proposed by meaning (staged name → vault note), so Merge does not
// embed twice; and the twin beside every tick-box (a clash's namesake or the
// proposal), so a tick can be checked against the plan recomputed at merge
// time — a tick means "same as the twin I was shown", nothing else.
const shownCandidates = new Map<string, Map<string, string>>()
const shownTwins = new Map<string, Map<string, string>>()

async function closeVault(): Promise<void> {
  const previousIndex = index
  const previousWatcher = watcher
  index = null
  vaultRoot = null
  watcher = null
  for (const ctrl of askAbort.values()) ctrl.abort()
  askAbort.clear()
  for (const ctrl of distillAbort.values()) ctrl.abort()
  distillAbort.clear()
  // Fail any in-flight embed round-trip now — otherwise its `ipcMain.once`
  // listener (and the run awaiting it) would hang until the timeout, or
  // forever if the renderer never replies (e.g. it reloaded mid-run).
  for (const fail of [...pendingEmbeds.values()]) fail(new Error('Vault closed while waiting to embed.'))
  pendingEmbeds.clear()
  shownCandidates.clear()
  shownTwins.clear()
  pickedDocs.clear()
  distillRuns?.close()
  distillRuns = null
  previousIndex?.close()
  await previousWatcher?.close()
}

async function indexPath(path: string): Promise<void> {
  const target = index
  if (!target) return
  // A checked save can land between a watcher read and its final stat. Index a
  // stable disk revision only, so old bytes never inherit the newer mtime.
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string
    let mtimeMs: number
    try {
      const before = await fs.stat(path)
      content = await fs.readFile(path, 'utf8')
      if (target !== index) return
      const after = statSync(path)
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue
      mtimeMs = after.mtimeMs
    } catch (err) {
      if (target === index && !existsSync(path)) target.removeFile(path)
      else if (target === index) console.error('[index] Could not read', path, err)
      return
    }
    target.indexFile(path, content, Math.floor(mtimeMs))
    return
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
  const { enabled, embed } = readSettings().talk
  const generation = enabled ? index?.talkGenerationFor(embed.model) ?? null : null
  const counts = index?.talkCounts() ?? { total: 0, pending: 0 }
  return {
    vaultId: index?.id ?? null,
    generation,
    enabled,
    ready: generation !== null,
    total: counts.total,
    pending: counts.pending
  }
}

/** Fill a freshly enabled or rebuilt chunk index from its live note rows. */
async function chunkUnchunkedFiles(target: VaultIndex): Promise<void> {
  const generation = target.talkGeneration
  for (const path of target.knownFiles().keys()) {
    if (target !== index || target.talkGeneration !== generation) return
    if (target.isChunked(path)) continue
    target.chunkIndexedFile(path)
    await yieldToLoop()
  }
}

async function openVault(root: string): Promise<VaultListing> {
  await closeVault()
  vaultRoot = root
  index = new VaultIndex(join(root, '.nodebook', 'index.db'))
  // Runs used to live inside `.nodebook/` — a directory documented as a
  // deletable cache. Carry any left there into `.distill/` (durable staging)
  // before anything lists runs; it is a rename, so a merged run stays undoable.
  migrateDistillRuns(root)
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
      if (!index.talkOn || index.isChunked(f.path)) continue
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
      if (MD_EXT.test(p))
        void indexPath(p).then(() => {
          notifyTalkDirty()
          notifyIndexChanged()
        }).catch((err) => console.error('[index] Could not index', p, err))
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
        }).catch((err) => console.error('[index] Could not index', p, err))
      }
    })
    .on('unlink', (p: string) => {
      if (MD_EXT.test(p)) {
        index?.removeFile(p)
        notifyIndexChanged()
      }
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
function rendererEmbedder(token: string, timeoutMs = 5 * 60_000): DistillEmbedder {
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
            reject(
              new Error(
                `Timed out waiting for the renderer to embed a batch (${Math.round(timeoutMs / 1000)} s) — it may have reloaded.`
              )
            )
          },
          timeoutMs
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

/**
 * Convert a picked document to markdown once, through the vault's source store.
 *
 * The store is the cache AND the identity: an unchanged file converts once
 * ever, not once per run, and the run records the hash it got — so two runs of
 * the same book are recognisable as such, and the book itself is written into
 * the vault only once (see `sources.ts` and `artifact.mergeRun`).
 */
async function convertPicked(filePath: string): Promise<RunSource> {
  if (!vaultRoot) throw new Error('Open a vault first.')
  const stored = await convertSource(vaultRoot, filePath, convertDocumentWithCoverage)
  return {
    file: basename(filePath),
    text: stored.text,
    pdf: stored.record.pdf,
    hash: stored.hash,
    originalPath: stored.record.originalPath
  }
}

/**
 * How much a run may read at a time, and how many calls it may spend: the chat
 * model's declared prompt budget (or the user's `contextTokens`) plus the two
 * `[distill]` knobs. The estimate and the run ask the same question here, so
 * the plan the user is shown is the plan the run follows.
 */
function distillBudget(): { inputBudget: number; windowSize: number; maxCalls: number } {
  const s = readSettings()
  const cfg = chatProviderConfig()
  return {
    inputBudget: cfg ? inputBudgetFor(cfg) : DEFAULT_INPUT_BUDGET,
    windowSize: s.distill.windowSize,
    maxCalls: s.distill.maxCalls
  }
}

/**
 * Drive one distill run — fresh or resumed — from converted text to a staged
 * artifact. Both entry points share this so a resume behaves exactly like a
 * run: same single-run slot, same pre-flight, same progress, same checkpoint.
 *
 * The run dir is created (`beginRun`) BEFORE the first model call: that record
 * plus the checkpoint is what makes a cancelled or crashed run resumable, and
 * `meta.json` — written only on success — is what marks it finished.
 */
async function runDistillPipeline(
  runId: string,
  source: RunSource,
  opts: { resume: boolean; focus?: string }
): Promise<DistillRunResult> {
  const root = vaultRoot
  const runs = distillRuns
  if (!root || !runs) throw new Error('Open a vault first.')
  // The caller has claimed `activeRunId` and releases it; this only owns the
  // abort handle, so a cancel can reach the run while it is in flight.
  const cfg = chatProviderConfig()
  if (!cfg) throw new Error('Distill needs a chat provider — set [talk.chat] in Settings.')
  const ctrl = new AbortController()
  distillAbort.set(runId, ctrl)
  try {
    const chat = makeChatModel(cfg)
    // Fail fast: confirm the model actually responds (key valid, local server up)
    // BEFORE the expensive embedding, not half-way through the run. CLI backends
    // have multi-second cold starts (measured ~6.5s for a trivial codex round-trip).
    try {
      await probeChat(chat, AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]))
    } catch (err) {
      throw new Error(
        `Can't start distilling — the chat model didn't respond. Check [talk.chat]: the provider, an API key (Anthropic/OpenAI), that your local server (LM Studio/Ollama) is running at the right baseUrl, or that your CLI is installed and signed in (codex login, claude auth login). ${err instanceof Error ? err.message : ''}`.trim(),
        { cause: err }
      )
    }
    ctrl.signal.throwIfAborted()
    if (!opts.resume)
      beginRun(root, runId, source, { provider: cfg.kind, model: cfg.model ?? '' }, opts.focus)
    const result = await distill(
      source,
      { embedder: rendererEmbedder(runId), chat },
      {
        ...distillBudget(),
        focus: opts.focus,
        signal: ctrl.signal,
        onProgress: (p) => mainWindow?.webContents.send('distill:progress', runId, p),
        checkpoint: checkpointStore(root, runId)
      }
    )
    // meta.json stores a flat map of numbers, so the drop reasons are
    // spread out of their nested shape here.
    ctrl.signal.throwIfAborted()
    const { droppedByReason: why, ...flatStats } = result.stats
    runs.create(
      runId,
      source,
      result.notes,
      {
        ...flatStats,
        droppedNoEvidence: why.noEvidence,
        droppedNotFound: why.notFound,
        droppedAmbiguous: why.ambiguous
      },
      result.themes,
      opts.focus
    )
    return { runId, stats: result.stats, pdf: source.pdf }
  } finally {
    distillAbort.delete(runId)
  }
}

function registerIpc(): void {
  ipcMain.on('window:close-ready', (event) => {
    if (event.sender === mainWindow?.webContents) closeReady = true
  })

  ipcMain.on('window:close-response', (event, approved: boolean) => {
    const request = pendingClose
    if (!request || event.sender !== request.window.webContents) return
    pendingClose = null
    if (approved !== true) return
    closeApproved = request.window
    if (request.quit) app.quit()
    else request.window.close()
  })

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
    }
    notifyVaultChanged()
    return true
  })

  ipcMain.handle('file:read', (_e, path: string) => {
    if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
    return fs.readFile(path, 'utf8')
  })

  ipcMain.handle(
    'file:save',
    (_e, path: string, content: string, expected: string | null): SaveFileResult => {
      if (!isAccessibleFile(path)) throw new Error('Access denied: path outside the vault')
      if (typeof content !== 'string' || (expected !== null && typeof expected !== 'string')) {
        throw new Error('A checked save requires the editor text and its disk baseline')
      }
      // Check the editor's own baseline, so a separate read of the same note
      // cannot authorize an overwrite. Keep check and write in one main turn.
      let onDisk = readDiskVersion(path)
      if (onDisk !== expected && onDisk !== content) return { status: 'conflict', content: onDisk }
      if (onDisk !== content) {
        const written = atomicWrite(path, content, () => {
          onDisk = readDiskVersion(path)
          return onDisk === expected
        })
        if (!written && onDisk !== content) return { status: 'conflict', content: onDisk }
      }
      if (index && withinVault(path)) {
        try {
          index.indexFile(path, content, Math.floor(statSync(path).mtimeMs))
          notifyTalkDirty()
          notifyIndexChanged()
        } catch (err) {
          // The save landed; the watcher can catch up with the derived index.
          console.error('[index] Could not index saved file:', err)
        }
      }
      return { status: 'saved' }
    }
  )

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

  ipcMain.handle('index:backlinks', (_e, target: string) => index?.backlinks(target) ?? [])

  ipcMain.handle('index:backlinksToFile', (_e, path: string) => index?.backlinksToFile(path) ?? [])

  ipcMain.handle('index:outbound', (_e, sourceFile: string) => index?.outbound(sourceFile) ?? [])

  // The notes a confirmed `same_as::` made one thing with this one. The renderer
  // only ever asks about the note it has open, so the path is checked like any
  // other path it hands us.
  ipcMain.handle('index:sameAs', (_e, path: string) =>
    index && withinVault(path) ? index.sameAs(path) : []
  )

  ipcMain.handle('index:search', (_e, query: string) => index?.search(query) ?? [])

  ipcMain.handle('index:noteNames', () => index?.noteNames() ?? [])

  ipcMain.handle(
    'index:graph',
    (_e, focusPath: string | null, opts?: { depth?: number; cap?: number; showSources?: boolean }) =>
      index?.graph(focusPath, opts) ?? {
        nodes: [],
        edges: [],
        hiddenSources: 0,
        ambiguousTargets: 0
      }
  )

  // --- Talk to docs -------------------------------------------------------
  ipcMain.handle('talk:status', () => talkStatus())

  // Turn on (or resume) the feature: persist the flag, load the vector layer,
  // record the model's dims + configured model id (a model swap gates the
  // stored embeddings exactly like a dims change — see VectorStore.setDims),
  // and chunk any not-yet-chunked notes.
  ipcMain.handle(
    'talk:enable',
    async (_e, vaultId: string, model: string, dims: number): Promise<TalkStatus> => {
      const target = index
      if (!target || target.id !== vaultId) return talkStatus()
      if (model !== readSettings().talk.embed.model)
        throw new Error('The embedding model changed.')
      if (!Number.isSafeInteger(dims) || dims <= 0) throw new Error('Invalid embedding dimension.')
      target.enableTalk()
      target.setEmbedDims(dims, model)
      const path = ensureSettingsFile()
      atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), true))
      await chunkUnchunkedFiles(target)
      return talkStatus()
    }
  )

  // Turn off + drop the derived embeddings/chunks (rebuildable by re-enabling).
  ipcMain.handle('talk:disable', (): TalkStatus => {
    index?.disableTalk()
    const path = ensureSettingsFile()
    atomicWrite(path, setTalkEnabled(readFileSync(path, 'utf8'), false))
    return talkStatus()
  })

  ipcMain.handle('talk:pending', (_e, generation: string, limit: number) => {
    const { enabled, embed } = readSettings().talk
    return enabled && generation === index?.talkGenerationFor(embed.model)
      ? index.talkPending(generation, limit)
      : []
  })

  ipcMain.handle(
    'talk:putEmbeddings',
    (_e, generation: string, rows: { id: number; vector: number[] }[]): TalkStatus => {
      const { enabled, embed } = readSettings().talk
      if (enabled && generation === index?.talkGenerationFor(embed.model))
        index.putEmbeddings(generation, rows.map((r) => ({
          id: r.id, vector: Float32Array.from(r.vector)
        })))
      return talkStatus()
    }
  )

  ipcMain.handle('talk:search', (_e, query: string, generation: string, vector: number[]) => {
    const { enabled, embed } = readSettings().talk
    const current = enabled && generation === index?.talkGenerationFor(embed.model)
    return index?.talkSearch(query, current ? Float32Array.from(vector) : null) ?? []
  })

  ipcMain.handle('talk:neighbors', (_e, focusPath: string, k?: number) =>
    index?.talkNeighbors(focusPath, k, readSettings().talk.relatedMinScore) ?? []
  )

  ipcMain.handle('talk:canAsk', () => chatProviderConfig() !== null)

  ipcMain.on('talk:ask:cancel', (e, id: string) => {
    askAbort.get(`${e.sender.id}:${id}`)?.abort()
  })

  ipcMain.handle('talk:ask', async (e, req: AskRequest): Promise<AskResult> => {
    const target = index
    if (!target || !vaultRoot || req.vaultId !== target.id) throw new Error('The vault changed.')
    const cfg = chatProviderConfig()
    if (!cfg) throw new Error('Set a chat provider in Settings to use Ask.')

    const key = `${e.sender.id}:${req.id}`
    if (askAbort.has(key)) throw new Error('This Ask request is already running.')
    const controller = new AbortController()
    askAbort.set(key, controller)
    const send = (token: string): void => {
      if (!e.sender.isDestroyed()) e.sender.send('talk:ask:token', req.id, token)
    }
    try {
      const { enabled, embed } = readSettings().talk
      const vector = enabled && req.generation === target.talkGenerationFor(embed.model) && req.vector.length
        ? Float32Array.from(req.vector)
        : null
      const chunks = target.talkRetrieve(req.question, vector)
      const { prompt, citations } = packAskContext(req.question, vaultRoot, chunks, inputBudgetFor(cfg))
      if (!citations.length) return { answer: NO_ASK_EVIDENCE, citations }
      const model = makeChatModel(cfg)
      let answer = ''
      for await (const token of model.chat({
        system: ASK_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        signal: controller.signal
      })) {
        controller.signal.throwIfAborted()
        answer += token
        send(token)
      }
      controller.signal.throwIfAborted()
      return { answer, citations }
    } finally {
      if (askAbort.get(key) === controller) askAbort.delete(key)
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
    pickedDocs.set(id, { path: file })
    return { id, name: basename(file) }
  })

  // e2e only: the native dialog can't be driven from a spec, so tests register
  // a path directly. Guarded by NODEBOOK_E2E so a shipped build has no such door.
  ipcMain.handle('distill:registerPath', (_e, absPath: string): string => {
    if (!process.env.NODEBOOK_E2E) throw new Error('Not available.')
    const id = randomUUID()
    pickedDocs.set(id, { path: absPath })
    return id
  })

  // What a run would cost, before committing to it: the document is converted
  // (once — the run reuses this copy) and handed to the same pure planner.
  ipcMain.handle(
    'distill:estimate',
    async (_e, docId: string, focus?: string): Promise<DistillEstimate> => {
      const picked = pickedDocs.get(docId)
      if (!picked) throw new Error('Unknown document — pick it again.')
      const filePath = picked.path
      // The focus rides in every prompt, so it costs window room — the estimate
      // has to be made against the same budget the run will have.
      const source = await convertPicked(filePath)
      const estimate = estimateDistill(source.text, { ...distillBudget(), focus: normalizeFocus(focus) })
      if (pickedDocs.get(docId) !== picked) throw new Error('The vault changed. Pick the document again.')
      const { file, hash, originalPath, pdf } = source
      picked.estimated = { file, hash, originalPath, pdf }
      return { ...estimate, pdf: source.pdf }
    }
  )

  // Run the distill pipeline on a document → a staged, cited run-artifact. The
  // chunks are embedded via the renderer bridge; extraction uses the chat model;
  // output lands in the run's own db (never the canonical index).
  ipcMain.handle(
    'distill:run',
    async (_e, docId: string, focus?: string): Promise<DistillRunResult> => {
      if (!index || !vaultRoot || !distillRuns) throw new Error('Open a vault first.')
      if (activeRunId !== null)
        throw new Error(
          'A document is already being distilled — wait for it to finish or cancel it.'
        )
      const picked = pickedDocs.get(docId)
      if (!picked) throw new Error('Unknown document — pick it again.')
      const filePath = picked.path
      // Normalised (and capped) here, before the id is spent: an over-long
      // focus must cost the user nothing but the message that says so.
      const asked = normalizeFocus(focus)
      // Claim the single run slot and the id BEFORE the first await, so two
      // clicks in the same tick can't both get past the guard. One document, one
      // run: the id is consumed here.
      pickedDocs.delete(docId)
      const runId = uniqueRunId(distillRunId(filePath), [
        ...distillRuns.list(),
        ...RESERVED_RUN_IDS
      ])
      activeRunId = runId
      try {
        // Convert to markdown first (PDF via pdf.js; markdown/text pass through). The
        // rest of the pipeline is format-agnostic.
        const owner = distillRuns
        let source: RunSource
        if (picked.estimated?.hash) {
          const text = readSourceText(vaultRoot, picked.estimated.hash)
          if (text === null || sha1(text) !== picked.estimated.hash) {
            throw new Error('The prepared text changed or is unavailable. Pick the document again.')
          }
          source = { ...picked.estimated, text }
        } else {
          source = await convertPicked(filePath)
        }
        if (owner !== distillRuns) throw new Error('The vault changed. Pick the document again.')
        return await runDistillPipeline(runId, source, {
          resume: false,
          focus: asked || undefined
        })
      } finally {
        activeRunId = null
      }
    }
  )

  // Continue a run that was cancelled or interrupted. Everything it needs is in
  // its own folder — the converted text and the windows already extracted — so
  // the original document does not have to be anywhere near.
  ipcMain.handle('distill:resume', async (_e, runId: string): Promise<DistillRunResult> => {
    if (!index || !vaultRoot || !distillRuns) throw new Error('Open a vault first.')
    if (activeRunId !== null)
      throw new Error('A document is already being distilled — wait for it to finish or cancel it.')
    if (!isUnfinishedRun(vaultRoot, runId)) throw new Error('That run has already finished.')
    const source = readRunSource(vaultRoot, runId)
    if (!source) throw new Error("That run can't be resumed — its saved text is missing.")
    activeRunId = runId
    try {
      // The focus was asked for once, when the run started; `run.json` is where
      // it has been waiting, so a resume reads the document the same way.
      return await runDistillPipeline(runId, source, {
        resume: true,
        focus: readRunJson(vaultRoot, runId)?.focus
      })
    } finally {
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
        hiddenSources: 0,
        ambiguousTargets: 0
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
      if (!index || !distillRuns)
        return { nodes: [], edges: [], hiddenSources: 0, ambiguousTargets: 0 }
      return overlayGraph(index.graphRows(), distillRuns.rows(runId), focus ?? null, distillOpts(opts))
    }
  )

  // Staged runs with enough context to render a list: note count and theme
  // names (from the run's meta.json), and whether the run is already merged.
  ipcMain.handle('distill:listRuns', (): DistillRunInfo[] => {
    if (!distillRuns || !vaultRoot) return []
    const root = vaultRoot
    const out: DistillRunInfo[] = []
    for (const id of distillRuns.list()) {
      // Per entry, not per list: `.distill/` is a real directory a user can put
      // things in, and one unreadable run must not take the whole sidebar down.
      try {
        const meta = readRunMeta(root, id)
        // `meta.json` only exists once a run has FINISHED, so a paused run's
        // focus comes from the start marker instead — which is exactly the
        // moment the user needs to know which reading they would resume.
        const focus = meta?.focus ?? readRunJson(root, id)?.focus
        out.push({
          id,
          notes: meta?.notes ?? 0,
          themes: meta?.themes ?? [],
          ...(focus ? { focus } : {}),
          merged: readMergeManifest(root, id)?.complete === true,
          unfinished: isUnfinishedRun(root, id)
        })
      } catch {
        /* not a run we can describe — leave it out of the list */
      }
    }
    return out
  })

  ipcMain.handle('distill:remove', (_e, runId: string) => distillRuns?.remove(runId))

  // Read ONE staged note, for the read-only pane that lets you check a run
  // before merging it. `readStagedNote` validates the name against the run's own
  // `notes/` dir, so the renderer can't read its way out of the run.
  ipcMain.handle(
    'distill:readNote',
    (_e, runId: string, name: string): { content: string } | null => {
      if (!vaultRoot) return null
      const content = readStagedNote(vaultRoot, runId, name)
      return content === null ? null : { content }
    }
  )

  // What merging this run would do, decided before a byte is written: which
  // notes are new, which the vault already holds verbatim, and which share a
  // name with a DIFFERENT note of yours (and so get saved beside it). Main
  // recomputes this at merge time too — the renderer only sends confirmations.
  // The plan is recomputed at merge time (the vault may have changed since the
  // dialog); only what the dialog showed is carried over (see `shownCandidates`
  // and `shownTwins` above).
  const planMergeFor = async (runId: string, mode: 'show' | 'merge'): Promise<DistillMergePlan> => {
    if (!vaultRoot || !index) throw new Error('Open a vault first.')
    const raw = readRunMeta(vaultRoot, runId)?.source ?? readRunJson(vaultRoot, runId)?.file ?? runId
    const title = sourceNoteName(raw)
    // The document itself is not planned like a note: it goes to `Sources/`,
    // once, whichever run brought it (see artifact.mergeRun).
    const staged = readRunNotes(vaultRoot, runId).filter(
      (n) => n.name.toLowerCase() !== title.toLowerCase()
    )
    // Every note name anywhere in the vault; hashes only where a name actually
    // clashes, so planning a merge doesn't read the whole vault off disk.
    const wanted = new Set(staged.map((n) => n.name.toLowerCase()))
    const names = new Set<string>()
    const hashByName = new Map<string, string>()
    for (const p of index.knownFiles().keys()) {
      const name = basename(p).replace(/\.md$/i, '')
      names.add(name)
      if (!wanted.has(name.toLowerCase()) || hashByName.has(name)) continue
      try {
        hashByName.set(name, contentHash(readFileSync(p)))
      } catch {
        /* unreadable — treat as a collision, which is the cautious answer */
      }
    }
    const entries = mergePlan(staged, { names, hashByName }, title)
    let pairs: Map<string, string>
    if (mode === 'show') {
      pairs = await findSameAsCandidates(runId, staged, entries)
      shownCandidates.set(runId, pairs)
    } else {
      pairs = shownCandidates.get(runId) ?? new Map()
      shownCandidates.delete(runId)
    }
    for (const e of entries) {
      const twin = pairs.get(e.name)
      if (twin && e.action === 'new' && names.has(twin)) e.sameAsCandidate = twin
    }
    if (mode === 'show') {
      const twins = new Map<string, string>()
      for (const e of entries) {
        const twin = twinOf(e)
        if (twin) twins.set(e.name, twin)
      }
      shownTwins.set(runId, twins)
    }
    return { sourceTitle: title, entries }
  }

  // A `new` note that means the same as a note you already have, under another
  // name (`distill/sameAs.ts`): proposed, never applied. Only when talk is on —
  // the vault's note vectors ARE the talk index — and never fatal: a merge must
  // go ahead without suggestions rather than not at all. The staged notes are
  // embedded the way the index embeds a note (chunk → embedText → mean), through
  // the renderer's own embedder, so both sides use one model.
  const findSameAsCandidates = async (
    runId: string,
    staged: { name: string; content: string }[],
    entries: DistillMergePlan['entries']
  ): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    if (!index) return out
    const vault = index.talkNoteVectors()
    if (vault.size === 0) return out
    const fresh = new Set(entries.filter((e) => e.action === 'new').map((e) => e.name))
    const notes = staged.filter((n) => fresh.has(n.name))
    if (notes.length === 0) return out
    try {
      // A short deadline: the dialog is waiting on this, and a renderer that
      // cannot embed within it gets a plan without proposals, not a stall.
      const embedder = rendererEmbedder(`plan:${runId}`, 30_000)
      const texts: string[] = []
      const spans: { name: string; from: number; to: number }[] = []
      for (const n of notes) {
        const from = texts.length
        for (const c of chunkMarkdown(n.content)) texts.push(embedText(c))
        spans.push({ name: n.name, from, to: texts.length })
      }
      const vectors: Float32Array[] = []
      for (let i = 0; i < texts.length; i += 64) vectors.push(...(await embedder.embed(texts.slice(i, i + 64))))
      const run: NoteVec[] = []
      for (const s of spans) {
        const vec = noteVector(vectors.slice(s.from, s.to))
        if (vec) run.push({ id: s.name, vec })
      }
      const vaultVecs: NoteVec[] = [...vault].map(([path, vec]) => ({ id: path, vec }))
      const width = run[0]?.vec.length ?? 0
      if (width > 0 && vaultVecs[0] && vaultVecs[0].vec.length !== width) {
        console.warn(
          `[distill] same-as candidates skipped: the run's vectors are ${width} wide, the vault's ${vaultVecs[0].vec.length} — different embedding models`
        )
        return out
      }
      const pairs = await sameAsCandidatesYielding(run, vaultVecs, readSettings().talk.relatedMinScore)
      for (const [name, path] of pairs) out.set(name, noteName(path))
    } catch (err) {
      console.warn('[distill] same-as candidates skipped:', err instanceof Error ? err.message : err)
    }
    return out
  }

  ipcMain.handle('distill:mergePlan', (_e, runId: string): Promise<DistillMergePlan> => planMergeFor(runId, 'show'))

  // Merge a run into the vault: copy its notes into a namespaced subfolder so the
  // canonical index picks them up. Reversible — a manifest records what we wrote.
  // `sameAs` names the staged notes the user confirmed are the same thing as
  // their vault twin; each gets a `same_as::` line the map then collapses.
  ipcMain.handle('distill:merge', async (_e, runId: string, opts?: { sameAs?: string[] }): Promise<DistillMergeResult> => {
    if (!vaultRoot || !index) throw new Error('Open a vault first.')
    const plan = await planMergeFor(runId, 'merge')
    // A tick is "same as the twin I was shown": pair each ticked name with the
    // twin the dialog showed beside it, and let the merge keep only those that
    // still hold against the fresh plan (`confirmedSameAs`).
    // A tick with no remembered twin (the vault was closed and reopened in
    // between, which clears what was shown) is dropped, never reinterpreted.
    const twins = shownTwins.get(runId) ?? new Map<string, string>()
    shownTwins.delete(runId)
    const confirmations: { name: string; twin: string }[] = []
    for (const name of opts?.sameAs ?? []) {
      const twin = twins.get(name)
      if (twin) confirmations.push({ name, twin })
    }
    const { manifest, written } = mergeRun(vaultRoot, runId, plan.entries, {
      sameAs: confirmations
    })
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
    return {
      folder: manifest.folder,
      count: manifest.files.length,
      skipped: manifest.skipped?.length ?? 0
    }
  })

  // Undo a merge: take back exactly what it wrote and de-index it. Notes the
  // user edited since merging go to the Trash instead of being deleted.
  ipcMain.handle('distill:unmerge', async (_e, runId: string): Promise<DistillUnmergeResult> => {
    if (!vaultRoot || !index) return { removed: 0, trashed: 0 }
    const { removed, trashed } = await unmergeRun(vaultRoot, runId, (p) => shell.trashItem(p))
    for (const p of [...removed, ...trashed]) index.removeFile(p)
    notifyVaultChanged()
    notifyIndexChanged()
    return { removed: removed.length, trashed: trashed.length }
  })

  // Open the file a distilled document was converted from, in the system's own
  // reader. The renderer names the HASH, never a path: main looks the path up in
  // the source store and refuses anything that is not there any more — so a
  // note cannot talk the app into opening an arbitrary file.
  ipcMain.handle('distill:openOriginal', async (_e, hash: string): Promise<string | null> => {
    if (!vaultRoot) return 'Open a vault first.'
    const path = originalPathOf(vaultRoot, hash)
    if (!path) return "That document's original file isn't where it was — it may have moved."
    const err = await shell.openPath(path)
    return err || null
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
// and a user who later deliberately picks that legacy value keeps it.
function applySettingsMigrations(): void {
  const marker = join(app.getPath('userData'), '.migrations')
  const applied = existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []
  const id = 'embed-model-multilingual-e5'
  if (applied.includes(id)) return
  const path = ensureSettingsFile()
  const migrated = migrateEmbedModel(readFileSync(path, 'utf8'))
  if (migrated !== null) atomicWrite(path, migrated)
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
app.on('before-quit', (event) => {
  if (mainWindow && deferClose(mainWindow, true)) event.preventDefault()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  telemetry.stop()
  void closeVault()
})
