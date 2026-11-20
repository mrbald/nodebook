import type { Citation } from '@shared/types'

import type { NoteCitation } from '@shared/markdown/noteCitations'
export { parseCitations, parseDocumentNote, type NoteCitation, type NoteDocument } from '@shared/markdown/noteCitations'

// ---------------------------------------------------------------------------
// Self-healing citation spans — a source note can be edited after a distill
// run, so the recorded [start,end) can drift. If the quote no longer matches
// at that span, search the content for it before giving up.
// ---------------------------------------------------------------------------

/** Collapse whitespace runs to a single space and trim, for a reflow-tolerant
 *  equality check between the recorded span's text and its quote. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find `quote` inside `haystack`, tolerating whitespace reflow. Mirrors
 *  distill/extract.ts's `locateQuote`; duplicated because main and renderer
 *  don't share a module boundary (see tsconfig.node.json / tsconfig.web.json). */
function locateQuote(haystack: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim()
  if (!q) return null
  const exact = haystack.indexOf(q)
  if (exact >= 0) return { start: exact, end: exact + q.length }
  const pattern = q.split(/\s+/).map(escapeRe).join('\\s+')
  const m = new RegExp(pattern, 'i').exec(haystack)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

export type CitationSpanResult =
  | { status: 'ok' | 'relocated' | 'unverified'; start: number; end: number }
  | { status: 'not-found' }

/**
 * Resolve where a citation's span actually is in the source note's current
 * `content`. A citation with no recorded quote is trusted as-is ('unverified'
 * — legacy behavior, from before quotes were captured). Otherwise: if the
 * text at [start,end) still matches the quote (whitespace-tolerant), it's
 * 'ok'; if the quote is found elsewhere, 'relocated' to that span; if it can't
 * be found anywhere, 'not-found' — the caller should open the note without a
 * selection and say so.
 */
export function resolveCitationSpan(content: string, c: NoteCitation): CitationSpanResult {
  if (c.quote === undefined) return { status: 'unverified', start: c.start, end: c.end }
  const at = content.slice(c.start, c.end)
  if (normalizeWs(at) === normalizeWs(c.quote)) return { status: 'ok', start: c.start, end: c.end }
  const loc = locateQuote(content, c.quote)
  return loc ? { status: 'relocated', start: loc.start, end: loc.end } : { status: 'not-found' }
}

/** Reveal an Ask passage only where its exact source text can still be verified. */
export function resolveAskPassage(
  content: string,
  { start, end, quote }: Pick<Citation, 'start' | 'end' | 'quote'>
): { start: number; end: number } | null {
  if (!quote) return null
  if (content.slice(start, end) === quote) return { start, end }
  const at = content.indexOf(quote)
  if (at < 0 || content.indexOf(quote, at + 1) !== -1) return null
  return { start: at, end: at + quote.length }
}
