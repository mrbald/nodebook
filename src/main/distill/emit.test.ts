import { describe, it, expect } from 'vitest'
import { noteName, renderNote, emitNotes } from './emit'
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

describe('renderNote', () => {
  const md = renderNote(note())

  it('puts kind + cite spans in frontmatter, the H1, and edges in the body', () => {
    expect(md).toMatch(/^---\nkind: claim\nsource: Federalist Papers\ncite:\n {2}- chunk: 10\n {4}span: 100-117\n---/)
    expect(md).toContain('# Extended republic')
    expect(md).toContain('source:: [[Federalist Papers]]')
    expect(md).toContain('about:: [[Faction]]')
    expect(md).toContain('supports:: [[Representative republic]]')
    expect(md).toContain('Scale dilutes faction.')
    expect(md).toContain('> Extend the sphere')
  })

  it('sanitizes an unsafe relation name and normalizes link targets', () => {
    const md2 = renderNote(note({ links: [{ relation: 'is-a/kind', target: 'Pure democracy' }] }))
    expect(md2).toContain('is-a_kind:: [[Pure democracy]]')
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
