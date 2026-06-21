import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import { harvest } from './harvest'
import { VectorStore, type PendingChunk } from './rag/store'
import { buildGraph, noteName, type FileRow, type TripleRow } from './graph'
import type { Backlink, GraphData, Outbound, SearchHit } from '../shared/types'

/**
 * The per-vault index: FTS5 full text + a triple store, in a single SQLite DB
 * under `<vault>/.nodebook/` (gitignored — it is rebuildable and must never
 * become a second source of truth). Re-indexing a file is delete-then-insert
 * in one transaction, so it is idempotent no matter how often it fires.
 */
export class VaultIndex {
  private db: Database.Database
  /** Vector/semantic layer — null until "talk to docs" is enabled. */
  private vec: VectorStore | null = null

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        title TEXT,
        mtime INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body);
      CREATE TABLE IF NOT EXISTS triples (
        subject TEXT NOT NULL,
        relation TEXT NOT NULL,
        object TEXT NOT NULL,
        source_file TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_source ON triples(source_file);
      CREATE INDEX IF NOT EXISTS idx_triples_relation ON triples(relation);
    `)
  }

  /** Re-parse one file and replace all of its rows (FTS + triples). */
  indexFile(path: string, content: string, mtime = 0): void {
    const { title, text, triples } = harvest(path, content)
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO files (path, title, mtime) VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET title = excluded.title, mtime = excluded.mtime`
        )
        .run(path, title, mtime)
      const id = (this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: number })
        .id

      this.db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id)
      this.db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(
        id,
        title,
        text
      )

      this.db.prepare('DELETE FROM triples WHERE source_file = ?').run(path)
      const insert = this.db.prepare(
        'INSERT INTO triples (subject, relation, object, source_file) VALUES (?, ?, ?, ?)'
      )
      for (const t of triples) insert.run(t.subject, t.relation, t.object, path)
    })()
    // When talk-to-docs is on, (re)chunk for embedding too (content-hash gated,
    // so an unchanged file on reopen is a no-op and never re-embeds).
    this.vec?.chunkFile(path, content)
  }

  /** Drop a file's rows (external delete). */
  removeFile(path: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as
        | { id: number }
        | undefined
      if (!row) return
      this.db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.id)
      this.db.prepare('DELETE FROM files WHERE id = ?').run(row.id)
      this.db.prepare('DELETE FROM triples WHERE source_file = ?').run(path)
    })()
    this.vec?.removeFile(path)
  }

  /** Files that link to (or otherwise reference) `target`, with the relation. */
  backlinks(target: string): Backlink[] {
    return this.db
      .prepare(
        `SELECT DISTINCT source_file, relation FROM triples
         WHERE object = ? ORDER BY relation, source_file`
      )
      .all(target) as Backlink[]
  }

  /** Outbound edges from one note: its `[[links]]` and `key:: value` fields. */
  outbound(sourceFile: string): Outbound[] {
    return this.db
      .prepare(
        `SELECT DISTINCT relation, object FROM triples
         WHERE source_file = ? ORDER BY relation, object`
      )
      .all(sourceFile) as Outbound[]
  }

  /** Full-text search over titles + bodies, prefix-matched, best first, with a
   * matching snippet. The `<mark>` markers are parsed into React elements by the
   * renderer (never innerHTML), so note content can't inject HTML. */
  search(query: string): SearchHit[] {
    const tokens = query.match(/[\p{L}\p{N}]+/gu)
    if (!tokens || tokens.length === 0) return []
    const fts = tokens.map((t) => `${t}*`).join(' ')
    return this.db
      .prepare(
        `SELECT f.path AS path, f.title AS title,
                snippet(notes_fts, 1, '<mark>', '</mark>', '…', 10) AS snippet
         FROM notes_fts JOIN files f ON f.id = notes_fts.rowid
         WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50`
      )
      .all(fts) as SearchHit[]
  }

  /** A slice of the knowledge graph: local depth-`d` around a focus note (by
   *  path), or the whole graph (focusPath null) capped to the busiest nodes. */
  graph(focusPath: string | null, opts?: { depth?: number; cap?: number }): GraphData {
    // `.map.md` files are saved *views*, not knowledge — exclude them and the
    // edges they author from the graph (see docs/state-and-scopes.md).
    const files = this.db
      .prepare("SELECT path, title FROM files WHERE path NOT LIKE '%.map.md'")
      .all() as FileRow[]
    const triples = this.db
      .prepare("SELECT subject, relation, object FROM triples WHERE source_file NOT LIKE '%.map.md'")
      .all() as TripleRow[]
    return buildGraph(files, triples, focusPath ? noteName(focusPath) : null, opts)
  }

  /** Distinct note base-names (no extension) currently in the index, sorted. */
  noteNames(): string[] {
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[]
    const names = new Set(rows.map((r) => basename(r.path).replace(/\.md$/i, '')))
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  // -------------------------------------------------------------------------
  // Talk to docs — the semantic layer. All of this is inert unless enabled.
  // -------------------------------------------------------------------------

  /** Turn on the vector layer (loads sqlite-vec, creates the chunk tables). */
  enableTalk(): void {
    if (!this.vec) this.vec = new VectorStore(this.db)
  }

  get talkOn(): boolean {
    return !!this.vec
  }

  /** True once the embedding width is known (the vec table exists). */
  get talkReady(): boolean {
    return !!this.vec?.ready
  }

  /** Set the embedding dimensionality reported by the loaded model. */
  setEmbedDims(dims: number): void {
    this.vec?.setDims(dims)
  }

  /** (Re)chunk one file for embedding — content-hash gated. */
  chunkFile(path: string, content: string): boolean {
    return this.vec?.chunkFile(path, content) ?? false
  }

  /** Has this file already been chunked? (skip re-reading from disk on enable). */
  isChunked(path: string): boolean {
    return this.vec?.hasChunks(path) ?? false
  }

  talkPending(limit?: number): PendingChunk[] {
    return this.vec?.pending(limit) ?? []
  }

  talkCounts(): { total: number; pending: number } {
    return this.vec?.counts() ?? { total: 0, pending: 0 }
  }

  putEmbeddings(rows: { id: number; vector: Float32Array }[]): void {
    this.vec?.putEmbeddings(rows)
  }

  /** Notes semantically similar to the focus note (for the map's "related" overlay). */
  talkNeighbors(focusPath: string, k = 5): { path: string; name: string; score: number }[] {
    return (this.vec?.neighbors(focusPath, k) ?? []).map((n) => ({
      path: n.file,
      name: noteName(n.file),
      score: n.score
    }))
  }

  /** Turn the feature off and drop all embeddings + chunks (reversible — the
   *  data is derived and re-creatable by re-enabling). */
  disableTalk(): void {
    this.db.exec(`DROP TABLE IF EXISTS chunk_vec`)
    this.db.exec(`DROP TABLE IF EXISTS chunks`)
    this.db.exec(`DROP TABLE IF EXISTS chunk_file`)
    this.db.exec(`DROP TABLE IF EXISTS talk_meta`)
    this.vec = null
  }

  private titleOf(path: string): string {
    const row = this.db.prepare('SELECT title FROM files WHERE path = ?').get(path) as
      | { title: string | null }
      | undefined
    return row?.title || basename(path).replace(/\.md$/i, '')
  }

  /**
   * Hybrid search: fuse FTS5 (exact terms) with sqlite-vec k-NN (meaning) via
   * Reciprocal Rank Fusion. With no query vector (talk off / query not embedded
   * yet) this is just the keyword search. Hits surfaced by the vector side carry
   * `semantic: true` for the ✨ affordance.
   */
  talkSearch(query: string, queryVec: Float32Array | null): SearchHit[] {
    const fts = this.search(query)
    const vec = this.vec && queryVec ? this.vec.vectorHits(queryVec) : []
    if (vec.length === 0) return fts

    const RRF_K = 60
    const score = new Map<string, number>()
    const hit = new Map<string, SearchHit>()
    fts.forEach((h, i) => {
      score.set(h.path, (score.get(h.path) ?? 0) + 1 / (RRF_K + i + 1))
      hit.set(h.path, h)
    })
    for (const v of vec) {
      score.set(v.file, (score.get(v.file) ?? 0) + 1 / (RRF_K + v.rank + 1))
      const existing = hit.get(v.file)
      if (existing) existing.semantic = true
      else
        hit.set(v.file, {
          path: v.file,
          title: this.titleOf(v.file),
          snippet: v.text.replace(/\s+/g, ' ').trim().slice(0, 180),
          semantic: true
        })
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => hit.get(path) as SearchHit)
      .slice(0, 50)
  }

  stats(): { files: number; triples: number } {
    const files = (this.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n
    const triples = (this.db.prepare('SELECT COUNT(*) AS n FROM triples').get() as { n: number }).n
    return { files, triples }
  }

  close(): void {
    this.db.close()
  }
}
