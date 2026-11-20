import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { figurePath, parseFigurePath, type FigureRef } from '../../shared/figures'
import { parseCitations, parseDocumentNote } from '../../shared/markdown/noteCitations'
import { chunkMarkdown } from '../rag/chunk'
import { ignoredInVault, withinRoot } from '../paths'
import {
  archivedFigureMerge,
  archivedFigureRunIds,
  isRunId,
  listRuns,
  readMergeManifest,
  readRunSource,
  sourceNoteName,
  stagedNotePath,
  SOURCES_FOLDER
} from './artifact'
import { renderDocumentNote } from './emit'
import { hasFigureFile, linkedFigurePaths, readFigureFile, readLocalFile } from './figureFiles'
import { readSourceIndex, readSourceRecord, readSourceText, sha1 } from './sources'

interface NoteFigures {
  bookPath: string
  hash?: string
  text: string
  citeOffset: number
  figures: FigureRef[]
}

function stagedFigures(vault: string, path: string, runId: string): NoteFigures | null {
  if (stagedNotePath(vault, runId, path) !== path) return null
  const run = readRunSource(vault, runId)
  if (!run?.figures?.length) return null
  return {
    bookPath: join(dirname(path), `${sourceNoteName(run.file)}.md`), hash: run.hash,
    text: run.text, citeOffset: renderDocumentNote(run).citeOffset, figures: run.figures
  }
}

function mergedFigures(vault: string, path: string, content: string): NoteFigures | null {
  const rel = relative(vault, path)
  const [top, id, file, ...rest] = rel.split(sep)
  if (top === SOURCES_FOLDER) {
    if (!id || file !== undefined) return null
  } else if (top !== 'Distilled' || !isRunId(id) || !file || rest.length > 0) {
    return null
  }
  const owners = top === SOURCES_FOLDER ? new Set([...listRuns(vault), ...archivedFigureRunIds(vault)]) : [id]
  let noteHash: string | undefined
  for (const runId of owners) {
    const receipt = readMergeManifest(vault, runId) ?? archivedFigureMerge(vault, runId)
    const source = receipt?.figureSource
    if (!receipt?.complete || !source) continue
    // A same-directory rename leaves the receipt's content hash intact. Reuse
    // it only within that exact directory, never by a matching title alone.
    const entry = receipt.files.find((item) => !item.asset && item.path === rel) ??
      receipt.files.find((item) => !item.asset && item.hash && dirname(item.path) === dirname(rel) &&
        item.hash === (noteHash ??= sha1(content)))
    if (!entry) continue
    const book = entry.path === source.path
    const bookPath = book ? path : join(vault, source.path)
    // Each copy is verified independently so a relocated vault can still read
    // its figures if the source store was lost, and an edited book cannot
    // silently change the text behind the original citations.
    const stored = readSourceText(vault, source.hash)
    const saved = stored && sha1(stored) === source.hash ? stored : readRunSource(vault, runId)?.text
    const text = saved && sha1(saved) === source.hash ? saved :
      (book ? content : readLocalFile(vault, bookPath)?.toString('utf8'))?.slice(source.citeOffset)
    if (text === undefined || sha1(text) !== source.hash) continue
    return { bookPath, hash: source.hash, text, citeOffset: source.citeOffset, figures: source.figures }
  }
  return null
}

function canonicalNoteText(vault: string, path: string): string | undefined {
  if (!withinRoot(vault, path) || ignoredInVault(vault)(path) || !/\.md$/i.test(path)) return
  return readLocalFile(vault, path)?.toString('utf8')
}

/** Undo retains renamed links. A complete copy of the original generated
 * document still proves its own identity after the merge receipt is gone. */
function approvedDocument(vault: string, path: string, content: string): NoteFigures | null {
  const hash = parseDocumentNote(content)?.hash
  const header = /^---\n[\s\S]*?\n---\n\n/.exec(content)
  if (!hash || !header) return null
  const citeOffset = header[0].length
  const text = content.slice(citeOffset)
  if (sha1(text) !== hash) return null
  const figures = readSourceRecord(vault, hash)?.figures
  return figures?.length ? { bookPath: path, hash, text, citeOffset, figures } : null
}

