import { describe, it, expect } from 'vitest'
import { noteName, sourceTitle, renderNote, emitNotes } from './emit'
import { harvest } from '../harvest'
import type { GroundedNote } from './extract'

const note = (over: Partial<GroundedNote> = {}): GroundedNote => ({
  kind: 'claim',
  title: 'Extended republic',
  summary: 'Scale dilutes faction.',
  links: [
    { relation: 'about', target: 'Faction' },
    { relation: 'supports', target: 'Representative republic' }
  ],
  citations: [
    { file: 'Federalist Papers.md', chunkId: 10, start: 100, end: 117, quote: 'Extend the sphere' }
  ],
  ...over
})

describe('noteName', () => {
  it('strips path/wikilink-hostile chars and collapses whitespace', () => {
    expect(noteName('Checks/balances: ambition #1')).toBe('Checks balances ambition 1')
    expect(noteName('  Faction  ')).toBe('Faction')
  })
  it('falls back to "untitled" when nothing survives', () => {
    expect(noteName('///')).toBe('untitled')
  })
})

describe('sourceTitle', () => {
  it('strips the extension, keeps title + author from a library-dump name, cleans underscores', () => {
    const dump =
      "Options, Futures, and Other Derivatives__ Solutions Manual -- Hull J_ -- 11, 2021 -- Pearson -- 80e6709029281e474d6c1fe3767907a0 -- Anna's Archive.pdf"
    expect(sourceTitle(dump)).toBe('Options, Futures, and Other Derivatives Solutions Manual — Hull J')
  })
  it('strips a known document extension with no " -- " separators', () => {
    expect(sourceTitle('book.pdf')).toBe('book')
    expect(sourceTitle('notes.md')).toBe('notes')
  })
  it('turns underscore runs into spaces', () => {
    expect(sourceTitle('My_Great_Book_Notes.txt')).toBe('My Great Book Notes')
  })
  it('soft-caps at 80 chars, cutting at a word boundary with no ellipsis', () => {
    const long =
      'This is a very long document title without any double dash separators that definitely exceeds the eighty character soft cap for sure and then some more words.pdf'
    const title = sourceTitle(long)
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title).toBe('This is a very long document title without any double dash separators that')
    expect(title.endsWith('.')).toBe(false) // no ellipsis, no trailing punctuation from the cut
  })
  it('never returns empty', () => {
    expect(sourceTitle('.pdf')).not.toBe('')
  })
})

describe('renderNote', () => {
  const md = renderNote(note())

  it('puts kind + cite spans (with the quote) in frontmatter, the H1, and edges in the body', () => {
    expect(md).toMatch(
      /^---\nkind: claim\nsource: Federalist Papers\ncite:\n {2}- chunk: 10\n {4}span: 100-117\n {4}quote: "Extend the sphere"\n---/
    )
    expect(md).toContain('# Extended republic')
    expect(md).toContain('source:: [[Federalist Papers]]')
    expect(md).toContain('about:: [[Faction]]')
    expect(md).toContain('supports:: [[Representative republic]]')
    expect(md).toContain('Scale dilutes faction.')
    expect(md).toContain('> Extend the sphere')
  })

  it('names the source by the same short title in frontmatter and the body link', () => {
    const md2 = renderNote(
      note({
        citations: [
          {
            file: "Options, Futures, and Other Derivatives__ Solutions Manual -- Hull J_ -- Anna's Archive.pdf",
            chunkId: 1,
            start: 0,
            end: 5,
            quote: 'x'
          }
        ]
      })
    )
    const short = 'Options, Futures, and Other Derivatives Solutions Manual — Hull J'
    expect(md2).toContain(`source: ${short}\n`)
    expect(md2).toContain(`source:: [[${short}]]`)
  })

  it('sanitizes an unsafe relation name and normalizes link targets', () => {
    const md2 = renderNote(note({ links: [{ relation: 'is-a/kind', target: 'Pure democracy' }] }))
    expect(md2).toContain('is-a_kind:: [[Pure democracy]]')
  })

  it('JSON-escapes a quote containing quotes/newlines so it stays one YAML line', () => {
    const tricky = note({
      citations: [
        { file: 'Book.md', chunkId: 1, start: 0, end: 10, quote: 'He said "no"\nand left.' }
      ]
    })
    const md2 = renderNote(tricky)
    expect(md2).toContain('quote: "He said \\"no\\"\\nand left."')
    // Round-trips: the emitted line is valid JSON for the original quote.
    const line = /quote: (".*")/.exec(md2)![1]
    expect(JSON.parse(line)).toBe('He said "no"\nand left.')
  })
})

describe('harvest round-trip (the contract)', () => {
  it('yields the typed edges and NO cite/kind triples', () => {
    const { content } = emitNotes([note()])[0]
    const h = harvest('distill/Extended republic.md', content)
    const rels = h.triples.map((t) => `${t.relation} ${t.object}`)

    expect(h.title).toBe('Extended republic')
    expect(rels).toContain('source Federalist Papers')
    expect(rels).toContain('about Faction')
    expect(rels).toContain('supports Representative republic')
    // Frontmatter provenance must NOT become graph edges.
    expect(rels.some((r) => r.startsWith('cite'))).toBe(false)
    expect(rels.some((r) => r.startsWith('kind'))).toBe(false)
  })
})

describe('emitNotes', () => {
  it('gives every note a unique filename even on title collision', () => {
    const out = emitNotes([note({ title: 'Faction' }), note({ title: 'Faction' })])
    expect(out.map((n) => n.fileName)).toEqual(['Faction.md', 'Faction 2.md'])
  })
})
