import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { join, sep } from 'node:path'
import { getLoadablePath } from 'sqlite-vec'
import { chunkMarkdown, embedText } from './chunk'

/** SQLite opens the extension directly through the OS, outside Electron's ASAR filesystem. */
export function sqliteExtensionPath(extension: string, resourcesPath?: string): string {
  if (!resourcesPath) return extension

  const archivePrefix = join(resourcesPath, 'app.asar') + sep
  if (!extension.startsWith(archivePrefix)) return extension

  return join(resourcesPath, 'app.asar.unpacked', extension.slice(archivePrefix.length))
}

/** sqlite-vec stores a `float[N]` vector as a BLOB of N little-endian float32s. */
const f32ToBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

/**
 * Pure: rank `others` by cosine similarity to `focus` (a dot product, since the
 * centroids are L2-normalized), drop anything below `minScore`, and return the
 * top `k`. The threshold is what stops a sparse vault from reporting unrelated
 * notes as "related" just to fill the top-k. Exported for golden tests.
 */
export function topCosine(
  focus: Float32Array,
  others: { id: string; vec: Float32Array }[],
  k: number,
  minScore = 0
): { id: string; score: number }[] {
  const scored: { id: string; score: number }[] = []
  for (const o of others) {
    let dot = 0
    for (let i = 0; i < focus.length; i++) dot += focus[i] * o.vec[i]
    if (dot >= minScore) scored.push({ id: o.id, score: dot })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/** A chunk awaiting embedding. */
export interface PendingChunk {
  id: number
  text: string
}

/** A chunk hit (vector or keyword), in rank order. `id` is the chunk's stable id
 *  so vector and FTS hit lists can be RRF-fused by chunk. */
export interface VectorHit {
  id: number
  file: string
  heading: string
  start: number
  end: number
  text: string
}

/**
 * The vector/semantic layer over the *same* index DB — lazily constructed only
 * when "talk to docs" is enabled (loading the sqlite-vec extension is the heavy
 * part, so a vault with the feature off pays nothing). Chunks live in `chunks`;
 * their embeddings in a sqlite-vec `chunk_vec` table keyed by chunk id.
 *
 * Re-chunking is **content-hash gated**, so reopening a vault re-chunks (and
 * therefore re-embeds) only the notes that actually changed — embeddings persist
 * in `.nodebook/index.db` across restarts (still rebuildable; Discipline #3).
 */
/**
 * Pure: whether a (dims, modelId) change requires dropping stored vectors and
 * chunks — see `VectorStore.setDims`. A model swap is treated exactly like a
 * dims change even when the width matches (e.g. MiniLM → bge-small, both
 * 384-dim): two different models never share a vector space, so silently
 * keeping old vectors would corrupt retrieval. `next.modelId` undefined (a
 * caller that only knows dims) never triggers a reset by itself.
 *
 * The model id is the ONLY reset key. If anything else that shapes the vector
 * space ever changes for a model — its role prefixes (`rolePrefix`), pooling,
 * normalization — encode it into the model string written here (e.g.
 * `Xenova/bge-…#cls`): stored vectors made with the old convention won't be
 * distinguishable any other way. Exported for unit tests.
 */
export function needsEmbeddingReset(
  current: { dims: number; modelId: string },
  next: { dims: number; modelId?: string }
): boolean {
  return next.dims !== current.dims || (next.modelId !== undefined && next.modelId !== current.modelId)
}

/**
 * Pure: turn a free-text query into an FTS5 MATCH expression for `chunkSearch`
 * — each token prefix-matched and OR'd together (not FTS5's implicit AND), so
 * a natural-language question ("what is the capital of France") still matches
 * a chunk sharing only some of its terms; bm25 ranking still favors a chunk
 * matching more of them. Null for a query with no tokens. Exported for unit
 * tests.
 */
export function ftsMatch(query: string, operator: 'AND' | 'OR'): string | null {
  const tokens = query.match(/[\p{L}\p{N}\p{M}]+/gu)
  if (!tokens?.length) return null
  return tokens.map((t) => `"${t}"*`).join(` ${operator} `)
}

export function dropTalkTables(db: Database.Database): void {
  db.transaction(() => db.exec(`
    DROP TABLE IF EXISTS chunk_vec;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS chunk_file;
    DROP TABLE IF EXISTS talk_meta;
  `))()
}

export class VectorStore {
  private dims = 0
  private modelId = ''
  generation = randomUUID()
  // Note-centroid cache: computing centroids reads every stored embedding and
  // is O(all chunks × dims) on the main process — too hot to redo per map
  // recolor. Any write that can change an embedded chunk bumps `gen`, which
  // invalidates the cache lazily.
  private gen = 0
  private centroidCache: { gen: number; map: Map<string, Float32Array> } | null = null

  /**
   * `documentPaths` names the notes that are whole converted books
   * (`kind: document`). They are chunked and searchable — Ask must still find a
   * passage in them — but they are left OUT of the per-note centroids, so a
   * book never shows up as "related" to everything or colours the map by its
   * own average meaning. The owning index supplies it lazily, so a document
   * merged after the store opened is excluded from the next centroid rebuild.
   */
  constructor(
    private db: Database.Database,
    private documentPaths: () => Set<string> = () => new Set()
  ) {
    this.db.loadExtension(sqliteExtensionPath(getLoadablePath(), process.resourcesPath))
    const old = this.db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'chunks'`).get() as
      | { sql: string }
      | undefined
    // Prior caches reused deleted chunk IDs and may already contain a vector
    // for the wrong text. Rebuild from Markdown once, with monotonic IDs.
    if (old && !old.sql.includes('AUTOINCREMENT')) dropTalkTables(this.db)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        heading TEXT,
        start INTEGER,
        "end" INTEGER,
        text TEXT NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
      CREATE INDEX IF NOT EXISTS idx_chunks_pending ON chunks(embedded);
      CREATE TABLE IF NOT EXISTS chunk_file (file TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS talk_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text);
    `)
    // Backfill the chunk FTS index for vaults chunked before it existed (it's
    // keyword-only, independent of embeddings, so no re-embed is needed).
    const ftsEmpty =
      (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts`).get() as { n: number }).n === 0
    const hasChunks =
      (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n > 0
    if (ftsEmpty && hasChunks) {
      this.db.exec(`INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks`)
    }
    const row = this.db.prepare(`SELECT v FROM talk_meta WHERE k = 'dims'`).get() as
      | { v: string }
      | undefined
    if (row) {
      this.dims = Number(row.v)
      const modelRow = this.db.prepare(`SELECT v FROM talk_meta WHERE k = 'model'`).get() as
        | { v: string }
        | undefined
      this.modelId = modelRow?.v ?? ''
      this.ensureVecTable(this.dims)
    }
  }

  private ensureVecTable(dims: number): void {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${dims}])`)
  }

  /** True once the embedding width is known and the vec table exists. */
  get ready(): boolean {
    return this.dims > 0
  }

  matchesModel(model: string): boolean {
    return this.ready && model === this.modelId
  }

  /**
   * Set the embedding width + model id (from the loaded model). If either
   * changed, drops the stored vectors AND the chunks (with their content-hash
   * gate), so the vault is re-chunked and re-embedded from scratch — a model
   * swap is treated exactly like a dims change even when the new model happens
   * to share the old one's width (e.g. MiniLM → bge-small, both 384-dim),
   * since two same-dim models don't share a vector space. Chunks go too, not
   * just vectors: chunking policy evolves with the model (token windows, CJK
   * budgets), and a swap is the natural moment to rebuild them — re-chunking
   * is cheap next to re-embedding, and keeping stale chunks would silently pin
   * old policy until a note happens to be edited. The caller (talk:enable)
   * re-chunks right after via chunkUnchunkedFiles. Known trade-off: chunk-level
   * keyword search (chunks_fts, the FTS leg of talk search/ask) is empty for
   * the seconds re-chunking takes — note-level search is unaffected, and the
   * vector leg is down anyway until re-embedding. `modelId` is optional so
   * existing call sites that only know dims keep working; omitting it never
   * triggers a reset by itself.
   */
  setDims(dims: number, modelId?: string): void {
    if (!needsEmbeddingReset({ dims: this.dims, modelId: this.modelId }, { dims, modelId })) {
      this.ensureVecTable(dims)
      return
    }
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS chunk_vec`)
      this.db
        .prepare(`INSERT INTO talk_meta(k, v) VALUES('dims', ?)
                  ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
        .run(String(dims))
      if (modelId !== undefined) {
        this.db
          .prepare(`INSERT INTO talk_meta(k, v) VALUES('model', ?)
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
          .run(modelId)
      }
      this.ensureVecTable(dims)
      this.db.exec(`DELETE FROM chunks; DELETE FROM chunk_file; DELETE FROM chunks_fts;`)
    })()
    this.dims = dims
    this.modelId = modelId ?? this.modelId
    this.generation = randomUUID()
    this.gen++
  }

  /** True if `file` already has chunks (lets the caller skip re-reading on enable). */
  hasChunks(file: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM chunk_file WHERE file = ? LIMIT 1`).get(file)
  }

  /** Replace a file's chunks iff its content changed (hash-gated). New chunks are
   *  marked unembedded. Returns whether it actually re-chunked. */
  chunkFile(file: string, content: string): boolean {
    const hash = createHash('sha1').update(content).digest('hex')
    const prev = this.db.prepare(`SELECT hash FROM chunk_file WHERE file = ?`).get(file) as
      | { hash: string }
      | undefined
    if (prev?.hash === hash) return false
    this.gen++ // re-chunking drops this file's embedded rows
    const chunks = chunkMarkdown(content)
    this.db.transaction(() => {
      this.deleteFileRows(file)
      const ins = this.db.prepare(
        `INSERT INTO chunks(file, heading, start, "end", text, embedded) VALUES (?, ?, ?, ?, ?, 0)`
      )
      const insFts = this.db.prepare(`INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)`)
      for (const c of chunks) {
        const text = embedText(c)
        const info = ins.run(file, c.heading, c.start, c.end, text)
        insFts.run(info.lastInsertRowid, text)
      }
      this.db
        .prepare(`INSERT INTO chunk_file(file, hash) VALUES(?, ?)
                  ON CONFLICT(file) DO UPDATE SET hash = excluded.hash`)
        .run(file, hash)
    })()
    return true
  }

  removeFile(file: string): void {
    this.gen++
    this.db.transaction(() => {
      this.deleteFileRows(file)
      this.db.prepare(`DELETE FROM chunk_file WHERE file = ?`).run(file)
    })()
  }

  private deleteFileRows(file: string): void {
    const ids = this.db.prepare(`SELECT id FROM chunks WHERE file = ?`).all(file) as {
      id: number
    }[]
    const delFts = this.db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`)
    const delVec = this.dims > 0 ? this.db.prepare(`DELETE FROM chunk_vec WHERE rowid = ?`) : null
    for (const r of ids) {
      delFts.run(r.id)
      delVec?.run(BigInt(r.id))
    }
    this.db.prepare(`DELETE FROM chunks WHERE file = ?`).run(file)
  }

  /** A batch of chunks still awaiting an embedding. */
  pending(limit = 32): PendingChunk[] {
    return this.db
      .prepare(`SELECT id, text FROM chunks WHERE embedded = 0 LIMIT ?`)
      .all(limit) as PendingChunk[]
  }

  counts(): { total: number; pending: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n
    const pending = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0`).get() as { n: number }
    ).n
    return { total, pending }
  }

  /** Store vectors for freshly-embedded chunks and mark them embedded. */
  putEmbeddings(rows: { id: number; vector: Float32Array }[]): void {
    if (!this.dims) throw new Error('embedding dims not set')
    if (rows.length > 0) this.gen++
    this.db.transaction(() => {
      const insVec = this.db.prepare(`INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)`)
      const mark = this.db.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ? AND embedded = 0`)
      for (const r of rows) {
        if (!mark.run(r.id).changes) continue
        if (r.vector.length !== this.dims || !r.vector.every(Number.isFinite))
          throw new Error('Invalid chunk embedding.')
        insVec.run(BigInt(r.id), f32ToBlob(r.vector))
      }
    })()
  }

  /** Per-note centroid vectors (mean of a note's chunk embeddings), L2-normalized
   *  so a dot product is cosine similarity. Cached until an embedding-changing
   *  write bumps `gen` (see the field comment). */
  private centroids(): Map<string, Float32Array> {
    if (this.centroidCache && this.centroidCache.gen === this.gen) return this.centroidCache.map
    const map = new Map<string, Float32Array>()
    this.centroidCache = { gen: this.gen, map }
    if (!this.dims) return map
    const documents = this.documentPaths()
    const rows = this.db
      .prepare(
        `SELECT c.file AS file, v.embedding AS emb
         FROM chunks c JOIN chunk_vec v ON v.rowid = c.id WHERE c.embedded = 1`
      )
      .all() as { file: string; emb: Buffer }[]
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (documents.has(r.file)) continue
      const vec = new Float32Array(
        r.emb.buffer.slice(r.emb.byteOffset, r.emb.byteOffset + this.dims * 4)
      )
      let s = map.get(r.file)
      if (!s) {
        s = new Float32Array(this.dims)
        map.set(r.file, s)
      }
      for (let i = 0; i < this.dims; i++) s[i] += vec[i]
      counts.set(r.file, (counts.get(r.file) ?? 0) + 1)
    }
    for (const [file, s] of map) {
      const c = counts.get(file) || 1
      let norm = 0
      for (let i = 0; i < this.dims; i++) {
        s[i] /= c
        norm += s[i] * s[i]
      }
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < this.dims; i++) s[i] /= norm
    }
    return map
  }

  /** Every note's centroid vector, keyed by path (documents excluded), for a
   *  caller that brings its own vectors to compare — distill's merge plan
   *  looks for a vault note that means the same as a staged one. Read-only:
   *  the map is the cache itself. */
  noteVectors(): ReadonlyMap<string, Float32Array> {
    return this.centroids()
  }

  /** The k notes most semantically similar to `focusFile` (cosine over centroids).
   *  `minScore` drops pairs below that cosine, so a sparse vault doesn't flag
   *  unrelated notes as "related" just to fill the top-k. */
  neighbors(focusFile: string, k: number, minScore = 0): { file: string; score: number }[] {
    const cents = this.centroids()
    const f = cents.get(focusFile)
    if (!f) return []
    const others = [...cents]
      .filter(([file]) => file !== focusFile)
      .map(([file, vec]) => ({ id: file, vec }))
    return topCosine(f, others, k, minScore).map((r) => ({ file: r.id, score: r.score }))
  }

  /** Semantic kNN edges among the given notes (each → its k nearest by centroid
   *  cosine), for colouring the map by meaning. `minScore` drops weak pairs (see
   *  `neighbors`), so sparse vaults aren't fully connected by noise. */
  semanticEdges(files: string[], k: number, minScore = 0): { source: string; target: string }[] {
    const cents = this.centroids()
    const present = files.filter((f) => cents.has(f))
    const edges: { source: string; target: string }[] = []
    for (const f of present) {
      const fv = cents.get(f) as Float32Array
      const others = present
        .filter((g) => g !== f)
        .map((g) => ({ id: g, vec: cents.get(g) as Float32Array }))
      for (const s of topCosine(fv, others, k, minScore)) edges.push({ source: f, target: s.id })
    }
    return edges
  }

  /** k-NN over chunk embeddings → best chunks, in distance order. */
  vectorHits(queryVec: Float32Array, k = 30): VectorHit[] {
    if (!this.dims || queryVec.length !== this.dims || !queryVec.every(Number.isFinite)) return []
    const rows = this.db
      .prepare(
        `WITH knn AS (
           SELECT rowid, distance FROM chunk_vec
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?
         )
         SELECT c.id, c.file, c.heading, c.start, c."end", c.text
         FROM knn JOIN chunks c ON c.id = knn.rowid
         ORDER BY knn.distance`
      )
      .all(f32ToBlob(queryVec), k) as VectorHit[]
    return rows
  }

  /** Chunk-level keyword (FTS5) hits for a query — same shape as `vectorHits`, so
   *  the two can be RRF-fused for grounding. Catches exact names/terms/IDs that
   *  embeddings miss. Tokens are OR'd (not FTS5's implicit AND): a natural-
   *  language question ("what is the capital of France") has plenty of tokens
   *  that won't all appear in one chunk, so ANDing them usually matches nothing
   *  and this leg quietly drops out of the hybrid fusion. OR still ranks by
   *  bm25, so a chunk matching more of the question's terms still ranks higher. */
  chunkSearch(query: string, k = 30): VectorHit[] {
    const match = ftsMatch(query, 'OR')
    if (!match) return []
    const rows = this.db
      .prepare(
        `SELECT c.id, c.file, c.heading, c.start, c."end", c.text
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(match, k) as VectorHit[]
    return rows
  }
}