/** Text evidence is independent of the continued presence of the figure files.
 * Require the merge receipt or an exact copy of an approved generated source. */
export function resolveManagedDocumentFigures(vault: string, path: string): {
  text: string
  bodyStart: number
  figures: FigureRef[]
} | null {
  const text = canonicalNoteText(vault, path)
  if (text === undefined) return null
  const source = mergedFigures(vault, path, text) ?? approvedDocument(vault, path, text)
  if (!source || source.bookPath !== path || parseDocumentNote(text)?.hash !== source.hash) return null
  const header = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text)
  return header ? { text, bodyStart: header[0].length, figures: source.figures } : null
}

function normalizeLocation(location: string): string {
  return location.toLowerCase().split(/\s+[>›]\s+/).map((part) => part.trim()).join(' > ')
}

const NUMBERED_FIGURE = /\b(figure|fig\.?|chart|graph|table|diagram|illustration|plot)s?\s+(\d+[a-z]?)\b/gi
const VISUAL = /\b(?:figure|chart|graph|table|diagram|illustration|image|plot)\b/i
const SENTENCE_BREAK = /[.!?](?:[”"')\]]*)\s|\n\s*\n/

function figureNumbers(text: string): string[] {
  return [...text.matchAll(NUMBERED_FIGURE)].map((match) => {
    const noun = match[1].toLowerCase()
    return `${noun === 'fig' || noun === 'fig.' ? 'figure' : noun} ${match[2].toLowerCase()}`
  })
}

function citedFigures(content: string, source: NoteFigures): Set<FigureRef> {
  const expected = basename(source.bookPath, '.md')
  const citations = parseCitations(content).filter((cite) => cite.source === expected)
  const found = new Set<FigureRef>()
  if (!citations.length) return found
  const locations = new Set<string>()
  const sectionLinks = new Set<string>()
  const chunks = chunkMarkdown(source.text)
  for (const cite of citations) {
    const start = cite.start - source.citeOffset
    const end = cite.end - source.citeOffset
    if (start < 0 || end > source.text.length || !cite.quote || source.text.slice(start, end) !== cite.quote) continue
    const index = chunks.findIndex((chunk) => start >= chunk.start && start < chunk.end)
    if (index < 0) continue
    const chunk = chunks[index]
    const location = normalizeLocation(chunk.heading || 'Document')
    const page = /(?:^| > )page (\d+)$/.exec(location)
    // Look at the sentence containing the grounded span. The model may have
    // quoted only "the chart on the next". Never cross to a neighboring page
    // or section for context, even when the quote itself was recovered across
    // a boundary.
    let first = index
    let last = index
    while (first > 0 && chunks[first - 1].heading === chunk.heading) first--
    while (last + 1 < chunks.length && chunks[last + 1].heading === chunk.heading) last++
    const contextStart = Math.max(start - 320, chunks[first].start)
    const contextEnd = Math.min(end + 320, chunks[last].end)
    const before = source.text.slice(contextStart, start).split(SENTENCE_BREAK).at(-1) ?? ''
    const selected = source.text.slice(start, Math.min(end, contextEnd))
    const after = /[.!?][”"')\]]*\s*$/.test(selected) ? '' :
      source.text.slice(end, contextEnd).split(SENTENCE_BREAK)[0]
    const sentence = before + selected + after
    for (const number of figureNumbers(sentence)) {
      const matching = source.figures.filter((ref) => figureNumbers(`${ref.label}\n${ref.caption ?? ''}`).includes(number))
      if (matching.length === 1) found.add(matching[0])
    }
    if (page) {
      const current = Number(page[1])
      locations.add(`page ${current}`)
      if (VISUAL.test(sentence)) {
        if (/\bnext page\b/i.test(sentence)) locations.add(`page ${current + 1}`)
        for (const explicit of sentence.matchAll(/\bpage (\d+)\b/gi)) {
          locations.add(`page ${Number(explicit[1])}`)
        }
      }
    } else {
      locations.add(location)
      // A converter can attach a chapter's label even if the authored HTML
      // heading starts a different path. The actual image link is evidence
      // of placement when the digest has a single occurrence.
      for (const path of linkedFigurePaths(source.text.slice(chunks[first].start, chunks[last].end))) {
        sectionLinks.add(path)
      }
    }
  }
  for (const ref of source.figures) {
    const link = figurePath(ref)
    if (locations.has(normalizeLocation(ref.location)) ||
        (sectionLinks.has(link) && source.figures.filter((other) => figurePath(other) === link).length === 1)) {
      found.add(ref)
    }
  }
  return found
}

interface LocatedFigure {
  ref: FigureRef
  base: string
}

/** An ordinary note can deliberately link an approved digest beside itself.
 * The note owns its label. Captions and OCR from a different source do not
 * become part of its provenance merely because the raster bytes are shared. */
function explicitFigures(vault: string, path: string, content: string, requested: string[]): LocatedFigure[] {
  if (!requested.length) return []
  const approved = new Set([...readSourceIndex(vault).values()].flatMap((record) =>
    (record.figures ?? []).map(figurePath)))
  const labels = new Map([...content.matchAll(/!\[([^\]\n]{1,200})\]\((?:\.\/)?(figures\/[0-9a-f]{64}\.(?:png|jpg|gif|webp))\)/g)]
    .map((match) => [match[2], match[1].trim()]))
  return requested.flatMap((link) => {
    const ref = approved.has(link) && parseFigurePath(link)
    return ref ? [{ base: dirname(path), ref: { ...ref, label: labels.get(link) || 'Figure', location: basename(path, '.md') } }] : []
  })
}

function locatedFigures(vault: string, path: string, runId?: string): LocatedFigure[] {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !/\.md$/i.test(path)) return []
  if (runId !== undefined && (typeof runId !== 'string' || !isRunId(runId))) return []
  const staged = runId !== undefined
  const sourceFromRun = staged ? stagedFigures(vault, path, runId) : null
  if (staged && !sourceFromRun) return []
  const content = staged ? readLocalFile(vault, path)?.toString('utf8') : canonicalNoteText(vault, path)
  if (!content) return []
  const embedded = linkedFigurePaths(content)
  const source = sourceFromRun ?? mergedFigures(vault, path, content) ?? approvedDocument(vault, path, content)
  if (!source) return explicitFigures(vault, path, content, [...embedded])
  const book = path === source.bookPath
  if (book) {
    const parsed = parseDocumentNote(content)
    if (!parsed || parsed.hash !== source.hash) {
      return staged ? [] : explicitFigures(vault, path, content, [...embedded])
    }
  }
  const approved = linkedFigurePaths(source.text)
  const cited = book ? new Set<FigureRef>() : citedFigures(content, source)
  const located = source.figures.flatMap((ref) => {
    const link = figurePath(ref)
    if (!approved.has(link)) return []
    if (embedded.has(link)) return [{ ref, base: dirname(path) }]
    return cited.has(ref) ? [{ ref, base: dirname(source.bookPath) }] : []
  })
  if (staged) return located
  const handled = new Set(located.map(({ ref }) => figurePath(ref)))
  return [...located, ...explicitFigures(vault, path, content, [...embedded].filter((link) => !handled.has(link)))]
}

export async function resolveNoteFigures(vault: string, path: string, runId?: string): Promise<FigureRef[]> {
  const checked = new Map<string, boolean>()
  const figures: FigureRef[] = []
  for (const { ref, base } of locatedFigures(vault, path, runId)) {
    const key = join(base, figurePath(ref))
    if (!checked.has(key)) checked.set(key, await hasFigureFile(vault, base, ref))
    if (checked.get(key)) figures.push(ref)
  }
  return figures
}

export function resolveNoteFigureBytes(
  vault: string,
  path: string,
  id: string,
  runId?: string,
  context?: Pick<FigureRef, 'label' | 'location' | 'caption'>
): { bytes: Uint8Array<ArrayBuffer>; mime: string; ref: FigureRef } | null {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return null
  for (const { ref, base } of locatedFigures(vault, path, runId)) {
    if (id !== ref.id) continue
    if (context && (ref.label !== context.label || ref.location !== context.location || ref.caption !== context.caption)) continue
    const figure = readFigureFile(vault, base, ref)
    if (figure) return { bytes: Uint8Array.from(figure.bytes), mime: figure.mime, ref }
  }
  return null
}
