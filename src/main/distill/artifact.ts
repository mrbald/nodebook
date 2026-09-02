/**
 * The on-disk layout of a distill run — pure path logic plus filesystem writes,
 * with NO database dependency. This is deliberate: the `better-sqlite3` native
 * addon is built for Electron's ABI and can't load under vitest, so the indexed
 * store (a `VaultIndex` over the run's db) lives separately and is e2e-covered.
 * Keeping the layout here means the part that matters most — the firewall — is
 * unit-testable.
 *
 * A run is a self-contained artifact under the vault's `.nodebook/` dir: the
 * dot-dir the canonical scan and file watcher already ignore. That ignore IS the
 * firewall — staged notes can't reach the canonical index, search, or graph
 * until an explicit promote moves them into the vault proper.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { join, sep } from 'path'
import { withinRoot } from '../paths'
import { noteName, sourceTitle, type EmittedNote } from './emit'

/** A safe run id is one path segment: alphanumeric start, then word/space/.-, no `..`. */
const RUN_ID_RE = /^[A-Za-z0-9][\w .-]*$/

export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId) || runId.includes('..'))
    throw new Error(`invalid distill run id: ${JSON.stringify(runId)}`)
}

/** `<vault>/.nodebook/distill` — the parent of all runs. */
export function distillRoot(vaultRoot: string): string {
  return join(vaultRoot, '.nodebook', 'distill')
}

/** A run's own folder. Throws on an unsafe id. */
export function runDir(vaultRoot: string, runId: string): string {
  assertRunId(runId)
  return join(distillRoot(vaultRoot), runId)
}

/** The note name for the source book (its `source::` target), from a path.
 *  Reuses emit.ts's `sourceTitle` + `noteName` exactly, so this is always the
 *  same name the emitted notes' `source::` link points at — the link resolves
 *  to a real note instead of a ghost. */
export function sourceNoteName(file: string): string {
  return noteName(sourceTitle(file))
}

export interface RunSource {
  /** The document's raw file identifier (e.g. `Federalist.md`). Note names
   *  derive from it via `sourceNoteName`; `meta.json` keeps it as-is. */
  file: string
  text: string
}

export interface PlannedFile {
  /** Path relative to the run dir. */
  relPath: string
  content: string
}

/**
 * The files a run consists of: the source book as a note (named `sourceNoteName`
 * so `source::` resolves to a real node, not a ghost), each emitted note, and a
 * `meta.json` — which keeps the RAW source file identifier, the run's one record
 * of machine provenance now the notes carry only the short title. Pure — decides
 * the layout without touching disk. `stats` (the pipeline's run stats) is
 * persisted so a bad run — say, zero notes because every claim failed quote
 * verification — stays diagnosable after the completion banner is dismissed.
 */
export function planRunFiles(
  source: RunSource,
  notes: EmittedNote[],
  stats?: Record<string, number>
): PlannedFile[] {
  const sourceFile = `${sourceNoteName(source.file)}.md`
  const files: PlannedFile[] = [{ relPath: join('notes', sourceFile), content: source.text }]
  for (const n of notes) {
    // Backstop: emitNotes reserves the source name, so a collision here means
    // the caller forgot to pass it — fail loudly instead of silently writing
    // the concept over the book.
    if (n.fileName.toLowerCase() === sourceFile.toLowerCase())
      throw new Error(
        `distill: emitted note "${n.fileName}" would overwrite the source note — emitNotes must reserve "${sourceFile}"`
      )
    files.push({ relPath: join('notes', n.fileName), content: n.content })
  }
  files.push({
    relPath: 'meta.json',
    content: JSON.stringify(
      { source: source.file, notes: notes.length, ...(stats ? { stats } : {}) },
      null,
      2
    )
  })
  return files
}

/** What `meta.json` records about a run (see `planRunFiles`). */
export interface RunMeta {
  /** The raw source file identifier, exactly as given to the run. */
  source: string
  notes: number
  stats?: Record<string, number>
}

/** Read a run's `meta.json`; null when missing/unreadable (pre-stats runs
 *  still parse — `stats` is simply absent). */
