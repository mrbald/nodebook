import { describe, it, expect } from 'vitest'
import { noteGist, unionCitations } from './twins'
import type { NoteCitation } from './citations'

const DISTILLED = [
  '---',
  'kind: concept',
  'source: on-government',
  'cite:',
  '  - chunk: 0',
  '    span: 10-40',
  '    quote: "Faction arises from property."',
  '---',
  '',
  '# Faction',
  '',
  'source:: [[on-government]]',
  'part_of:: [[Government]]',
  '',
  'Faction grows where property is shared unequally, and it is a cost of [[Liberty|liberty]].',
  '',
  '> Faction arises from the unequal distribution of property among the citizens.',
  ''
].join('\n')

describe('noteGist', () => {
  it('reads a distilled note as its summary and its quotes', () => {
    const gist = noteGist(DISTILLED)
    expect(gist.summary).toBe(
      'Faction grows where property is shared unequally, and it is a cost of liberty.'
    )
    expect(gist.quotes).toEqual([
      'Faction arises from the unequal distribution of property among the citizens.'
    ])
  })

  it('reads a hand-written note with no frontmatter and no fields', () => {
    const gist = noteGist('# My note\n\nA first paragraph.\n\nA second one.\n')
    expect(gist.summary).toBe('A first paragraph. A second one.')
    expect(gist.quotes).toEqual([])
  })

  it('a note with only a title says nothing', () => {
    expect(noteGist('---\nkind: note\n---\n\n# Alone\n')).toEqual({ summary: '', quotes: [] })
  })

  it('stops the summary at about four hundred characters', () => {
    const long = `${'word '.repeat(200)}end.`
    const gist = noteGist(`# Long\n\n${long}\n`)
    expect(gist.summary.length).toBe(400)
    expect(gist.summary.endsWith('…')).toBe(true)
  })

  it('a long quote is shortened to one line', () => {
    const gist = noteGist(`# Q\n\n> ${'a'.repeat(200)}\n`)
    expect(gist.quotes[0].length).toBe(90)
    expect(gist.quotes[0].endsWith('…')).toBe(true)
  })
})

const cite = (over: Partial<NoteCitation> = {}): NoteCitation => ({
  source: 'on-government',
  chunk: 0,
  start: 10,
  end: 40,
  ...over
})

describe('unionCitations', () => {
  it('keeps the note own citations first and labels each twin', () => {
    const out = unionCitations(
      [cite({ quote: 'mine' })],
      [{ name: 'Faction (Book)', citations: [cite({ start: 90, end: 120, quote: 'theirs' })] }]
    )
    expect(out.map((c) => [c.quote, c.from])).toEqual([
      ['mine', undefined],
      ['theirs', 'Faction (Book)']
    ])
  })

  it('the same passage cited by both is shown once, unlabelled', () => {
    const out = unionCitations(
      [cite({ quote: 'shared' })],
      [{ name: 'Twin', citations: [cite({ start: 999, end: 1200, quote: 'shared' })] }]
    )
    expect(out).toHaveLength(1)
    expect(out[0].from).toBeUndefined()
    expect(out[0].start).toBe(10)
  })

  it('two quoteless citations from one book stay two, told apart by their spans', () => {
    const out = unionCitations(
      [],
      [
        { name: 'Twin', citations: [cite({ start: 1, end: 5 }), cite({ start: 6, end: 9 })] },
        { name: 'Other', citations: [cite({ start: 1, end: 5 })] }
      ]
    )
    expect(out.map((c) => [c.start, c.from])).toEqual([
      [1, 'Twin'],
      [6, 'Twin']
    ])
  })
})
