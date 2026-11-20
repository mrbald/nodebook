import { noteGist } from '../shared/markdown/noteGist'
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import { randomUUID } from 'crypto'
import { getLoadablePath } from 'sqlite-vec'
import { targetResolver } from '../shared/markdown/resolveTarget'
import { harvest, frontmatterKind } from './harvest'
import { VectorStore, dropTalkTables, ftsMatch, sqliteExtensionPath, type PendingChunk } from './rag/store'
import { chunkMarkdown, type Chunk } from './rag/chunk'
import { rrfRank } from './rag/rrf'
import {
  buildGraph,
  noteName,
  sameAsTwins,
  SAME_AS,
  type TripleRow,
  type GraphRows
} from './graph'
import type { Backlink, GraphData, Outbound, SameAsTwin, SearchHit, VaultThemesData } from '../shared/types'
import { readGraphRows } from './graphRows'
import type { VaultThemesWork } from './vaultThemes.worker'

/** Schema revision the one-time `files.kind` backfill is recorded under
 *  (`PRAGMA user_version`). Bump only if a future backfill needs to rerun. */
const KIND_BACKFILL_VERSION = 1

export interface RetrievedPassage extends Chunk {
  file: string
}

async function runVaultThemes(work: VaultThemesWork, signal: AbortSignal): Promise<VaultThemesData | null> {
  const { default: makeVaultThemesWorker } = await import('./vaultThemes.worker?nodeWorker')
  if (signal.aborted) return null
  return new Promise((resolve, reject) => {
    const worker = makeVaultThemesWorker({ workerData: work })
    const abort = (): void => {
      resolve(null)
      void worker.terminate()
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (data: VaultThemesData) => resolve(data))
    worker.once('error', reject)
    worker.once('exit', (code) => {
      signal.removeEventListener('abort', abort)
      reject(new Error(`Themes worker exited without a result (${code}).`))
    })
  })
}

/**
 * The per-vault index: FTS5 full text + a triple store, in a single SQLite DB
 * under `<vault>/.nodebook/` (gitignored — it is rebuildable and must never
 * become a second source of truth). Re-indexing a file is delete-then-insert
 * in one transaction, so it is idempotent no matter how often it fires.
 */
export class VaultIndex {
  readonly id = randomUUID()
  private incoming: Map<string, Backlink[]> | null = null
  private themesRevision = 0
  private themesVectorRevision = 0
  private themesCache: {
    model: string | null
    revision: number
    vectorRevision: number
    data: VaultThemesData
  } | null = null
  private db: Database.Database
  /** Vector/semantic layer — null until "talk to docs" is enabled. */
  private vec: VectorStore | null = null

