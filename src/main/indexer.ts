import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import { harvest, frontmatterKind } from './harvest'
import { VectorStore, type PendingChunk } from './rag/store'
import { rrfRank } from './rag/rrf'
import { buildGraph, noteName, type FileRow, type TripleRow, type GraphRows } from './graph'
import type { Backlink, GraphData, Outbound, SearchHit } from '../shared/types'

/** Schema revision the one-time `files.kind` backfill is recorded under
 *  (`PRAGMA user_version`). Bump only if a future backfill needs to rerun. */
const KIND_BACKFILL_VERSION = 1

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
        mtime INTEGER,
        kind TEXT NOT NULL DEFAULT 'note'
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
    this.addKindColumn()
    this.backfillKinds()
  }

  /**
   * `files.kind` — what a note IS (`note` by default; `document` for a whole
   * converted book, `theme`, `concept`, …). Additive, so an index written by an
   * older build opens unchanged: the column is added once, guarded by a pragma
   * check rather than a try/catch, and every existing row starts as `note`.
   */
  private addKindColumn(): void {
    const cols = this.db.pragma('table_info(files)') as { name: string }[]
    if (cols.some((c) => c.name === 'kind')) return
    this.db.exec(`ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'`)
  }

  /**
   * One-time: give existing rows their `kind`.
   *
   * The vault-open scan is mtime-gated, so a file that hasn't changed since the
   * column was added is never re-parsed and would keep `kind = 'note'` forever.
   * The index already holds every note's text (FTS body), so the kinds can be
   * read back from there — cheaply, because only rows that open a frontmatter
   * block and mention `kind:` are fetched. The `%` between the two covers a
   * file saved with CRLF line endings (`---\r\nkind:`), which a literal
   * `'---\nkind: %'` prefilter would silently skip; `frontmatterKind` below is
   * what actually decides. `user_version` marks it done, so this costs one scan
   * per vault, ever.
   */
  private backfillKinds(): void {
    if ((this.db.pragma('user_version', { simple: true }) as number) >= KIND_BACKFILL_VERSION) return
    const rows = this.db
      .prepare(`SELECT rowid AS id, body FROM notes_fts WHERE body LIKE ?`)
      .all('---%kind: %') as { id: number; body: string }[]
    const set = this.db.prepare('UPDATE files SET kind = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const r of rows) {
        const kind = frontmatterKind(r.body)
        if (kind !== 'note') set.run(kind, r.id)
      }
      this.db.pragma(`user_version = ${KIND_BACKFILL_VERSION}`)
    })()
  }

  /** Re-parse one file and replace all of its rows (FTS + triples). */
  indexFile(path: string, content: string, mtime = 0): void {
    const { title, text, triples, kind } = harvest(path, content)
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO files (path, title, mtime, kind) VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET title = excluded.title, mtime = excluded.mtime,
             kind = excluded.kind`
        )
        .run(path, title, mtime, kind)
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

  /** The raw {files, triples} this index contributes to a graph. Saved `.map.md`
   *  views are *views*, not knowledge, so they're excluded (see
   *  docs/state-and-scopes.md). Exposed so an overlay can compose this index with
   *  another source. */
  graphRows(): GraphRows {
    const files = this.db
      .prepare("SELECT path, title, kind FROM files WHERE path NOT LIKE '%.map.md'")
      .all() as FileRow[]
    const triples = this.db
      .prepare(
        "SELECT subject, relation, object, source_file FROM triples WHERE source_file NOT LIKE '%.map.md'"
      )
      .all() as TripleRow[]
    return { files, triples }
  }

  /** A slice of the knowledge graph: local depth-`d` around a focus note (by
   *  path), or the whole graph (focusPath null) capped to the busiest nodes. */
  graph(
    focusPath: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ): GraphData {
    const { files, triples } = this.graphRows()
    return buildGraph(files, triples, focusPath, opts)
  }

  /** path → stored mtime for every indexed file. The vault-open scan uses it
   *  to skip re-parsing files whose on-disk mtime is unchanged (and to drop
   *  rows of files deleted while the app was closed). An mtime of 0 means
   *  "unknown" (some writers index before a stat) and never matches. */
  knownFiles(): Map<string, number> {
    const rows = this.db.prepare('SELECT path, mtime FROM files').all() as {
      path: string
      mtime: number | null
    }[]
    return new Map(rows.map((r) => [r.path, r.mtime ?? 0]))
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
    if (!this.vec) this.vec = new VectorStore(this.db, () => this.documentPaths())
  }

  /** Notes that are whole converted books (`kind: document`). They stay
   *  searchable, but the semantic layer leaves them out of "related" and
   *  colour-by-meaning — see `VectorStore`'s constructor. */
  private documentPaths(): Set<string> {
    const rows = this.db.prepare("SELECT path FROM files WHERE kind = 'document'").all() as {
      path: string
    }[]
    return new Set(rows.map((r) => r.path))
  }

  get talkOn(): boolean {
    return !!this.vec
  }

  /** True once the embedding width is known (the vec table exists). */
  get talkReady(): boolean {
    return !!this.vec?.ready
  }

  /** Set the embedding dimensionality (+ model id, when known) reported by the
   *  loaded model. A model change is gated exactly like a dims change — see
   *  `VectorStore.setDims` / `needsEmbeddingReset`. */
  setEmbedDims(dims: number, modelId?: string): void {
    this.vec?.setDims(dims, modelId)
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

  /** Notes semantically similar to the focus note (for the map's "related" overlay).
   *  `minScore` drops weak matches so sparse vaults don't flag everything. */
  talkNeighbors(
    focusPath: string,
    k = 5,
    minScore = 0
  ): { path: string; name: string; score: number }[] {
    return (this.vec?.neighbors(focusPath, k, minScore) ?? []).map((n) => ({
      path: n.file,
      name: noteName(n.file),
      score: n.score
    }))
  }

  /** Semantic kNN edges (by note *path*, matching the map's node ids) among
   *  `paths`, for "colour by meaning". `minScore` drops weak pairs (see
   *  `talkNeighbors`). */
  talkSemanticEdges(paths: string[], k = 4, minScore = 0): { source: string; target: string }[] {
    return (this.vec?.semanticEdges(paths, k, minScore) ?? []).map((e) => ({
      source: e.source,
      target: e.target
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

    // Build per-file hits (vector-only files get a synthetic snippet + ✨ flag);
    // order by fusing the keyword and vector rankings (RRF).
    const hit = new Map<string, SearchHit>()
    for (const h of fts) hit.set(h.path, h)
    for (const v of vec) {
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
    return rrfRank([fts.map((h) => h.path), vec.map((v) => v.file)])
      .map((path) => hit.get(path) as SearchHit)
      .slice(0, 50)
  }

  /** Top chunks (with their text) for grounding an "Ask" answer. Hybrid like the
   *  search box: fuse vector (meaning) with chunk-level FTS (exact terms the
   *  embeddings miss) via RRF, keyed by chunk id; returns full chunk text. */
  talkRetrieve(
    query: string,
    queryVec: Float32Array | null,
    k = 8
  ): { file: string; text: string }[] {
    if (!this.vec) return []
    const vec = queryVec ? this.vec.vectorHits(queryVec, k) : []
    const fts = this.vec.chunkSearch(query, k)
    if (vec.length === 0 && fts.length === 0) return []
    const byId = new Map<number, { file: string; text: string }>()
    for (const h of [...vec, ...fts]) if (!byId.has(h.id)) byId.set(h.id, { file: h.file, text: h.text })
    return rrfRank([vec.map((v) => String(v.id)), fts.map((f) => String(f.id))])
      .slice(0, k)
      .map((id) => byId.get(Number(id)) as { file: string; text: string })
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
