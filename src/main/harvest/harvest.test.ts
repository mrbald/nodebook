import { describe, it, expect } from 'vitest'
import { harvest, frontmatterKind } from './index'

describe('harvest', () => {
  it('takes the title from the first H1, else the file name', () => {
    expect(harvest('/v/Note.md', '# My Title\n\nbody').title).toBe('My Title')
    expect(harvest('/v/Some File.md', 'no heading here').title).toBe('Some File')
  })

  it('emits a links_to triple for each wikilink', () => {
    const { triples } = harvest('/v/A.md', 'see [[Graph Model]] and [[B]]')
    expect(triples).toEqual([
      { subject: 'A', relation: 'links_to', object: 'Graph Model' },
      { subject: 'A', relation: 'links_to', object: 'B' }
    ])
  })

  it('strips alias and heading from wikilink targets', () => {
    const { triples } = harvest('/v/A.md', '[[Target|shown text]] [[Other#Section]]')
    expect(triples.map((t) => t.object)).toEqual(['Target', 'Other'])
  })

  it('extracts typed fields, resolving wikilink values to their target', () => {
    const { triples } = harvest('/v/Paper.md', 'author:: [[Jane Doe]]\nstatus:: draft')
    expect(triples).toContainEqual({ subject: 'Paper', relation: 'author', object: 'Jane Doe' })
    expect(triples).toContainEqual({ subject: 'Paper', relation: 'status', object: 'draft' })
  })

  it('does not extract links or fields inside fenced code blocks', () => {
    const doc = ['```', 'see [[NotALink]]', 'key:: not a field', '```', 'real [[Link]]'].join('\n')
    const { triples } = harvest('/v/A.md', doc)
    expect(triples).toEqual([{ subject: 'A', relation: 'links_to', object: 'Link' }])
  })

  it('returns the raw content as the FTS text payload', () => {
    const doc = '# T\n\nsearchable words'
    expect(harvest('/v/T.md', doc).text).toBe(doc)
  })

  it('records the frontmatter kind, defaulting to note', () => {
    expect(harvest('/v/A.md', '# A').kind).toBe('note')
    expect(harvest('/v/A.md', '---\nkind: concept\n---\n# A').kind).toBe('concept')
  })

  it('gives a kind: document note the cheap path — a title, no triples', () => {
    const book = '---\nkind: document\ndocument: "/books/Sapiens.epub"\n---\n\n# Sapiens\n\nsee [[Fire]]\nauthor:: [[Harari]]'
    const h = harvest('/v/Sources/Sapiens.md', book)
    expect(h.kind).toBe('document')
    expect(h.title).toBe('Sapiens')
    expect(h.triples).toEqual([]) // a book's prose is not a knowledge edge
    expect(h.text).toBe(book) // still fully searchable
  })

  it('falls back to the file name for a document with no H1', () => {
    expect(harvest('/v/Sources/Book.md', '---\nkind: document\n---\n\ntext').title).toBe('Book')
  })
})

describe('frontmatterKind', () => {
  it('reads a known kind from a leading frontmatter block', () => {
    for (const k of ['document', 'theme', 'concept', 'claim', 'entity'])
      expect(frontmatterKind(`---\nkind: ${k}\n---\n# x`)).toBe(k)
  })

  it('is note for no frontmatter, an unknown kind, or a mention in the body', () => {
    expect(frontmatterKind('# x')).toBe('note')
    expect(frontmatterKind('---\nkind: recipe\n---\n# x')).toBe('note')
    expect(frontmatterKind('---\nkind: my own thing\n---\n# x')).toBe('note')
    expect(frontmatterKind('# x\n\nkind: document')).toBe('note')
  })

  it('reads a kind that is not the first frontmatter line', () => {
    expect(frontmatterKind('---\nsource: Book\nkind: claim\n---\n# x')).toBe('claim')
  })
})
