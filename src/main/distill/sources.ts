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
 *  - `<vault>/.distill/sources/figures/<sha256>.<ext>` — validated raster bytes.
 *  - `<vault>/.distill/sources.json` — hash → where it came from, what it is
 *    called, the original's file revision, and where its figures occur.
 *
 * The file and converter revisions key the cache. Preparing a preview may read
 * a stored conversion. Only starting a run publishes its text and source record.
 *
 * Filesystem only, no database, no Electron: unit-tested in a temp dir.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'fs'
import { createHash } from 'crypto'
import { basename, extname, join } from 'path'
import { atomicWrite, distillRoot } from './artifact'
import { localDirectory, linkedFigurePaths, matchesFigure, readFigureFile, readFigureRefs, readFigureCoverage, readLocalFile, rememberWrittenFigure } from './figureFiles'
import { figurePath, parseFigurePath, type CapturedFigure, type FigureCoverage, type FigureRef } from '../../shared/figures'
import { readPdfExtraction, type PdfExtraction } from '../../shared/pdfExtraction'
import { supportsImportTextEncoding, type ConvertedDocument, type ConvertedTextEncoding } from './convert'
import { DOC_EXT_RE, sourceTitle } from './emit'

/** A converted document's identity: sha1 of its text, lowercase hex. */
export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** What the store knows about one converted document. */
export interface SourceRecord {
  pdf?: PdfExtraction
  figures?: FigureRef[]
  figureCoverage?: FigureCoverage
  externalImages?: true
  encoding?: ConvertedTextEncoding
  conversion?: string
  revision?: string
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
  const figures = readFigureRefs(r.figures)
  const figureCoverage = readFigureCoverage(r.figureCoverage)
  const figuresValid = r.figures === undefined || figures !== undefined
  return {
    pdf: readPdfExtraction(r.pdf),
    ...(figures?.length ? { figures } : {}),
    ...(figureCoverage ? { figureCoverage } : {}),
    ...(r.externalImages === true ? { externalImages: true } : {}),
    encoding: readTextEncoding(r.encoding),
    conversion: typeof r.conversion === 'string' && figuresValid ? r.conversion : undefined,
    revision: typeof r.revision === 'string' ? r.revision : undefined,
    originalPath: r.originalPath,
    title: r.title,
    format: typeof r.format === 'string' ? r.format : '',
    convertedAt: typeof r.convertedAt === 'string' ? r.convertedAt : '',
    size: typeof r.size === 'number' ? r.size : 0,
    mtime: typeof r.mtime === 'number' ? r.mtime : 0
  }
}

function readTextEncoding(value: unknown): ConvertedTextEncoding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { name, uncertain } = value as Record<string, unknown>
  if (typeof name === 'string' && typeof uncertain === 'boolean') return { name, uncertain }
  return undefined
}

