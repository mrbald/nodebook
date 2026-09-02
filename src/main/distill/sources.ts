/**
 * The source store: one copy of each converted document, addressed by content.
 *
 * Before this, a source was a basename. The original path was dropped the
 * moment the file was picked, every run kept its own copy of the converted
 * text, and two runs of the same book had no way to know they were about the
 * same book. So the book note could be written into the vault twice, "open the
 * original" was impossible, and re-running a document paid the whole conversion
 * again.
 *
 * A source is now a first-class object with an identity: `sha1` of its
 * converted text.
 *
 *  - `<vault>/.distill/sources/<sha1>.md` — the converted text, once.
 *  - `<vault>/.distill/sources.json` — hash → where it came from, what it is
 *    called, and the size + mtime of the original at conversion time.
 *
 * That last pair is also the conversion cache: the same file, unchanged on
 * disk, converts once and every later run reuses the stored text. The cache is
 * only ever an optimisation — a missing or unreadable store means "convert it
 * again", never an error.
 *
 * Filesystem only, no database, no Electron: unit-tested in a temp dir.
 */

import { mkdirSync, existsSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { basename, extname, join } from 'path'
import { atomicWrite, distillRoot } from './artifact'
import { DOC_EXT_RE, sourceTitle } from './emit'

/** A converted document's identity: sha1 of its text, lowercase hex. */
export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** What the store knows about one converted document. */
export interface SourceRecord {
  /** Absolute path of the file it was converted from. */
  originalPath: string
  /** Short human title — the note name the book is written under. */
  title: string
  /** Lowercase extension without the dot (`pdf`, `epub`, `md`). */
  format: string
  /** ISO timestamp of the conversion. */
  convertedAt: string
  /** Size in bytes of the ORIGINAL file when it was converted. */
  size: number
  /** mtime (ms) of the ORIGINAL file when it was converted. */
  mtime: number
}

/** A hash arriving from the renderer is untrusted; it is also a path segment. */
const HASH_RE = /^[0-9a-f]{40}$/

export function assertSourceHash(hash: string): void {
  if (!HASH_RE.test(hash)) throw new Error(`invalid source hash: ${JSON.stringify(hash)}`)
}

/** Where the converted texts live. */
export function sourcesDir(vaultRoot: string): string {
  return join(distillRoot(vaultRoot), 'sources')
}

/** One converted document's file. Throws on a hash that isn't one. */
export function sourceTextPath(vaultRoot: string, hash: string): string {
  assertSourceHash(hash)
  return join(sourcesDir(vaultRoot), `${hash}.md`)
}

function indexPath(vaultRoot: string): string {
  return join(distillRoot(vaultRoot), 'sources.json')
}

/** Is this parsed JSON value shaped like a record? Unknown fields are dropped:
 *  the file is on disk, so it is untrusted like any other input. */
function asRecord(value: unknown): SourceRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (typeof r.originalPath !== 'string' || typeof r.title !== 'string') return null
  return {
    originalPath: r.originalPath,
    title: r.title,
    format: typeof r.format === 'string' ? r.format : '',
    convertedAt: typeof r.convertedAt === 'string' ? r.convertedAt : '',
    size: typeof r.size === 'number' ? r.size : 0,
    mtime: typeof r.mtime === 'number' ? r.mtime : 0
  }
}

/** hash → record for every source the store knows. Empty when there is none. */
export function readSourceIndex(vaultRoot: string): Map<string, SourceRecord> {
  const out = new Map<string, SourceRecord>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(indexPath(vaultRoot), 'utf8'))
  } catch {
    return out
  }
  if (typeof raw !== 'object' || raw === null) return out
  for (const [hash, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!HASH_RE.test(hash)) continue
    const record = asRecord(value)
    if (record) out.set(hash, record)
  }
  return out
}

function writeSourceIndex(vaultRoot: string, index: Map<string, SourceRecord>): void {
  mkdirSync(distillRoot(vaultRoot), { recursive: true })
  const asObject: Record<string, SourceRecord> = {}
  for (const hash of [...index.keys()].sort()) asObject[hash] = index.get(hash) as SourceRecord
  atomicWrite(indexPath(vaultRoot), JSON.stringify(asObject, null, 2))
}

