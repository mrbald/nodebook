import { describe, it, expect } from 'vitest'
import {
  linkNotes,
  resolveTarget,
  countComponents,
  isMentionable,
  findMention,
  noteName,
  type LinkableNote
} from './link'

const n = (name: string, over: Partial<LinkableNote> = {}): LinkableNote => ({
  title: name,
  name,
  summary: '',
  quotes: [],
  links: [],
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

describe('resolveTarget', () => {
  const names = ['Faction', 'Extended republic']

  it('resolves a target already spelled as an emitted name', () => {
    expect(resolveTarget('Faction', names)).toBe('Faction')
    expect(resolveTarget('  Faction  ', names)).toBe('Faction')
  })

  it('resolves a target through the title → name map', () => {
    const nameOf = new Map([['Book', 'Book 2']])
    expect(resolveTarget('Book', ['Book 2'], { nameOf })).toBe('Book 2')
  })

  it('follows an alias chain to the surviving title', () => {
    const aliases = new Map([
      ['Factions', 'Faction group'],
      ['Faction group', 'Faction']
    ])
    expect(resolveTarget('Factions', names, { aliases })).toBe('Faction')
  })

  it('does not hang on a cyclic alias map', () => {
    const aliases = new Map([
      ['a', 'b'],
      ['b', 'a']
    ])
    expect(resolveTarget('a', names, { aliases })).toBeNull()
  })

  it('snaps a near-miss to the closest name and leaves a distant one a ghost', () => {
    expect(resolveTarget('Extended republics', names)).toBe('Extended republic')
    expect(resolveTarget('Monarchy', names)).toBeNull()
  })

  it('takes the closest of two names that both clear the bar', () => {
    const both = ['Extended republican', 'Extended republic']
    expect(resolveTarget('Extended republics', both)).toBe('Extended republic')
  })

  it('never guesses below the threshold, but honours a caller-set one', () => {
    expect(resolveTarget('Factions', names)).toBeNull()
    expect(resolveTarget('Factions', names, { snap: 0.6 })).toBe('Faction')
  })
})

describe('linkNotes — remapping', () => {
  it('remaps a target that dedup renamed away', () => {
    const notes = [
      n('Faction'),
      n('Extended republic', { links: [{ relation: 'about', target: 'Factions' }] })
    ]
    const r = linkNotes(notes, { aliases: new Map([['Factions', 'Faction']]) })
    expect(r.links[1]).toEqual([{ relation: 'about', target: 'Faction' }])
    expect(r.ghostLinks).toBe(0)
  })

  it('remaps a target that emit de-collided with a " 2" suffix', () => {
    const notes = [
      { ...n('Book'), name: 'Book 2' },
      n('Faction', { links: [{ relation: 'about', target: 'Book' }] })
    ]
    const r = linkNotes(notes)
    expect(r.links[1]).toEqual([{ relation: 'about', target: 'Book 2' }])
    expect(r.ghostLinks).toBe(0)
  })

  it('snaps a near-miss target onto the emitted note', () => {
    const notes = [
      n('Extended republic'),
      n('Faction', { links: [{ relation: 'about', target: 'Extended republics' }] })
    ]
    const r = linkNotes(notes)
    expect(r.links[1]).toEqual([{ relation: 'about', target: 'Extended republic' }])
    expect(r.ghostLinks).toBe(0)
  })

  it('keeps an unresolvable target as a ghost and counts it', () => {
    const notes = [n('Faction', { links: [{ relation: 'about', target: 'Monarchy' }] })]
    const r = linkNotes(notes)
    expect(r.links[0]).toEqual([{ relation: 'about', target: 'Monarchy' }])
    expect(r.ghostLinks).toBe(1)
    expect(r.edges).toBe(1)
  })

  it('drops a self-link and collapses duplicate links', () => {
    const notes = [
      n('Faction', {
        links: [
          { relation: 'about', target: 'Factions' },
          { relation: 'about', target: 'Faction' },
          { relation: 'about', target: 'Union' },
          { relation: 'about', target: 'Union' }
        ]
      }),
      n('Union')
    ]
    const r = linkNotes(notes, { aliases: new Map([['Factions', 'Faction']]), mentions: false })
    expect(r.links[0]).toEqual([{ relation: 'about', target: 'Union' }])
    expect(r.ghostLinks).toBe(0)
  })
})

describe('linkNotes — mention linking', () => {
  it('links a note whose summary names another note', () => {
    const notes = [
      n('Faction', { summary: 'The extended republic dilutes it.' }),
      n('Extended republic')
    ]
    const r = linkNotes(notes)
    expect(r.links[0]).toEqual([{ relation: 'mentions', target: 'Extended republic' }])
    expect(r.mentions).toBe(1)
  })

  it('reads the quotes as well as the summary', () => {
    const notes = [
      n('Faction', { quotes: ['Ambition must counteract ambition, said Madison.'] }),
      n('Madison')
    ]
    expect(linkNotes(notes).links[0]).toEqual([{ relation: 'mentions', target: 'Madison' }])
  })

  it('needs a word boundary, not a substring', () => {
    const notes = [n('Faction', { summary: 'The Unionist party met.' }), n('Union')]
    expect(linkNotes(notes).links[0]).toEqual([])
  })

  it('matches case-insensitively', () => {
    const notes = [n('Liberty', { summary: 'Every faction wants it.' }), n('Faction')]
    expect(linkNotes(notes).links[0]).toEqual([{ relation: 'mentions', target: 'Faction' }])
  })

  it('works word-bounded in a non-Latin script', () => {
    const notes = [n('Дао', { summary: 'Здесь описана Фракция и её причины.' }), n('Фракция')]
    expect(linkNotes(notes).links[0]).toEqual([{ relation: 'mentions', target: 'Фракция' }])
  })

  it('ignores a name too generic to link on sight', () => {
    // One lowercase word, and one capitalised word under four letters.
    const notes = [n('Liberty', { summary: 'A use of the war power.' }), n('use'), n('War')]
    expect(linkNotes(notes).links[0]).toEqual([])
  })

  it('never links a note to itself', () => {
    const notes = [n('Extended republic', { summary: 'The extended republic is large.' })]
    const r = linkNotes(notes)
    expect(r.links[0]).toEqual([])
    expect(r.mentions).toBe(0)
  })

  it('does not duplicate a link the model already made', () => {
    const notes = [
      n('Faction', {
        summary: 'The extended republic dilutes it.',
        links: [{ relation: 'about', target: 'Extended republic' }]
      }),
      n('Extended republic')
    ]
    const r = linkNotes(notes)
    expect(r.links[0]).toEqual([{ relation: 'about', target: 'Extended republic' }])
    expect(r.mentions).toBe(0)
  })

  it('caps at 8 mentions, keeping the earliest occurrences in order', () => {
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
    const mentioned = [...words].reverse().map((w) => `Concept ${w}`)
    const notes = [n('Hub note', { summary: mentioned.join(', ') }), ...mentioned.map((m) => n(m))]
    const r = linkNotes(notes)
    expect(r.links[0].map((l) => l.target)).toEqual(mentioned.slice(0, 8))
    expect(r.mentions).toBe(8)
  })

  it('can be turned off', () => {
    const notes = [
      n('Faction', { summary: 'The extended republic dilutes it.' }),
      n('Extended republic')
    ]
    expect(linkNotes(notes, { mentions: false }).mentions).toBe(0)
  })
})

describe('isMentionable / findMention', () => {
  it('accepts two words, or one capitalised word of four letters or more', () => {
    expect(isMentionable('Extended republic')).toBe(true)
    expect(isMentionable('Faction')).toBe(true)
    expect(isMentionable('Фракция')).toBe(true)
    expect(isMentionable('War')).toBe(false)
    expect(isMentionable('faction')).toBe(false)
    expect(isMentionable('')).toBe(false)
  })

  it('finds the first word-bounded occurrence, or -1', () => {
    expect(findMention('a Faction here', 'faction')).toBe(2)
    expect(findMention('Factions only', 'Faction')).toBe(-1)
    expect(findMention('short', 'much longer needle')).toBe(-1)
    expect(findMention('Factions, then Faction.', 'Faction')).toBe(15)
  })
})

describe('countComponents', () => {
  it('counts islands, reading links as undirected and ignoring ghosts', () => {
    const names = ['A', 'B', 'C']
    expect(countComponents(names, [[{ relation: 'about', target: 'B' }], [], []])).toBe(2)
    expect(countComponents(names, [[{ relation: 'about', target: 'Ghost' }], [], []])).toBe(3)
    expect(countComponents([], [])).toBe(0)
  })

  it('is reported by linkNotes over the final links', () => {
    const notes = [
      n('A', { links: [{ relation: 'about', target: 'B' }] }),
      n('B'),
      n('C', { links: [{ relation: 'about', target: 'Nowhere' }] })
    ]
    const r = linkNotes(notes)
    expect(r.components).toBe(2)
    expect(r.ghostLinks).toBe(1)
    expect(r.edges).toBe(2)
  })
})
