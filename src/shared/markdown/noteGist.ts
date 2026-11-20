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

const FRONTMATTER_RE = /^---\n[\s\S]*?(?:\n---(?:\n|$)|$)/
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
export function noteGist(content: string, maxLength = 400): NoteGist {
  const body = content.replace(/\r\n/g, '\n').replace(FRONTMATTER_RE, '')
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
    if (summary.length >= maxLength) break
    summary = summary ? `${summary} ${p}` : p
  }
  if (summary.length > maxLength) summary = `${summary.slice(0, maxLength - 1)}…`
  return { summary, quotes }
}
