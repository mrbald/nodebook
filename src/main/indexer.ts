import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import { harvest } from './harvest'
import type { Backlink, SearchHit } from '../shared/types'

/**
 * The per-vault index: FTS5 full text + a triple store, in a single SQLite DB
 * under `<vault>/.nodebook/` (gitignored — it is rebuildable and must never
 * become a second source of truth). Re-indexing a file is delete-then-insert
 * in one transaction, so it is idempotent no matter how often it fires.
 */
export class VaultIndex {
  private db: Database.Database

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

  /** Distinct note base-names (no extension) currently in the index, sorted. */
  noteNames(): string[] {
    const rows = this.db.prepare('SELECT path FROM files').all() as { path: string }[]
    const names = new Set(rows.map((r) => basename(r.path).replace(/\.md$/i, '')))
    return [...names].sort((a, b) => a.localeCompare(b))
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
