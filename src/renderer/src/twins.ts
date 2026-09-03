/**
 * What a note's `same_as` twins say, prepared for the reading panel.
 *
 * A merge can mark two notes as one idea (`same_as:: [[Other]]`), and the map
 * already draws them as one dot. The reader still has one file open, so the
 * panel gathers the other file's gist and its citations and shows them beside
 * the note's own. Nothing is written: the union exists only while the note is
 * being read.
 *
 * Pure, so it is unit-tested; the panel does the reading and the rendering.
 */

import type { NoteCitation } from './citations'

/** A quote, on one line, short enough to sit under a citation. */
export function quoteLine(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat
}

/** As much of a twin as fits in a side panel: what it says, and what it quotes. */
export interface NoteGist {
  /** The note's opening prose, wikilinks flattened to their text. */
  summary: string
  /** Its `> ` quotes, each on one line. */
  quotes: string[]
}

/** How much of the opening prose the panel shows before it stops. */
const SUMMARY_MAX = 400

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/
/** A line-level `key:: value` field — the same shape `harvest` reads. */
const FIELD_RE = /^[ \t]*[A-Za-z][\w -]*?\s*::/
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g
/** A bullet or numbered-list marker at the start of a line. */
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])\s+/

/** `[[X|Y]]` reads as Y and `[[X]]` as X — a reader wants the words, not the
 *  link syntax, and the panel has nowhere to navigate to anyway. */
function flattenWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, (_whole, inner: string) => {
    const bar = inner.indexOf('|')
    return (bar >= 0 ? inner.slice(bar + 1) : inner.split('#')[0]).trim()
  })
}

/**
 * The readable core of a note: its opening prose and its quotes, with the
 * scaffolding (frontmatter, the `# Title` that repeats the file name, the
 * `key:: value` fields the panel already lists elsewhere) left out. A note with
 * nothing but a title yields an empty summary and no quotes.
 */
export function noteGist(content: string): NoteGist {
  const body = content.replace(FRONTMATTER_RE, '')
  const quotes: string[] = []
  const paragraphs: string[] = []
  let para: string[] = []
  const endPara = (): void => {
    if (para.length > 0) paragraphs.push(flattenWikilinks(para.join(' ')))
    para = []
  }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || FIELD_RE.test(line)) {
      endPara()
      continue
    }
    if (line.startsWith('>')) {
      endPara()
      const inner = line.replace(/^>\s?/, '')
      // `> key:: [[x]]` is a field written inside a quote block — harvest reads
      // it as a field, so the panel must not read it as one of the quotes.
      if (FIELD_RE.test(inner)) continue
      const quote = quoteLine(flattenWikilinks(inner))
      if (quote) quotes.push(quote)
      continue
    }
    // A list item reads as prose once its marker is gone: a theme note's member
    // list, or a hand-written bullet list, joins the summary as words.
    para.push(line.replace(LIST_MARKER_RE, ''))
  }
  endPara()

  let summary = ''
  for (const p of paragraphs) {
    if (summary.length >= SUMMARY_MAX) break
    summary = summary ? `${summary} ${p}` : p
  }
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`
  return { summary, quotes }
}

/** A citation as the panel shows it: one from a twin says which note it is from. */
export interface PanelCitation extends NoteCitation {
  /** The twin's name, when this citation came from a twin rather than the note. */
  from?: string
}

/** What one twin contributes to the Sources list. */
export interface TwinCitations {
  name: string
  citations: NoteCitation[]
}

/**
 * Identity of a citation for the union below. A quote names the passage, so two
 * runs that grounded on the same words are the same citation however their
 * offsets drifted. A citation from before quotes were recorded has only its
 * span — and that span is what tells it apart, so quoteless citations from one
 * book must not all collapse onto each other.
 */
function citationKey(c: NoteCitation): string {
  return JSON.stringify(
    c.quote !== undefined ? ['q', c.source, c.quote] : ['s', c.source, c.start, c.end]
  )
}

/**
 * The note's own citations, then each twin's, with nothing said twice. The
 * note's own copy wins, so a passage both notes cite carries no "from" label.
 */
export function unionCitations(own: NoteCitation[], twins: TwinCitations[]): PanelCitation[] {
  const seen = new Set<string>()
  const out: PanelCitation[] = []
  const take = (c: NoteCitation, from?: string): void => {
    const key = citationKey(c)
    if (seen.has(key)) return
    seen.add(key)
    out.push(from === undefined ? c : { ...c, from })
  }
  for (const c of own) take(c)
  for (const twin of twins) for (const c of twin.citations) take(c, twin.name)
  return out
}