export function readRunMeta(vaultRoot: string, runId: string): RunMeta | null {
  try {
    const raw = readFileSync(join(runDir(vaultRoot, runId), 'meta.json'), 'utf8')
    const m = JSON.parse(raw) as RunMeta
    return typeof m.source === 'string' && typeof m.notes === 'number' ? m : null
  } catch {
    return null
  }
}

export interface RunArtifact {
  dir: string
  /** Absolute paths of the note files (source + emitted) — what the caller indexes. */
  notePaths: string[]
}

/**
 * Write a run's files to disk, replacing any previous artifact for that id.
 * Filesystem only — no indexing. Returns the note paths for the caller to index
 * into the run's separate database.
 */
export function writeRunArtifact(
  vaultRoot: string,
  runId: string,
  source: RunSource,
  notes: EmittedNote[],
  stats?: Record<string, number>
): RunArtifact {
  const dir = runDir(vaultRoot, runId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'notes'), { recursive: true })
  const notePaths: string[] = []
  for (const f of planRunFiles(source, notes, stats)) {
    const abs = join(dir, f.relPath)
    writeFileSync(abs, f.content)
    if (f.relPath.startsWith(`notes${sep}`)) notePaths.push(abs)
  }
  return { dir, notePaths }
}

/** Existing run ids under the vault, sorted. */
export function listRuns(vaultRoot: string): string[] {
  const base = distillRoot(vaultRoot)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Delete a run's whole artifact. */
export function removeRun(vaultRoot: string, runId: string): void {
  rmSync(runDir(vaultRoot, runId), { recursive: true, force: true })
}

// --- Merge into the vault (reversible) -----------------------------------
// "Merge" copies a run's notes OUT of the staged dir into a namespaced vault
// subfolder, so they become real notes the canonical index picks up. It records
// a manifest of exactly what it wrote, so "un-merge" is just deleting those.

/** One file a merge wrote: where it landed, and the bytes it landed with. */
export interface MergeFile {
  /** Vault-relative path (always inside the manifest's `folder`). */
  path: string
  /** sha1 hex of the bytes written. Absent in manifests from before hashing —
   *  undo can't tell those apart from edited files, so it trashes them. */
  hash?: string
}

/** Record of one merge, so it can be undone cleanly. Stored beside the run. */
export interface MergeManifest {
  /** Vault-relative folder the run was merged into (e.g. `Distilled/sapiens`). */
  folder: string
  /** Every file the merge planned to write, with the hash it wrote. */
  files: MergeFile[]
  /** False while the copy is still in flight: the manifest is written BEFORE
   *  the files so a crash mid-merge is still undoable. */
  complete: boolean
}

/** The namespaced vault folder a run merges into (vault-relative). */
export function mergeFolder(runId: string): string {
  assertRunId(runId)
  return join('Distilled', runId)
}

function manifestPath(vaultRoot: string, runId: string): string {
  return join(runDir(vaultRoot, runId), 'merge.json')
}

/** sha1 hex of some bytes — the identity undo compares a file against. */
function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

/**
 * The merge manifest for a run, or null if it hasn't been merged.
 *
 * Undo deletes what this file names, so it is parsed as UNTRUSTED input: the
 * folder must be the one this run merges into, and every listed path must
 * resolve inside that folder (a `..` entry would otherwise escape the vault).
 * Anything unexpected → null, i.e. "not merged", which is the safe answer.
 * The legacy shape (`files: string[]`, no `complete`) normalises to hash-less,
 * complete entries.
 */
export function readMergeManifest(vaultRoot: string, runId: string): MergeManifest | null {
  const p = manifestPath(vaultRoot, runId)
  if (!existsSync(p)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as { folder?: unknown; files?: unknown; complete?: unknown }
  let expectedFolder: string
  try {
    expectedFolder = mergeFolder(runId)
  } catch {
    return null
  }
  if (m.folder !== expectedFolder || !Array.isArray(m.files)) return null

  const folderAbs = join(vaultRoot, expectedFolder)
  const legacy = m.files.every((e) => typeof e === 'string')
  const files: MergeFile[] = []
  for (const e of m.files) {
    const entry = typeof e === 'string' ? { path: e } : (e as { path?: unknown; hash?: unknown })
    if (typeof entry.path !== 'string') return null
    if (!withinRoot(folderAbs, join(vaultRoot, entry.path))) return null
    files.push(
      typeof entry.hash === 'string' ? { path: entry.path, hash: entry.hash } : { path: entry.path }
    )
  }
  return {
    folder: expectedFolder,
    files,
    complete: typeof m.complete === 'boolean' ? m.complete : legacy
  }
}

/**
 * Copy a run's notes into a namespaced vault subfolder and record what it wrote.
 * Filesystem only — the caller indexes the new files into the canonical index
 * (the watcher would too). Returns the manifest plus the absolute paths written.
 *
 * Crash-safe by construction: the manifest is written FIRST (every planned file
 * with the hash it will get, `complete: false`), each note is then written to a
 * dot-prefixed temp name and renamed into place (so a reader never sees half a
 * note), and only then is the manifest rewritten as complete. A crash at any
 * point leaves a manifest that names everything undo must clean up.
 */
export function mergeRun(
  vaultRoot: string,
  runId: string
): { manifest: MergeManifest; written: string[] } {
  const notesDir = join(runDir(vaultRoot, runId), 'notes')
  const folder = mergeFolder(runId)
  const targetAbs = join(vaultRoot, folder)

  const planned: { name: string; bytes: Buffer }[] = []
  for (const name of readdirSync(notesDir).sort()) {
    if (!name.endsWith('.md')) continue
    planned.push({ name, bytes: readFileSync(join(notesDir, name)) })
  }
  const files: MergeFile[] = planned.map((f) => ({
    path: join(folder, f.name),
    hash: sha1(f.bytes)
  }))

  const mPath = manifestPath(vaultRoot, runId)
  writeFileSync(mPath, JSON.stringify({ folder, files, complete: false }, null, 2))

  mkdirSync(targetAbs, { recursive: true })
  const written: string[] = []
  for (const f of planned) {
    const abs = join(targetAbs, f.name)
    // Dot-prefixed: if a crash strands one, the vault scan and watcher skip it.
    const tmp = join(targetAbs, `.${f.name}.merge-tmp`)
    writeFileSync(tmp, f.bytes)
    renameSync(tmp, abs)
    written.push(abs)
  }

  const manifest: MergeManifest = { folder, files, complete: true }
  writeFileSync(mPath, JSON.stringify(manifest, null, 2))
  return { manifest, written }
}

/**
 * Undo a merge: take back exactly what it wrote, then drop the now-empty folder
 * and the manifest.
 *
 * A file whose bytes still hash to what the merge wrote is deleted outright —
 * nothing of the user's is in it. A file that DIFFERS (they edited it after
 * merging), or that a pre-hash manifest can't vouch for, goes to `trash`
 * instead, so an undo can never destroy their work. Missing files are skipped.
 * `trash` is injected (main passes `shell.trashItem`) to keep this unit-testable.
 */
export async function unmergeRun(
  vaultRoot: string,
  runId: string,
  trash: (absPath: string) => Promise<void>
): Promise<{ removed: string[]; trashed: string[] }> {
  const manifest = readMergeManifest(vaultRoot, runId)
  if (!manifest) return { removed: [], trashed: [] }
  const removed: string[] = []
  const trashed: string[] = []
  for (const entry of manifest.files) {
    const abs = join(vaultRoot, entry.path)
    let bytes: Buffer
    try {
      bytes = readFileSync(abs)
    } catch {
      continue // already gone — nothing to take back
    }
    if (entry.hash && sha1(bytes) === entry.hash) {
      rmSync(abs, { force: true })
      removed.push(abs)
    } else {
      // Edited (or unverifiable): recoverable move only, never an rm.
      await trash(abs)
      trashed.push(abs)
    }
  }
  const targetAbs = join(vaultRoot, manifest.folder)
  if (existsSync(targetAbs) && readdirSync(targetAbs).length === 0) {
    rmSync(targetAbs, { recursive: true, force: true })
  }
  rmSync(manifestPath(vaultRoot, runId), { force: true })
  return { removed, trashed }
}
