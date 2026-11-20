/**
 * The staged store for distill runs: each run gets its OWN `VaultIndex` over a
 * `run.db` inside its `.distill/<id>/` folder. Because that db is
 * separate from the canonical index, a run's notes can never leak into vault-wide
 * search, backlinks, or the graph — the firewall is structural, not a predicate
 * threaded through every query. Promotion moves the notes into the vault
 * proper and lets the normal indexer pick them up.
 */

import { lstatSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { VaultIndex } from '../indexer'
import {
  writeRunArtifact,
  distillRoot,
  runDir,
  listRuns,
  removeRun,
  isRunId,
  readStagedNote,
  stagedNotePath,
  type RunSource
} from './artifact'
import { projectBook } from './bookOverview'
import type { EmittedNote } from './emit'
import type { GraphRows } from '../graph'
import type {
  BookLinkEvidence,
  BookOverview,
  BookThemeDetails,
  GraphData,
  StagedNoteRead
} from '../../shared/types'

export class StagedRunStore {
  /** One open VaultIndex per run, reused across graph queries. */
  private indices = new Map<string, VaultIndex>()
  /** Overview and drill-down share one projection of the last staged book. */
  private bookProjection: { runId: string; book: ReturnType<typeof projectBook> } | null = null

  constructor(private vaultRoot: string) {}

  private localRun(runId: string, allowMissing = false): boolean {
    if (typeof runId !== 'string' || !isRunId(runId)) return false
    return [distillRoot(this.vaultRoot), runDir(this.vaultRoot, runId)].every((path) => {
      const entry = lstatSync(path, { throwIfNoEntry: false })
      return entry ? entry.isDirectory() : allowMissing
    })
  }

  /**
   * The run's index, opening it on first use.
   *
   * `run.db` caches `notes/*.md`. A copy or migration can bring an existing
   * database with absolute paths from its previous location. Rebuild those
   * caches in memory, publishing the index only after the local notes are read.
   */
  private indexOf(runId: string, rebuild = true): VaultIndex {
    if (!this.localRun(runId)) throw new Error('Staged run is unavailable.')
    let idx = this.indices.get(runId)
    if (!idx) {
      const dbPath = join(runDir(this.vaultRoot, runId), 'run.db')
      // A staged graph cache and its SQLite sidecars belong to this run.
      // Recover questionable caches from the regular note files in memory.
      const dbFile = lstatSync(dbPath, { throwIfNoEntry: false })
      const files = [dbFile, ...['-wal', '-shm', '-journal'].map((suffix) =>
        lstatSync(dbPath + suffix, { throwIfNoEntry: false }))]
      const local = files.every((file) => !file || (file.isFile() && file.nlink === 1))
      idx = new VaultIndex(local ? dbPath : ':memory:')
      try {
        const paths = rebuild && local && dbFile ? idx.indexedPaths() : []
        const relocated = paths.some((path) => stagedNotePath(this.vaultRoot, runId, path) !== path)
        if (relocated) {
          const fresh = new VaultIndex(':memory:')
          idx.close()
          idx = fresh
        }
        if (rebuild && (relocated || paths.length === 0)) this.reindex(runId, idx)
        this.indices.set(runId, idx)
      } catch (error) {
        idx.close()
        throw error
      }
    }
    return idx
  }

  /** Re-index a run's staged notes into a fresh db. */
  private reindex(runId: string, idx: VaultIndex): void {
    const notes = join(runDir(this.vaultRoot, runId), 'notes')
    if (!lstatSync(notes, { throwIfNoEntry: false })?.isDirectory()) return
    const entries = readdirSync(notes, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md'))
    for (const name of entries.map((e) => e.name).sort()) {
      const p = join(notes, name)
      const content = readStagedNote(this.vaultRoot, runId, p)
      if (content !== null) idx.indexFile(p, content, 0)
    }
  }

  /** Write a run's notes to disk and index them into its own db. Replaces any
   *  previous run with the same id (closes its index first). `stats`, the run's
   *  `themes` and the `focus` it was read with are persisted into meta.json —
   *  the first for later diagnosis, the other two for the runs list (see
   *  artifact.planRunFiles). */
  create(
    runId: string,
    source: RunSource,
    notes: EmittedNote[],
    stats?: Record<string, number>,
    themes?: string[],
    focus?: string
  ): { runId: string; dir: string } {
    if (!this.localRun(runId, true)) throw new Error('Staged run is unavailable.')
    this.closeOne(runId)
    // Finishing a run no longer wipes its whole folder (run.json/source.md are
    // written at the start and a resume needs them), so a db left by an earlier
    // attempt has to go explicitly — otherwise its rows would join the new ones.
    for (const f of ['run.db', 'run.db-wal', 'run.db-shm'])
      rmSync(join(runDir(this.vaultRoot, runId), f), { force: true })
    const { dir, notePaths } = writeRunArtifact(
      this.vaultRoot,
      runId,
      source,
      notes,
      stats,
      themes,
      focus
    )
    const idx = this.indexOf(runId, false) // the loop below indexes them; no rebuild
    for (const p of notePaths) idx.indexFile(p, readFileSync(p, 'utf8'), 0)
    return { runId, dir }
  }

  notePreview(runId: string, path: string): string {
    return this.indexOf(runId).notePreview(path)
  }

  /** The run's knowledge graph (staged-only — never the canonical vault).
   *  `focus` is a staged note's *path*, like the vault map's — node identity is
   *  the path on both sides, so the same focus value works in either view. */
  graph(
    runId: string,
    focus: string | null = null,
    opts?: { depth?: number; cap?: number }
  ): GraphData {
    return this.indexOf(runId).graph(focus, opts)
  }

  /** The run's raw graph rows, for composing an overlay with the vault. */
  rows(runId: string): GraphRows {
    return this.indexOf(runId).graphRows()
  }

  private project(runId: string): ReturnType<typeof projectBook> | null {
    if (!this.localRun(runId)) return null
    if (this.bookProjection?.runId === runId) return this.bookProjection.book
    const idx = this.indexOf(runId)
    const book = projectBook(idx.graphRows(), (path) => idx.indexedNoteText(path))
    this.bookProjection = { runId, book }
    return book
  }

  bookOverview(runId: string): BookOverview | null {
    return this.project(runId)?.overview ?? null
  }

  themeDetails(runId: string, themeId: string | null): BookThemeDetails | null {
    return this.project(runId)?.themeDetails(themeId) ?? null
  }

  linkEvidence(runId: string, source: string, target: string): BookLinkEvidence | null {
    return this.project(runId)?.linkEvidence(source, target) ?? null
  }

  themeGraph(runId: string, themeId: string | null, cap?: number): GraphData | null {
    return this.project(runId)?.themeGraph(themeId, cap) ?? null
  }

  readNote(runId: string, note: string): StagedNoteRead | null {
    const path = stagedNotePath(this.vaultRoot, runId, note)
    if (!path) return null
    const content = readStagedNote(this.vaultRoot, runId, path)
    if (content === null) return null
    try {
      const theme = this.project(runId)?.themeOf(path)
      return { content, themeId: theme?.id ?? null, themeLabel: theme?.label ?? null }
    } catch {
      // Staged markdown can still be read when its derived index is unavailable.
      return { content, themeId: null, themeLabel: null }
    }
  }

  list(): string[] {
    return listRuns(this.vaultRoot)
  }

  remove(runId: string): void {
    this.closeOne(runId)
    removeRun(this.vaultRoot, runId)
  }

  private closeOne(runId: string): void {
    if (this.bookProjection?.runId === runId) this.bookProjection = null
    const idx = this.indices.get(runId)
    if (idx) {
      idx.close()
      this.indices.delete(runId)
    }
  }

  close(): void {
    this.bookProjection = null
    for (const idx of this.indices.values()) idx.close()
    this.indices.clear()
  }
}