/** hash → record for every source the store knows. Empty when there is none. */
export function readSourceIndex(vaultRoot: string): Map<string, SourceRecord> {
  const out = new Map<string, SourceRecord>()
  let raw: unknown
  try {
    const bytes = readLocalFile(vaultRoot, indexPath(vaultRoot))
    if (!bytes) return out
    raw = JSON.parse(bytes.toString('utf8'))
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
  if (!localDirectory(vaultRoot, distillRoot(vaultRoot), true)) throw new Error('Source store is unavailable.')
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
  return readLocalFile(vaultRoot, sourceTextPath(vaultRoot, hash))?.toString('utf8') ?? null
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

/** Converted text and its provenance, before or after publication. */
export interface PreparedSource {
  readonly hash: string
  readonly text: string
  readonly record: SourceRecord
  /** Fresh bytes are held in memory until approval. A cached source has blobs on disk. */
  readonly capturedFigures?: CapturedFigure[]
  /** True when the text came from the store instead of being converted now. */
  readonly cached: boolean
}

/** Identity captured from the file picker, before an opaque token is issued. */
export interface PickedSourceFile {
  path: string
  realPath: string
  device: bigint
  inode: bigint
}

export function bindPickedSource(path: string): PickedSourceFile | null {
  try {
    const realPath = realpathSync(path)
    const stat = statSync(realPath, { bigint: true })
    if (stat.isFile()) return { path, realPath, device: stat.dev, inode: stat.ino }
  } catch {
    // A file can disappear while the picker closes. Report it when preparing it.
  }
  return null
}

export function readPickedSource(picked: PickedSourceFile): Buffer {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  let fd: number
  try {
    fd = openSync(picked.realPath, flags)
  } catch (cause) {
    throw new Error('The picked document could not be opened. Pick it again.', { cause })
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.dev !== picked.device || stat.ino !== picked.inode) {
      throw new Error('The picked document was replaced. Pick it again.')
    }
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The original's size and mtime — the cache key, with its path. */
function statOf(
  path: string,
  picked?: PickedSourceFile
): { size: number; mtime: number; revision: string } | null {
  try {
    if (picked && realpathSync(path) !== picked.realPath) return null
    const s = statSync(path, { bigint: true })
    if (!s.isFile() || (picked && (s.dev !== picked.device || s.ino !== picked.inode))) return null
    return {
      size: Number(s.size),
      mtime: Number(s.mtimeNs / 1_000_000n),
      revision: [s.dev, s.ino, s.mtimeNs, s.ctimeNs].join(':')
    }
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
function makeSource(
  originalPath: string,
  text: string,
  pdf: PdfExtraction | undefined,
  stat: ReturnType<typeof statOf>,
  metadata: Pick<SourceRecord, 'encoding' | 'conversion' | 'figureCoverage' | 'externalImages'> = {},
  capturedFigures?: CapturedFigure[]
): PreparedSource {
  const hash = sha1(text)
  const figures = readFigureRefs(capturedFigures)
  if (capturedFigures && !figures) throw new Error('Invalid converted figure metadata.')
  const record: SourceRecord = {
    pdf,
    ...metadata,
    ...(figures?.length ? { figures } : {}),
    revision: stat?.revision,
    originalPath,
    title: sourceTitle(basename(originalPath)),
    format: extname(originalPath).replace(/^\./, '').toLowerCase(),
    convertedAt: new Date().toISOString(),
    size: stat?.size ?? 0,
    mtime: stat?.mtime ?? 0
  }
  return { hash, text, record, capturedFigures, cached: false }
}

export function publishSource(vaultRoot: string, source: PreparedSource): PreparedSource {
  const { hash, text, record } = source
  const dir = sourcesDir(vaultRoot)
  const links = linkedFigurePaths(text)
  const seen = new Set<string>()
  const pending = new Map<string, Uint8Array>()
  for (const [index, ref] of (record.figures ?? []).entries()) {
    const path = figurePath(ref)
    if (seen.has(path)) continue
    seen.add(path)
    const captured = source.capturedFigures?.[index]
    if (!links.has(path) || (captured && (!matchesFigure(captured.bytes, ref) || figurePath(captured) !== path))) {
      throw new Error(`Invalid converted figure: ${ref.label}`)
    }
    if (readFigureFile(vaultRoot, dir, ref)) continue
    if (!captured) throw new Error(`Saved figure is unavailable: ${ref.label}`)
    pending.set(path, captured.bytes)
  }
  if (!localDirectory(vaultRoot, dir, true) ||
      (pending.size && !localDirectory(vaultRoot, join(dir, 'figures'), true))) {
    throw new Error('Source store is unavailable.')
  }
  for (const [path, bytes] of pending) {
    atomicWrite(join(dir, path), Buffer.from(bytes))
    rememberWrittenFigure(vaultRoot, dir, parseFigurePath(path)!)
  }
  const file = sourceTextPath(vaultRoot, hash)
  if (!existsSync(file) || readSourceText(vaultRoot, hash) !== text) atomicWrite(file, text)
  const index = readSourceIndex(vaultRoot)
  const previous = index.get(hash)
  if (source.cached && JSON.stringify(previous) === JSON.stringify(record)) return source
  index.set(hash, record)
  writeSourceIndex(vaultRoot, index)
  return source
}

export function putSource(
  vaultRoot: string,
  originalPath: string,
  text: string,
  pdf?: PdfExtraction
): PreparedSource {
  return publishSource(vaultRoot, makeSource(originalPath, text, pdf, statOf(originalPath)))
}

/**
 * The stored conversion of a file that has not changed since — matched on
 * the original's path, size and filesystem revision. Null when the file
 * changed, was never converted, depends on local images, or the store no
 * longer holds its text. The newest matching record wins, so re-converting
 * with a better converter takes effect on the next run.
 */
export function cachedSource(vaultRoot: string, originalPath: string): PreparedSource | null {
  const stat = statOf(originalPath)
  return stat && cachedSourceAt(vaultRoot, originalPath, stat)
}

function cachedSourceAt(
  vaultRoot: string,
  originalPath: string,
  stat: NonNullable<ReturnType<typeof statOf>>,
  conversion?: string
): PreparedSource | null {
  const matches = [...readSourceIndex(vaultRoot)]
    .filter(
      ([, r]) =>
        r.originalPath === originalPath && r.size === stat.size && r.revision === stat.revision &&
        !r.externalImages &&
        (conversion === undefined || r.conversion === conversion)
    )
    .sort((a, b) => b[1].convertedAt.localeCompare(a[1].convertedAt))
  for (const [hash, record] of matches) {
    const text = readSourceText(vaultRoot, hash)
    if (text === null || sha1(text) !== hash) continue
    if (record.figures?.length) {
      const links = linkedFigurePaths(text)
      const unique = new Map(record.figures.map((ref) => [figurePath(ref), ref]))
      if (![...unique].every(([path, ref]) => links.has(path) &&
          readFigureFile(vaultRoot, sourcesDir(vaultRoot), ref))) continue
    }
    return { hash, text, record, cached: true }
  }
  return null
}

// Conversions written before this revision used UTF-8 for all text sources and
// EPUB entries. Keep them for citations but never reuse them for new imports.
const TEXT_CONVERSION = 'text-encoding-v1'
const FIGURE_CONVERSION = 'figures-v2'
const FIGURE_EXTENSIONS = new Set(['.pdf', '.epub', '.docx', '.html', '.htm', '.xhtml'])

/**
 * Prepare a preview from the stored text or convert fresh bytes. An explicit
 * encoding always reads the bytes again. The result is kept in memory until
 * the import is confirmed.
 */
export async function prepareSource(
  vaultRoot: string,
  originalPath: string,
  convert: (path: string, encoding?: string, readBytes?: (path: string) => Uint8Array, signal?: AbortSignal) => Promise<ConvertedDocument>,
  { encoding, picked, signal }: { encoding?: string; picked?: PickedSourceFile; signal?: AbortSignal } = {}
): Promise<PreparedSource> {
  signal?.throwIfAborted()
  const before = statOf(originalPath, picked)
  if (!before) throw new Error('The picked document is unavailable or was replaced. Pick it again.')
  const ext = extname(originalPath).toLowerCase()
  const standaloneText = supportsImportTextEncoding(originalPath)
  const automatic = encoding === undefined
  const figureDocument = FIGURE_EXTENSIONS.has(ext)
  const conversion = automatic ? (figureDocument ? FIGURE_CONVERSION : standaloneText ? TEXT_CONVERSION : undefined) : undefined
  const cached = automatic ? cachedSourceAt(vaultRoot, originalPath, before, conversion) : null
  // Local HTML images can change independently of the selected file.
  if (cached?.text.trim() && (ext !== '.pdf' || cached.record.pdf) && (!standaloneText || cached.record.encoding)) {
    return cached
  }
  const decoded = await convert(originalPath, encoding, picked && (() => readPickedSource(picked)), signal)
  signal?.throwIfAborted()
  if (!decoded.text.trim()) throw new Error('There is no readable text in this document.')
  const after = statOf(originalPath, picked)
  if (!after || before.revision !== after.revision || before.size !== after.size) {
    throw new Error('The document changed during conversion. Pick it again.')
  }
  return makeSource(originalPath, decoded.text, decoded.pdf, before, {
    encoding: decoded.encoding,
    figureCoverage: decoded.figureCoverage,
    externalImages: decoded.externalImages,
    conversion
  }, decoded.figures)
}
