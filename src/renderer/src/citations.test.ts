import { describe, it, expect } from 'vitest'
import {
  parseCitations,
  parseDocumentNote,
  resolveCitationSpan,
  gateAnswerCitations,
  usedCitations,
  type NoteCitation
} from './citations'

const note = `---
kind: claim
source: Federalist Papers.md
cite:
  - chunk: 10
    span: 100-130
  - chunk: 12
    span: 200-240
---
# Extended republic

source:: [[Federalist Papers]]

A large republic dilutes faction.
`

describe('parseCitations', () => {
  it('reads source + each cite span from the frontmatter (legacy — no quote)', () => {
    expect(parseCitations(note)).toEqual([
      { source: 'Federalist Papers', chunk: 10, start: 100, end: 130 },
      { source: 'Federalist Papers', chunk: 12, start: 200, end: 240 }
    ])
  })

  it('returns nothing for a note without frontmatter or cites', () => {
    expect(parseCitations('# Plain note\n\nno frontmatter')).toEqual([])
    expect(parseCitations('---\nkind: note\n---\n# x')).toEqual([])
  })

  it('ignores a zero/negative span and strips the .md from the source', () => {
    const bad = '---\nsource: Book.md\ncite:\n  - chunk: 1\n    span: 50-50\n---\n'
    expect(parseCitations(bad)).toEqual([])
  })

  it('keeps a comma-containing source title whole (one run = one document)', () => {
    const commaTitle =
      '---\nsource: Options, Futures, and Other Derivatives Solutions Manual — Hull J\n' +
      'cite:\n  - chunk: 1\n    span: 10-30\n---\n'
    expect(parseCitations(commaTitle)[0].source).toBe(
      'Options, Futures, and Other Derivatives Solutions Manual — Hull J'
    )
  })

  it('parses the quote field when present, JSON-unescaping it', () => {
    const withQuote =
      '---\nsource: Book.md\ncite:\n  - chunk: 1\n    span: 10-30\n' +
      '    quote: "He said \\"no\\"\\nand left."\n---\n'
    expect(parseCitations(withQuote)).toEqual([
      { source: 'Book', chunk: 1, start: 10, end: 30, quote: 'He said "no"\nand left.' }
    ])
  })

  it('reads where the quote is, when the run recorded it', () => {
    const withWhere =
      '---\nkind: claim\nsource: Book\ncite:\n  - chunk: 1\n    span: 5-9\n' +
      '    where: "Page 42"\n    quote: "text"\n---\n# x'
    expect(parseCitations(withWhere)[0]).toEqual({
      source: 'Book',
      chunk: 1,
      start: 5,
      end: 9,
      quote: 'text',
      where: 'Page 42'
    })
  })

  it('still parses a citation with no where (older runs, and unheaded documents)', () => {
    const noWhere = '---\nsource: Book\ncite:\n  - chunk: 1\n    span: 5-9\n    quote: "text"\n---\n# x'
    expect(parseCitations(noWhere)[0].where).toBeUndefined()
    expect(parseCitations(noWhere)[0].quote).toBe('text')
  })
})

describe('resolveCitationSpan', () => {
  const content = 'Extend the sphere, and you take in a greater variety of parties.'

  it('a legacy citation (no quote) is trusted as-is', () => {
    const c: NoteCitation = { source: 'Book', chunk: 1, start: 0, end: 6 }
    expect(resolveCitationSpan(content, c)).toEqual({ status: 'unverified', start: 0, end: 6 })
  })

  it('a citation whose span still matches its quote is ok', () => {
    const c: NoteCitation = { source: 'Book', chunk: 1, start: 0, end: 18, quote: 'Extend the sphere,' }
    expect(resolveCitationSpan(content, c)).toEqual({ status: 'ok', start: 0, end: 18 })
  })

  it('relocates when the source drifted but the quote is still findable', () => {
    // The source was edited: the recorded span now points at the wrong text.
    const c: NoteCitation = { source: 'Book', chunk: 1, start: 0, end: 5, quote: 'a greater variety' }
    const res = resolveCitationSpan(content, c)
    expect(res.status).toBe('relocated')
    if (res.status !== 'not-found') expect(content.slice(res.start, res.end)).toBe('a greater variety')
  })

  it('reports not-found when the quote is nowhere in the content', () => {
    const c: NoteCitation = { source: 'Book', chunk: 1, start: 0, end: 5, quote: 'never written here' }
    expect(resolveCitationSpan(content, c)).toEqual({ status: 'not-found' })
  })
})

describe('gateAnswerCitations', () => {
  const sources = ['Federalist Papers', 'welcome']

  it('leaves a wikilink naming a real source untouched', () => {
    expect(gateAnswerCitations('See [[welcome]] for more.', sources)).toBe('See [[welcome]] for more.')
  })

  it('flattens a wikilink naming a non-source to plain text', () => {
    expect(gateAnswerCitations('See [[Made Up Note]] for more.', sources)).toBe('See Made Up Note for more.')
  })

  it('is case-sensitive — a case mismatch is not a real citation', () => {
    expect(gateAnswerCitations('See [[Welcome]].', sources)).toBe('See Welcome.')
  })

  it('flattens to the display text when a piped wikilink is not a real source', () => {
    expect(gateAnswerCitations('See [[Fake|shown text]].', sources)).toBe('See shown text.')
  })
})

describe('usedCitations', () => {
  const sources = ['Federalist Papers', 'welcome']

  it('collects only the sources actually named via [[wikilink]]', () => {
    expect(usedCitations('Per [[welcome]] and [[Nonexistent]].', sources)).toEqual(new Set(['welcome']))
  })

  it('returns an empty set when nothing is cited', () => {
    expect(usedCitations('No citations here.', sources)).toEqual(new Set())
  })
})

describe('parseDocumentNote', () => {
  const book = (fm: string): string => `---\nkind: document\n${fm}\n---\n\n## Page 1\n\ntext`

  it('reads the hash and the original path off a document note', () => {
    const note = book('document: "/books/A \\"quoted\\": name.pdf"\nhash: ' + 'a'.repeat(40))
    expect(parseDocumentNote(note)).toEqual({
      hash: 'a'.repeat(40),
      path: '/books/A "quoted": name.pdf'
    })
  })

  it('is null for anything that is not a document note', () => {
    expect(parseDocumentNote('# plain note')).toBeNull()
    expect(parseDocumentNote('---\nkind: claim\nhash: ' + 'a'.repeat(40) + '\n---\n# x')).toBeNull()
  })

  it('ignores a hash that is not one, and a document note that records neither', () => {
    expect(parseDocumentNote(book('hash: not-a-hash'))!.hash).toBeUndefined()
    expect(parseDocumentNote('---\nkind: document\n---\n\ntext')).toEqual({})
  })
})