/** What the store knows about one document, or null. */
export function readSourceRecord(vaultRoot: string, hash: string): SourceRecord | null {
  if (!HASH_RE.test(hash)) return null
  return readSourceIndex(vaultRoot).get(hash) ?? null
}

/** The converted text behind a hash, or null when the store no longer has it. */
export function readSourceText(vaultRoot: string, hash: string): string | null {
  if (!HASH_RE.test(hash)) return null
  try {
    return readFileSync(sourceTextPath(vaultRoot, hash), 'utf8')
  } catch {
    return null
  }
}

/**
 * The original file a hash came from, but only if it is still openable.
 *
 * This is what "Open original" resolves: the renderer names the HASH and main
 * decides what path that is. The path itself comes from `sources.json` — a
 * plain file inside the vault, so it is the user's to edit and NOT a trusted
 * input. What makes this safe is the shape of what it may return, checked here
 * every time: the path must still exist, be a REGULAR file (not a device, not a
 * directory), and carry one of the extensions this app converts. Everything
 * else is `null` — "Open original" hands the OS a document or nothing.
 */
export function originalPathOf(vaultRoot: string, hash: string): string | null {
  const record = readSourceRecord(vaultRoot, hash)
  if (!record || !DOC_EXT_RE.test(record.originalPath)) return null
  try {
    return statSync(record.originalPath).isFile() ? record.originalPath : null
  } catch {
    return null
  }
}

/** A document in the store: its identity, its text, and where it came from. */
export interface StoredSource {
  hash: string
  text: string
  record: SourceRecord
  /** True when the text came from the store instead of being converted now. */
  cached: boolean
}

/** The original's size and mtime — the cache key, with its path. */
function statOf(path: string): { size: number; mtime: number } | null {
  try {
    const s = statSync(path)
    return { size: s.size, mtime: Math.floor(s.mtimeMs) }
  } catch {
    return null
  }
}

/**
 * Put a converted document in the store and return its identity.
 *
 * Content-addressed, so storing the same text twice is a no-op for the text
 * file; the record is rewritten either way, because the same bytes can be
 * reached from a new path (the user moved the file) and that is exactly what
 * "Open original" needs to know.
 */
export function putSource(vaultRoot: string, originalPath: string, text: string): StoredSource {
  const hash = sha1(text)
  const stat = statOf(originalPath)
  const record: SourceRecord = {
    originalPath,
    title: sourceTitle(basename(originalPath)),
    format: extname(originalPath).replace(/^\./, '').toLowerCase(),
    convertedAt: new Date().toISOString(),
    size: stat?.size ?? 0,
    mtime: stat?.mtime ?? 0
  }
  mkdirSync(sourcesDir(vaultRoot), { recursive: true })
  const file = sourceTextPath(vaultRoot, hash)
  if (!existsSync(file)) atomicWrite(file, text)
  const index = readSourceIndex(vaultRoot)
  index.set(hash, record)
  writeSourceIndex(vaultRoot, index)
  return { hash, text, record, cached: false }
}

/**
 * The stored conversion of a file that has not changed since — matched on
 * (path, size, mtime), the same triple the vault scan trusts to skip a
 * re-parse. Null when the file changed, was never converted, or the store no
 * longer holds its text. The newest matching record wins, so re-converting
 * with a better converter takes effect on the next run.
 */
export function cachedSource(vaultRoot: string, originalPath: string): StoredSource | null {
  const stat = statOf(originalPath)
  if (!stat) return null
  const matches = [...readSourceIndex(vaultRoot)]
    .filter(
      ([, r]) => r.originalPath === originalPath && r.size === stat.size && r.mtime === stat.mtime
    )
    .sort((a, b) => b[1].convertedAt.localeCompare(a[1].convertedAt))
  for (const [hash, record] of matches) {
    const text = readSourceText(vaultRoot, hash)
    if (text !== null) return { hash, text, record, cached: true }
  }
  return null
}

/**
 * Convert a document once: the stored text if the file is unchanged, otherwise
 * `convert` and store the result. `convert` is injected so this module stays
 * free of the format converters (and their lazy pdf.js / turndown imports).
 */
export async function convertSource(
  vaultRoot: string,
  originalPath: string,
  convert: (path: string) => Promise<string>
): Promise<StoredSource> {
  const cached = cachedSource(vaultRoot, originalPath)
  if (cached) return cached
  return putSource(vaultRoot, originalPath, await convert(originalPath))
}
