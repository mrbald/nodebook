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

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join, basename, sep } from 'path'
import type { EmittedNote } from './emit'

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

/** The note name for the source book (its `source::` target), from a path. */
export function sourceNoteName(file: string): string {
  return basename(file).replace(/\.md$/i, '')
}

export interface RunSource {
  /** Identifier used in citations and the `source::` edge (e.g. `Federalist.md`). */
  file: string
  text: string
}

export interface PlannedFile {
  /** Path relative to the run dir. */
  relPath: string
  content: string
}

/**
 * The files a run consists of: the source book as a note (so `source::` resolves
 * to a real node, not a ghost), each emitted note, and a `meta.json`. Pure —
 * decides the layout without touching disk.
 */
export function planRunFiles(source: RunSource, notes: EmittedNote[]): PlannedFile[] {
  const sourceFile = `${sourceNoteName(source.file)}.md`
  const files: PlannedFile[] = [{ relPath: join('notes', sourceFile), content: source.text }]
  for (const n of notes) files.push({ relPath: join('notes', n.fileName), content: n.content })
  files.push({
    relPath: 'meta.json',
    content: JSON.stringify({ source: sourceFile, notes: notes.length }, null, 2)
  })
  return files
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
  notes: EmittedNote[]
): RunArtifact {
  const dir = runDir(vaultRoot, runId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'notes'), { recursive: true })
  const notePaths: string[] = []
  for (const f of planRunFiles(source, notes)) {
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
