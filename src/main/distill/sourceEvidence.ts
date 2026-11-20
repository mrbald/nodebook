import { figurePath, parseFigurePath, type FigureRef } from '../../shared/figures'
import { chunkMarkdown, type Chunk } from '../rag/chunk'
import { figureOcrMarkdown } from './captureFigures'

interface Span {
  start: number
  end: number
}

const IMAGE = /!\[(?:\\.|[^\\\]\r\n])*\]\(((?:\.\/)?figures\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))\)/g
const LINK_END = /^\]\((?:\\.|[^\\()\r\n]|\([^()\r\n]*\))*\)/

function imageSpans(text: string, paths: ReadonlySet<string>): Span[] {
  const spans: Span[] = []
  for (const match of text.matchAll(IMAGE)) {
    const ref = parseFigurePath(match[1])
    if (!ref || !paths.has(figurePath(ref))) continue
    let start = match.index
    let end = start + match[0].length
    // Turndown preserves an image wrapped in a hyperlink. When the image is
    // the entire label, the remaining empty link is visual UI, too.
    if (text[start - 1] === '[' && text[end] === ']') {
      const lineEnd = text.indexOf('\n', end)
      const wrapper = LINK_END.exec(text.slice(end, lineEnd === -1 ? undefined : lineEnd))
      if (wrapper) {
        start--
        end += wrapper[0].length
      }
    }
    spans.push({ start, end })
  }
  return spans
}

function firstEndingAfter(spans: Span[], pos: number): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2)
    if (spans[middle].end <= pos) lo = middle + 1
    else hi = middle
  }
  return lo
}

export interface DistillEvidence {
  chunks: Chunk[]
  /** A recovered quote may span chunk boundaries, but cannot cross a figure or OCR block. */
  allowSpan?: (start: number, end: number) => boolean
}

interface FigureEvidenceFilter {
  clip: (chunk: Chunk) => Chunk[]
  allowSpan: NonNullable<DistillEvidence['allowSpan']>
}

/** Find generated spans in the whole document so a passage that begins or
 * ends inside a long OCR line or image link is still filtered correctly. */
export function figureEvidenceFilter(text: string, figures: readonly FigureRef[]): FigureEvidenceFilter | null {
  if (!figures.length) return null
  const paths = new Set(figures.map(figurePath))
  const ocrLines = new Set(figures.map(figureOcrMarkdown).filter(Boolean))
  // OCR results are generated single lines. Match recorded text exactly so
  // an independently authored discussion of OCR remains evidence.
  const spans = imageSpans(text, paths)
  for (const match of text.matchAll(/^Figure OCR text [^\r\n]+/gm)) {
    if (ocrLines.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length })
  }
  const omitted: Span[] = []
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const prior = omitted.at(-1)
    if (prior && span.start <= prior.end) prior.end = Math.max(prior.end, span.end)
    else omitted.push(span)
  }
  if (!omitted.length) return null

  const headings = new Map<string, string>()
  const clip = (chunk: Chunk): Chunk[] => {
    let heading = headings.get(chunk.heading)
    if (heading === undefined) {
      heading = chunk.heading
      for (const span of imageSpans(heading, paths).reverse()) {
        heading = heading.slice(0, span.start) + heading.slice(span.end)
      }
      heading = heading.split(' > ').map((part) => part.trim()).filter(Boolean).join(' > ')
      headings.set(chunk.heading, heading)
    }
    const authored: Chunk[] = []
    const add = (start: number, end: number): void => {
      if (end <= start) return
      const raw = text.slice(start, end)
      const segment = raw.trim()
      if (!/[\p{L}\p{N}\p{S}]/u.test(segment)) return
      const offset = start + raw.length - raw.trimStart().length
      authored.push({ start: offset, end: offset + segment.length, text: segment, heading })
    }
    let from = chunk.start
    for (let i = firstEndingAfter(omitted, from); i < omitted.length && omitted[i].start < chunk.end; i++) {
      add(from, omitted[i].start)
      from = omitted[i].end
    }
    add(from, chunk.end)
    return authored
  }
  return {
    clip,
    allowSpan(start, end) {
      const next = omitted[firstEndingAfter(omitted, start)]
      return !next || next.start >= end
    }
  }
}

/** The saved source retains its portable image links and searchable OCR.
 * Distillation receives only authored source spans, with original offsets. */
export function distillEvidence(text: string, figures?: readonly FigureRef[]): DistillEvidence {
  const chunks = chunkMarkdown(text)
  const filter = figures && figureEvidenceFilter(text, figures)
  return filter ? { chunks: chunks.flatMap(filter.clip), allowSpan: filter.allowSpan } : { chunks }
}

export function chunkDistillSource(text: string, figures?: readonly FigureRef[]): Chunk[] {
  return distillEvidence(text, figures).chunks
}
