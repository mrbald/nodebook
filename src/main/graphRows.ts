import type Database from 'better-sqlite3'
import type { GraphRows } from './graph'

/** Saved `.map.md` views describe a projection, not its knowledge rows. */
export function readGraphRows(db: Database.Database): GraphRows {
  const files = db.prepare("SELECT path, title, kind FROM files WHERE path NOT LIKE '%.map.md'")
    .all() as GraphRows['files']
  const triples = db.prepare(
    "SELECT subject, relation, object, source_file FROM triples WHERE source_file NOT LIKE '%.map.md'"
  ).all() as GraphRows['triples']
  return { files, triples }
}