  constructor(private dbPath: string) {
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
    // Earlier builds dropped chunks but left a copy of the text in chunk FTS.
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'chunks'").get())
      this.db.exec('DROP TABLE IF EXISTS chunks_fts')
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
      this.vec?.chunkFile(path, content)
    })()
    this.incoming = null
    this.themesRevision++
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
      this.vec?.removeFile(path)
    })()
    this.incoming = null
    this.themesRevision++
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

  /** Resolve incoming links by their source folder, exactly as the editor does. */
  backlinksToFile(path: string): Backlink[] {
    if (!this.incoming) {
      const files = this.db.prepare('SELECT path FROM files').all() as { path: string }[]
      const resolve = targetResolver(files.map((file) => file.path))
      const links = this.db.prepare(
        'SELECT source_file, relation, object FROM triples ORDER BY source_file, relation'
      ).iterate() as Iterable<Pick<TripleRow, 'source_file' | 'relation' | 'object'>>
      const incoming = new Map<string, Backlink[]>()
      for (const { source_file, relation, object } of links) {
        const target = resolve(object, source_file).id
        if (source_file === target || target.startsWith('ghost:')) continue
        const rows = incoming.get(target)
        const last = rows?.at(-1)
        if (last?.source_file === source_file && last.relation === relation) continue
        const link = { source_file, relation }
        if (rows) rows.push(link)
        else incoming.set(target, [link])
      }
      this.incoming = incoming
    }
    return this.incoming.get(path) ?? []
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
    const fts = ftsMatch(query, 'AND')
    if (!fts) return []
    return this.db
      .prepare(
        `SELECT f.path AS path, f.title AS title,
                snippet(notes_fts, 1, '<mark>', '</mark>', '…', 10) AS snippet
         FROM notes_fts JOIN files f ON f.id = notes_fts.rowid
         WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50`
      )
      .all(fts) as SearchHit[]
  }

  figureSourceCandidates(query: string): string[] {
    const match = ftsMatch(query, 'AND')
    if (!match) return []
    const rows = this.db.prepare(
      `SELECT f.path FROM notes_fts JOIN files f ON f.id = notes_fts.rowid
       WHERE notes_fts MATCH ? AND f.kind = 'document' ORDER BY rank LIMIT 30`
    ).all(match) as { path: string }[]
    return rows.map((row) => row.path)
  }

  /** Read the opening prose of an indexed note without sending a whole book to the map. */
  notePreview(path: string): string {
    const row = this.db.prepare(
      'SELECT substr(body, 1, 12000) AS text FROM notes_fts JOIN files ON files.id = notes_fts.rowid WHERE files.path = ?'
    ).get(path) as { text: string } | undefined
    if (!row) return ''
    const { summary, quotes } = noteGist(row.text, 220)
    return summary || quotes[0] || ''
  }

  /** Keep the indexed body and triples on the same revision for evidence checks. */
  indexedNoteText(path: string): string | undefined {
    return (this.db.prepare(
      'SELECT body FROM notes_fts JOIN files ON files.id = notes_fts.rowid WHERE files.path = ?'
    ).get(path) as { body: string } | undefined)?.body
  }

  /** File keys and all recorded relation sources, including orphaned rows. */
  indexedPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files UNION SELECT source_file FROM triples').all() as {
      path: string
    }[]
    return rows.map(({ path }) => path)
  }

  /** The raw {files, triples} this index contributes to a graph. Saved `.map.md`
   *  views are *views*, not knowledge, so they're excluded (see
   *  docs/state-and-scopes.md). Exposed so an overlay can compose this index with
   *  another source. */
  graphRows(): GraphRows {
    return readGraphRows(this.db)
  }

  /** The notes a confirmed `same_as::` has made one thing with `path` — the
   *  same group the map folds into one dot, minus the note itself. Only the
   *  `same_as` triples are read, not the whole store. */
  sameAs(path: string): SameAsTwin[] {
    const paths = (
      this.db
        .prepare("SELECT path FROM files WHERE path NOT LIKE '%.map.md'")
        .all() as { path: string }[]
    ).map((r) => r.path)
    const triples = this.db
      .prepare(
        `SELECT subject, relation, object, source_file FROM triples
         WHERE relation = ? AND source_file NOT LIKE '%.map.md'`
      )
      .all(SAME_AS) as TripleRow[]
    return sameAsTwins(triples, paths, path).map((p) => ({ path: p, name: noteName(p) }))
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

  /** Theme snapshots are read and grouped off the main thread. Retry a worker
   * that raced an index edit or vector-space change. Partial embedding progress
   * can be returned without caching it under a newer revision. */
  async vaultThemes(root: string, model: string | null, signal: AbortSignal): Promise<VaultThemesData | null> {
    while (!signal.aborted) {
      const revision = this.themesRevision
      const current = model && this.vec?.matchesModel(model) ? model : null
      const vectorRevision = current ? this.themesVectorRevision : 0
      const cached = this.themesCache
      if (cached?.model === current && cached.revision === revision && cached.vectorRevision === vectorRevision) {
        return cached.data
      }
      const semantic = current ? { model: current, extension: sqliteExtensionPath(getLoadablePath(), process.resourcesPath) } : null
      const data = await runVaultThemes({ dbPath: this.dbPath, root, semantic }, signal)
      if (!data || signal.aborted) return null
      if (revision !== this.themesRevision) continue
      if (!current || vectorRevision === this.themesVectorRevision) {
        this.themesCache = { model: current, revision, vectorRevision, data }
      }
      return data
    }
    return null
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

  get talkGeneration(): string | null {
    return this.vec?.generation ?? null
  }

  talkGenerationFor(model: string): string | null {
    return this.vec?.matchesModel(model) ? this.vec.generation : null
  }

  /** Set the embedding dimensionality (+ model id, when known) reported by the
   *  loaded model. A model change is gated exactly like a dims change — see
   *  `VectorStore.setDims` / `needsEmbeddingReset`. */
  setEmbedDims(dims: number, modelId?: string): void {
    const previous = this.vec?.generation
    this.vec?.setDims(dims, modelId)
    if (previous !== this.vec?.generation) this.themesRevision++
  }

  /** Rebuild chunks from the note revision already committed to this index. */
  chunkIndexedFile(path: string): void {
    if (!this.vec || this.vec.hasChunks(path)) return
    const row = this.db.prepare(
      'SELECT body FROM files JOIN notes_fts ON notes_fts.rowid = files.id WHERE path = ?'
    ).get(path) as { body: string } | undefined
    if (row) this.vec.chunkFile(path, row.body)
  }

  /** Has this file already been chunked? (skip re-reading from disk on enable). */
  isChunked(path: string): boolean {
    return this.vec?.hasChunks(path) ?? false
  }

  talkPending(generation: string, limit?: number): PendingChunk[] {
    if (!this.vec?.ready || generation !== this.vec.generation) return []
    return this.vec.pending(limit)
  }

  talkCounts(): { total: number; pending: number } {
    return this.vec?.counts() ?? { total: 0, pending: 0 }
  }

  putEmbeddings(generation: string, rows: { id: number; vector: Float32Array }[]): boolean {
    if (this.vec?.ready && generation === this.vec.generation) {
      if (this.vec.putEmbeddings(rows)) {
        this.themesVectorRevision++
        return true
      }
    }
    return false
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

  /** Every note's centroid vector by path (see `VectorStore.noteVectors`);
   *  empty when talk is off. */
  talkNoteVectors(): ReadonlyMap<string, Float32Array> {
    return this.vec?.noteVectors() ?? new Map()
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
    if (this.vec) {
      dropTalkTables(this.db)
      this.themesRevision++
    }
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

  /** Top source passages for Ask. Keyword grounding also works without Talk. */
  talkRetrieve(
    query: string,
    queryVec: Float32Array | null,
    k = 8
  ): RetrievedPassage[] {
    if (!this.vec) return this.keywordPassages(query, k)
    const vec = queryVec ? this.vec.vectorHits(queryVec, k) : []
    const fts = this.vec.chunkSearch(query, k)
    if (vec.length === 0 && fts.length === 0) return this.keywordPassages(query, k)
    const byId = new Map([...vec, ...fts].map((h) => [String(h.id), h]))
    return rrfRank([vec.map((v) => String(v.id)), fts.map((f) => String(f.id))])
      .slice(0, k)
      .map((id) => {
        const { file, heading, start, end, text } = byId.get(id)!
        // Index text includes the heading prefix. The citation uses the exact
        // Markdown span rather than the synthetic text passed to the embedder.
        return { file, heading, start, end, text: text.slice(heading ? heading.length + 2 : 0) }
      })
  }

  private keywordPassages(query: string, k: number): RetrievedPassage[] {
    const match = ftsMatch(query, 'OR')
    if (!match) return []
    const open = `[${randomUUID()}]`
    const close = `[/${open.slice(1)}`
    const rows = this.db.prepare(
      `SELECT f.path AS file, body, highlight(notes_fts, 1, ?, ?) AS marked
       FROM notes_fts JOIN files f ON f.id = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY rank, f.path LIMIT ?`
    ).all(open, close, match, k) as { file: string; body: string; marked: string }[]
    const passages: RetrievedPassage[] = []
    for (const row of rows) {
      // Recover offsets from FTS's own token matches. A title-only match can
      // still supply the first nonempty body passage.
      const offsets: number[] = []
      let removed = 0
      let at = row.marked.indexOf(open)
      while (at !== -1) {
        const end = row.marked.indexOf(close, at + open.length)
        if (end === -1) break
        offsets.push(at - removed)
        removed += open.length + close.length
        at = row.marked.indexOf(open, end + close.length)
      }
      let best: Chunk | undefined
      let bestScore = -1
      let first = 0
      let last = 0
      for (const chunk of chunkMarkdown(row.body)) {
        while (first < offsets.length && offsets[first] < chunk.start) first++
        last = Math.max(first, last)
        while (last < offsets.length && offsets[last] < chunk.end) last++
        const score = last - first
        if (score > bestScore) {
          best = chunk
          bestScore = score
        }
      }
      if (best) passages.push({ file: row.file, ...best })
    }
    return passages
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
