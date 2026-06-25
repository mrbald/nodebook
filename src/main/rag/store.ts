import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import * as sqliteVec from 'sqlite-vec'
import { chunkMarkdown, embedText } from './chunk'

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

/** A vector-search hit: the best-matching chunk of a file, in rank order. */
export interface VectorHit {
  file: string
  text: string
  rank: number
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
export class VectorStore {
  private dims = 0

  constructor(private db: Database.Database) {
    sqliteVec.load(this.db)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
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
    `)
    const row = this.db.prepare(`SELECT v FROM talk_meta WHERE k = 'dims'`).get() as
      | { v: string }
      | undefined
    if (row) {
      this.dims = Number(row.v)
      this.ensureVecTable()
    }
  }

  private ensureVecTable(): void {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${this.dims}])`)
  }

  /** True once the embedding width is known and the vec table exists. */
  get ready(): boolean {
    return this.dims > 0
  }

  /** Set the embedding width (from the loaded model). Recreates the vec table and
   *  resets all embeddings if the model's dimensionality changed. */
  setDims(dims: number): void {
    if (dims === this.dims) {
      this.ensureVecTable()
      return
    }
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS chunk_vec`)
      this.dims = dims
      this.db
        .prepare(`INSERT INTO talk_meta(k, v) VALUES('dims', ?)
                  ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
        .run(String(dims))
      this.ensureVecTable()
      this.db.exec(`UPDATE chunks SET embedded = 0`)
    })()
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
    const chunks = chunkMarkdown(content)
    this.db.transaction(() => {
      this.deleteFileRows(file)
      const ins = this.db.prepare(
        `INSERT INTO chunks(file, heading, start, "end", text, embedded) VALUES (?, ?, ?, ?, ?, 0)`
      )
      for (const c of chunks) ins.run(file, c.heading, c.start, c.end, embedText(c))
      this.db
        .prepare(`INSERT INTO chunk_file(file, hash) VALUES(?, ?)
                  ON CONFLICT(file) DO UPDATE SET hash = excluded.hash`)
        .run(file, hash)
    })()
    return true
  }

  removeFile(file: string): void {
    this.db.transaction(() => {
      this.deleteFileRows(file)
      this.db.prepare(`DELETE FROM chunk_file WHERE file = ?`).run(file)
    })()
  }

  private deleteFileRows(file: string): void {
    if (this.dims > 0) {
      const ids = this.db.prepare(`SELECT id FROM chunks WHERE file = ?`).all(file) as {
        id: number
      }[]
      const delVec = this.db.prepare(`DELETE FROM chunk_vec WHERE rowid = ?`)
      for (const r of ids) delVec.run(BigInt(r.id))
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
    this.db.transaction(() => {
      const del = this.db.prepare(`DELETE FROM chunk_vec WHERE rowid = ?`)
      const insVec = this.db.prepare(`INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)`)
      const mark = this.db.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ?`)
      for (const r of rows) {
        const rowid = BigInt(r.id)
        del.run(rowid)
        insVec.run(rowid, f32ToBlob(r.vector))
        mark.run(r.id)
      }
    })()
  }

  /** Per-note centroid vectors (mean of a note's chunk embeddings), L2-normalized
   *  so a dot product is cosine similarity. */
  private centroids(): Map<string, Float32Array> {
    const map = new Map<string, Float32Array>()
    if (!this.dims) return map
    const rows = this.db
      .prepare(
        `SELECT c.file AS file, v.embedding AS emb
         FROM chunks c JOIN chunk_vec v ON v.rowid = c.id WHERE c.embedded = 1`
      )
      .all() as { file: string; emb: Buffer }[]
    const counts = new Map<string, number>()
    for (const r of rows) {
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
    if (!this.dims) return []
    const rows = this.db
      .prepare(
        `WITH knn AS (
           SELECT rowid, distance FROM chunk_vec
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?
         )
         SELECT c.file AS file, c.text AS text, knn.distance AS distance
         FROM knn JOIN chunks c ON c.id = knn.rowid
         ORDER BY knn.distance`
      )
      .all(f32ToBlob(queryVec), k) as { file: string; text: string; distance: number }[]
    return rows.map((r, i) => ({ file: r.file, text: r.text, rank: i }))
  }
}
