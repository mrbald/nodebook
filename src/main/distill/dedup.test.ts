import { describe, it, expect } from 'vitest'
import { dedup, trigramSimilarity } from './dedup'
import type { GroundedNote } from './extract'

const note = (over: Partial<GroundedNote> = {}): GroundedNote => ({
  kind: 'concept',
  title: 'Faction',
  summary: 's',
  links: [],
  citations: [{ file: 'Book.md', chunkId: 1, start: 0, end: 50, quote: 'q' }],
  ...over
})

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and high for singular/plural', () => {
    expect(trigramSimilarity('Faction', 'Faction')).toBe(1)
    expect(trigramSimilarity('Faction', 'Factions')).toBeGreaterThan(0.5)
  })
  it('is low for unrelated strings and 1 for two empties', () => {
    expect(trigramSimilarity('Faction', 'Monarchy')).toBeLessThan(0.2)
    expect(trigramSimilarity('', '')).toBe(1)
  })
})

describe('dedup', () => {
  it('merges identical-title notes, unioning citations and links', () => {
    const a = note({
      links: [{ relation: 'about', target: 'Republic' }],
      citations: [{ file: 'Book.md', chunkId: 1, start: 0, end: 50, quote: 'q1' }]
    })
    const b = note({
      links: [{ relation: 'contrasts_with', target: 'Monarchy' }],
      citations: [{ file: 'Book.md', chunkId: 9, start: 900, end: 950, quote: 'q2' }]
    })
    const { notes, merged } = dedup([a, b])
    expect(merged).toBe(1)
    expect(notes.length).toBe(1)
    expect(notes[0].citations.map((c) => c.chunkId).sort()).toEqual([1, 9])
    expect(notes[0].links.map((l) => l.target).sort()).toEqual(['Monarchy', 'Republic'])
  })

  it('does not merge different titles that cite the same span', () => {
    // One passage supports several items — the person and the term they
    // coined, `shape` and `dtype` from one sentence. A shared quote is
    // relatedness, never identity (see the module header).
    const a = note({ title: 'Hadley Wickham', kind: 'entity' })
    const b = note({ title: 'split-apply-combine' }) // same citation span as `a`
    const { notes, merged } = dedup([a, b])
    expect(merged).toBe(0)
    expect(notes.length).toBe(2)
  })

  it('keeps genuinely distinct notes separate', () => {
    const a = note({ title: 'Faction', citations: [{ file: 'Book.md', chunkId: 1, start: 0, end: 50, quote: 'q' }] })
    const b = note({ title: 'Separation of powers', citations: [{ file: 'Book.md', chunkId: 2, start: 500, end: 560, quote: 'q' }] })
    expect(dedup([a, b]).notes.length).toBe(2)
  })

  it('keeps the better-grounded title and does not mutate inputs', () => {
    const sparse = note({ title: 'hierarchical indexing', citations: [{ file: 'Book.md', chunkId: 1, start: 0, end: 50, quote: 'q' }] })
    const grounded = note({
      title: 'Hierarchical Indexing',
      citations: [
        { file: 'Book.md', chunkId: 1, start: 0, end: 50, quote: 'q' },
        { file: 'Book.md', chunkId: 2, start: 60, end: 90, quote: 'q' }
      ]
    })
    const { notes } = dedup([sparse, grounded])
    expect(notes[0].title).toBe('Hierarchical Indexing') // more citations wins
    expect(sparse.citations.length).toBe(1) // input untouched
  })

  it('honours the optional similarity hook and a lower title threshold', () => {
    const a = note({ title: 'Republic' })
    const b = note({ title: 'Commonwealth', citations: [{ file: 'Book.md', chunkId: 5, start: 500, end: 560, quote: 'q' }] })
    // Distinct titles + spans → separate by default...
    expect(dedup([a, b]).notes.length).toBe(2)
    // ...but an embedding-cosine hook can still merge them.
    expect(dedup([a, b], { similarity: () => 0.95 }).merged).toBe(1)
  })

  it('is deterministic', () => {
    const xs = [note({ title: 'Faction' }), note({ title: 'Faction' }), note({ title: 'Liberty' })]
    expect(dedup(xs)).toEqual(dedup(xs))
  })
})

describe('dedup aliases', () => {
  const cite = (start: number, end: number, quote = 'q'): GroundedNote['citations'][0] => ({
    file: 'Book.md',
    chunkId: 1,
    start,
    end,
    quote
  })

  it('is empty when nothing merged', () => {
    const { aliases } = dedup([note({ title: 'Faction' }), note({ title: 'Separation of powers', citations: [cite(500, 560)] })])
    expect(aliases.size).toBe(0)
  })

  it('maps an absorbed title to the surviving one', () => {
    const { notes, aliases } = dedup([
      note({ title: 'The hierarchical indexing', citations: [cite(0, 50)] }),
      note({ title: 'Hierarchical indexing', citations: [cite(100, 150)] })
    ])
    expect(notes[0].title).toBe('Hierarchical indexing') // the sharper title survives
    expect(aliases.get('The hierarchical indexing')).toBe('Hierarchical indexing')
    expect(aliases.has('Hierarchical indexing')).toBe(false) // a surviving title is never an alias
  })

  it('follows a chain: an earlier title lands on the FINAL surviving title', () => {
    // The accumulator is renamed twice: 'The hierarchical indexing' →
    // 'Hierarchical indexing' (sharper) → 'hierarchical indexing' (better
    // grounded). Both lost titles must point at the last.
    const { notes, aliases } = dedup([
      note({ title: 'The hierarchical indexing', citations: [cite(0, 50)] }),
      note({ title: 'Hierarchical indexing', citations: [cite(100, 150)] }),
      note({ title: 'hierarchical indexing', citations: [cite(200, 250, 'q2'), cite(300, 340), cite(400, 440)] })
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('hierarchical indexing')
    expect(aliases.get('The hierarchical indexing')).toBe('hierarchical indexing')
    expect(aliases.get('Hierarchical indexing')).toBe('hierarchical indexing')
  })

  it('never aliases away a title another surviving note still carries', () => {
    // 'Alpha' is absorbed here (an embedding hook says so), but a later note
    // keeps that exact title and the hook does not fire for it — a link to
    // 'Alpha' must find THAT note, not be redirected to this group.
    const { notes, aliases } = dedup(
      [
        note({ title: 'Alpha', citations: [cite(0, 50)] }),
        note({ title: 'Beta', citations: [cite(0, 50)] }),
        note({ title: 'Alpha', citations: [cite(500, 560)] })
      ],
      { similarity: (_a, b) => (b.title === 'Beta' ? 0.95 : 0) }
    )
    expect(notes.map((n) => n.title)).toEqual(['Beta', 'Alpha'])
    expect(aliases.size).toBe(0)
  })
})
