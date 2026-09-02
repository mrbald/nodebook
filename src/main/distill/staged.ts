/**
 * The staged store for distill runs: each run gets its OWN `VaultIndex` over a
 * `run.db` inside its `.distill/<id>/` folder. Because that db is
 * separate from the canonical index, a run's notes can never leak into vault-wide
 * search, backlinks, or the graph — the firewall is structural, not a predicate
 * threaded through every query. Promotion (out of scope for D1) would move the
 * notes into the vault proper and let the normal indexer pick them up.
 *
 * Not unit-tested: it constructs a `VaultIndex` (better-sqlite3), whose native
 * addon is built for Electron's ABI and won't load under vitest. The fs layout +
 * firewall live in artifact.ts (unit-tested); this thin wrapper is e2e-covered.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { VaultIndex } from '../indexer'
import { writeRunArtifact, runDir, listRuns, removeRun, type RunSource } from './artifact'
import type { EmittedNote } from './emit'
import type { GraphRows } from '../graph'
import type { GraphData } from '../../shared/types'

export class StagedRunStore {
  /** One open VaultIndex per run, reused across graph queries. */
  private indices = new Map<string, VaultIndex>()

  constructor(private vaultRoot: string) {}

  /**
   * The run's index, opening it on first use.
   *
   * `run.db` is a CACHE of `notes/*.md`, not the run itself — so a run whose db
   * was deleted, or that arrived from a backup or a migration without one, is
   * rebuilt from its markdown instead of rendering an empty map. The notes are
   * the source of truth; that is the same rule `.nodebook/` lives by.
   */
  private indexOf(runId: string, rebuild = true): VaultIndex {
    let idx = this.indices.get(runId)
    if (!idx) {
      const dbPath = join(runDir(this.vaultRoot, runId), 'run.db')
      const missing = !existsSync(dbPath)
      idx = new VaultIndex(dbPath)
      this.indices.set(runId, idx)
      if (missing && rebuild) this.reindex(runId, idx)
    }
    return idx
  }

  /** Re-index a run's staged notes into a fresh db. */
  private reindex(runId: string, idx: VaultIndex): void {
    const notes = join(runDir(this.vaultRoot, runId), 'notes')
    if (!existsSync(notes)) return
    for (const name of readdirSync(notes).sort()) {
      if (!name.endsWith('.md')) continue
      const p = join(notes, name)
      try {
        idx.indexFile(p, readFileSync(p, 'utf8'), 0)
      } catch {
        // unreadable — the rest of the run still renders
      }
    }
  }

  /** Write a run's notes to disk and index them into its own db. Replaces any
   *  previous run with the same id (closes its index first). `stats` is
   *  persisted into meta.json for later diagnosis (see artifact.planRunFiles). */
  create(
    runId: string,
    source: RunSource,
    notes: EmittedNote[],
    stats?: Record<string, number>
  ): { runId: string; dir: string } {
    this.closeOne(runId)
    // Finishing a run no longer wipes its whole folder (run.json/source.md are
    // written at the start and a resume needs them), so a db left by an earlier
    // attempt has to go explicitly — otherwise its rows would join the new ones.
    for (const f of ['run.db', 'run.db-wal', 'run.db-shm'])
      rmSync(join(runDir(this.vaultRoot, runId), f), { force: true })
    const { dir, notePaths } = writeRunArtifact(this.vaultRoot, runId, source, notes, stats)
    const idx = this.indexOf(runId, false) // the loop below indexes them; no rebuild
    for (const p of notePaths) idx.indexFile(p, readFileSync(p, 'utf8'), 0)
    return { runId, dir }
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

  list(): string[] {
    return listRuns(this.vaultRoot)
  }

  remove(runId: string): void {
    this.closeOne(runId)
    removeRun(this.vaultRoot, runId)
  }

  private closeOne(runId: string): void {
    const idx = this.indices.get(runId)
    if (idx) {
      idx.close()
      this.indices.delete(runId)
    }
  }

  close(): void {
    for (const idx of this.indices.values()) idx.close()
    this.indices.clear()
  }
}
