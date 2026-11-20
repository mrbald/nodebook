import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { setImmediate as yieldToLoop } from 'timers/promises'
import { figurePath, parseFigurePath, type FigureCoverage, type FigureRef, type FigureExtension } from '../../shared/figures'
import { figureImageDimensions } from './figureImage'
import { MAX_FIGURE_BYTES } from './captureFigures'

const FIGURE_LINK = /\]\((?:\.\/)?(figures\/[0-9a-f]{64}\.(?:png|jpg|gif|webp))\)/g

export function linkedFigurePaths(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(FIGURE_LINK)].map((match) => match[1]))
}

export function readFigureCoverage(raw: unknown): FigureCoverage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { skipped, uninspectedPages } = raw as Partial<FigureCoverage>
  const figures = typeof skipped === 'number' && Number.isSafeInteger(skipped) && skipped > 0 ? skipped : 0
  const pages = typeof uninspectedPages === 'number' &&
    Number.isSafeInteger(uninspectedPages) && uninspectedPages > 0 ? uninspectedPages : 0
  return figures || pages ? { skipped: figures, ...(pages ? { uninspectedPages: pages } : {}) } : undefined
}

/** Stop before opening a descendant of a symlink. The vault itself may have a
 * platform alias (e.g. `/var`); every component under it must be local. */
export function localDirectory(vault: string, directory: string, create = false): boolean {
  const child = relative(vault, directory)
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return false
  let current = vault
  for (const part of child ? child.split(sep) : []) {
    current = join(current, part)
    if (create && !lstatSync(current, { throwIfNoEntry: false })) {
      try {
        mkdirSync(current)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) return false
  }
  return true
}

export function readLocalFile(vault: string, path: string, maxBytes?: number): Buffer | null {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || !localDirectory(vault, dirname(path))) return null
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) return null
      if (maxBytes === undefined) return readFileSync(fd)
      if (stat.size > maxBytes) return null
      const bytes = Buffer.allocUnsafe(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (!n) return null
        offset += n
      }
      return fstatSync(fd).size === stat.size ? bytes : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export function readFigureRefs(raw: unknown): FigureRef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const figures: FigureRef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined
    const { id, ext, label, location, caption, ocr } = entry as Partial<FigureRef>
    if (typeof id !== 'string' || typeof ext !== 'string' ||
        !parseFigurePath(`figures/${id}.${ext}`) || typeof label !== 'string' ||
        typeof location !== 'string' || !label.trim() || !location.trim()) return undefined
    figures.push({ id, ext, label, location, ...(typeof caption === 'string' ? { caption } : {}),
      ...(typeof ocr === 'string' ? { ocr } : {}) })
  }
  return figures
}

const MIME: Record<FigureExtension, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'
}

export function matchesFigure(bytes: Uint8Array, ref: Pick<FigureRef, 'id' | 'ext'>): boolean {
  return bytes.byteLength <= MAX_FIGURE_BYTES && figureImageDimensions(bytes)?.[0] === ref.ext &&
    createHash('sha256').update(bytes).digest('hex') === ref.id
}

const verifiedFigures = new Map<string, { revision: string; valid: boolean }>()
const MAX_VERIFIED_RECORDS = 8192

function localFigureRevision(vault: string, base: string, ref: Pick<FigureRef, 'id' | 'ext'>): {
  path: string
  revision: string
} | null {
  const rel = figurePath(ref)
  if (!parseFigurePath(rel)) return null
  const path = join(base, rel)
  try {
    if (!localDirectory(vault, dirname(path))) return null
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (!stat?.isFile() || stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(MAX_FIGURE_BYTES)) return null
    return { path, revision: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') }
  } catch {
    return null
  }
}

function rememberFigure(path: string, revision: string, valid: boolean): void {
  verifiedFigures.delete(path)
  verifiedFigures.set(path, { revision, valid })
  if (verifiedFigures.size > MAX_VERIFIED_RECORDS) {
    const oldest = verifiedFigures.keys().next().value
    if (oldest !== undefined) verifiedFigures.delete(oldest)
  }
}

/** A writer that has already checked a digest can remember the resulting
 * revision without reopening the image after its atomic write. */
export function rememberWrittenFigure(vault: string, base: string, ref: Pick<FigureRef, 'id' | 'ext'>): void {
  const file = localFigureRevision(vault, base, ref)
  if (file) rememberFigure(file.path, file.revision, true)
}

export function readFigureFile(
  vault: string,
  base: string,
  ref: Pick<FigureRef, 'id' | 'ext'>
): { bytes: Buffer; mime: string } | null {
  const file = localFigureRevision(vault, base, ref)
  if (!file) return null
  const bytes = readLocalFile(vault, file.path, MAX_FIGURE_BYTES)
  const valid = !!bytes && matchesFigure(bytes, ref)
  if (localFigureRevision(vault, base, ref)?.revision === file.revision) {
    rememberFigure(file.path, file.revision, valid)
  }
  return valid ? { bytes, mime: MIME[ref.ext] } : null
}

export async function hasFigureFile(vault: string, base: string, ref: Pick<FigureRef, 'id' | 'ext'>): Promise<boolean> {
  const file = localFigureRevision(vault, base, ref)
  if (!file) return false
  const known = verifiedFigures.get(file.path)
  if (known?.revision === file.revision) return known.valid
  // Each file is bounded; yield between uncached reads so a cold book or
  // catalog does not occupy the main process for its entire image budget.
  await yieldToLoop()
  const current = localFigureRevision(vault, base, ref)
  if (!current) return false
  const checked = verifiedFigures.get(current.path)
  return checked?.revision === current.revision ? checked.valid : !!readFigureFile(vault, base, ref)
}
