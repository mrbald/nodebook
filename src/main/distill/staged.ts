/**
 * The staged store for distill runs: each run gets its OWN `VaultIndex` over a
 * `run.db` inside its `.nodebook/distill/<id>/` folder. Because that db is
 * separate from the canonical index, a run's notes can never leak into vault-wide
 * search, backlinks, or the graph — the firewall is structural, not a predicate
 * threaded through every query. Promotion (out of scope for D1) would move the
 * notes into the vault proper and let the normal indexer pick them up.
 *
 * Not unit-tested: it constructs a `VaultIndex` (better-sqlite3), whose native
 * addon is built for Electron's ABI and won't load under vitest. The fs layout +
 * firewall live in artifact.ts (unit-tested); this thin wrapper is e2e-covered.
 */

import { readFileSync } from 'fs'
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

  private indexOf(runId: string): VaultIndex {
    let idx = this.indices.get(runId)
    if (!idx) {
      idx = new VaultIndex(join(runDir(this.vaultRoot, runId), 'run.db'))
      this.indices.set(runId, idx)
    }
    return idx
  }

  /** Write a run's notes to disk and index them into its own db. Replaces any
   *  previous run with the same id (closes its index first). */
  create(runId: string, source: RunSource, notes: EmittedNote[]): { runId: string; dir: string } {
    this.closeOne(runId)
    const { dir, notePaths } = writeRunArtifact(this.vaultRoot, runId, source, notes)
    const idx = this.indexOf(runId)
    for (const p of notePaths) idx.indexFile(p, readFileSync(p, 'utf8'), 0)
    return { runId, dir }
  }

  /** The run's knowledge graph (staged-only — never the canonical vault). */
  graph(runId: string, focus: string | null = null, opts?: { depth?: number; cap?: number }): GraphData {
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
