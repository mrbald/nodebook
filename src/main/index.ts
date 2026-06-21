import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join, relative, dirname, sep } from 'path'
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
import type { MarkdownFile, VaultListing } from '../shared/types'
import { VaultIndex } from './indexer'
import {
  ensureSettingsFile,
  readSettings,
  setThemeMode,
  setTalkEnabled,
  settingsPath as settingsFilePath,
  DEFAULT_TOML,
  type ThemeMode
} from './settings'
import type { TalkStatus } from '../shared/types'

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

async function closeVault(): Promise<void> {
  if (watcher) await watcher.close()
  watcher = null
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
      if (MD_EXT.test(p)) void indexPath(p).then(notifyTalkDirty)
    })
    .on('unlink', (p: string) => {
      if (MD_EXT.test(p)) index?.removeFile(p)
      notifyVaultChanged()
    })
    .on('addDir', notifyVaultChanged)
    .on('unlinkDir', notifyVaultChanged)

  return listing
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

  ipcMain.handle('vault:open', (_e, root: string) => openVault(root))

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
    }
  })

  // Synchronous save used on window close (beforeunload can't await async IPC).
  ipcMain.on('file:save-now', (e, path: string, content: string) => {
    try {
      if (!isAccessibleFile(path)) {
        e.returnValue = false
        return
      }
      atomicWrite(path, content)
      if (index && withinVault(path)) index.indexFile(path, content, 0)
    } catch {
      // best effort on the way out
    }
    e.returnValue = true
  })

  ipcMain.handle('index:backlinks', (_e, target: string) => index?.backlinks(target) ?? [])

  ipcMain.handle('index:outbound', (_e, sourceFile: string) => index?.outbound(sourceFile) ?? [])

  ipcMain.handle('index:search', (_e, query: string) => index?.search(query) ?? [])

  ipcMain.handle('index:noteNames', () => index?.noteNames() ?? [])

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

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (cmd: string): void => mainWindow?.webContents.send('menu:command', cmd)
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Export PDF…', click: () => send('export-pdf') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Code', accelerator: 'CmdOrCtrl+1', click: () => send('mode-code') },
        { label: 'Live Preview', accelerator: 'CmdOrCtrl+2', click: () => send('mode-live') },
        { label: 'Reading', accelerator: 'CmdOrCtrl+3', click: () => send('mode-reading') },
        { label: 'Toggle Reading', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-read') },
        { type: 'separator' as const },
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        // Native role → label flips "Enter Full Screen" / "Exit Full Screen".
        { role: 'togglefullscreen' as const }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Markdown & Syntax', click: () => send('help') }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  registerIpc()
  buildAppMenu()
  createWindow()

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
  void closeVault()
})
