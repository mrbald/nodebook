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

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, copyFileSync } from 'fs'
import { join, sep } from 'path'
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
  for (const n of notes) files.push({ relPath: join('notes', n.fileName), content: n.content })
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

/** Record of one merge, so it can be undone cleanly. Stored beside the run. */
export interface MergeManifest {
  /** Vault-relative folder the run was merged into (e.g. `Distilled/sapiens`). */
  folder: string
  /** Vault-relative paths of every file the merge wrote. */
  files: string[]
}

/** The namespaced vault folder a run merges into (vault-relative). */
export function mergeFolder(runId: string): string {
  assertRunId(runId)
  return join('Distilled', runId)
}

function manifestPath(vaultRoot: string, runId: string): string {
  return join(runDir(vaultRoot, runId), 'merge.json')
}

/** The merge manifest for a run, or null if it hasn't been merged. */
export function readMergeManifest(vaultRoot: string, runId: string): MergeManifest | null {
  const p = manifestPath(vaultRoot, runId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MergeManifest
  } catch {
    return null
  }
}

/**
 * Copy a run's notes into a namespaced vault subfolder and write a manifest.
 * Filesystem only — the caller indexes the new files into the canonical index
 * (the watcher would too). Returns the manifest plus the absolute paths written.
 */
export function mergeRun(
  vaultRoot: string,
  runId: string
): { manifest: MergeManifest; written: string[] } {
  const notesDir = join(runDir(vaultRoot, runId), 'notes')
  const folder = mergeFolder(runId)
  const targetAbs = join(vaultRoot, folder)
  mkdirSync(targetAbs, { recursive: true })

  const files: string[] = []
  const written: string[] = []
  for (const name of readdirSync(notesDir).sort()) {
    if (!name.endsWith('.md')) continue
    copyFileSync(join(notesDir, name), join(targetAbs, name))
    files.push(join(folder, name))
    written.push(join(targetAbs, name))
  }
  const manifest: MergeManifest = { folder, files }
  writeFileSync(manifestPath(vaultRoot, runId), JSON.stringify(manifest, null, 2))
  return { manifest, written }
}

/**
 * Undo a merge: delete exactly the files it wrote (and the now-empty folder) and
 * the manifest. Returns the absolute paths removed, so the caller can de-index.
 */
export function unmergeRun(vaultRoot: string, runId: string): string[] {
  const manifest = readMergeManifest(vaultRoot, runId)
  if (!manifest) return []
  const removed: string[] = []
  for (const rel of manifest.files) {
    const abs = join(vaultRoot, rel)
    rmSync(abs, { force: true })
    removed.push(abs)
  }
  const targetAbs = join(vaultRoot, manifest.folder)
  if (existsSync(targetAbs) && readdirSync(targetAbs).length === 0) {
    rmSync(targetAbs, { recursive: true, force: true })
  }
  rmSync(manifestPath(vaultRoot, runId), { force: true })
  return removed
}
