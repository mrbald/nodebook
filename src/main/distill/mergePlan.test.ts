import { describe, it, expect } from 'vitest'
import { mergePlan, rewriteLinks, withSameAs, type RunNote, type VaultNotes } from './mergePlan'

const vault = (entries: Record<string, string>): VaultNotes => ({
  names: new Set(Object.keys(entries)),
  hashByName: new Map(Object.entries(entries))
})

const note = (name: string, hash = `h-${name}`): RunNote => ({ name, content: '', hash })

describe('mergePlan', () => {
  it('a name the vault does not have is new, under its own name', () => {
    const plan = mergePlan([note('Faction')], vault({}), 'Federalist')
    expect(plan).toEqual([{ name: 'Faction', action: 'new', targetName: 'Faction' }])
  })

  it('same name AND same bytes is identical — skipped, nothing written', () => {
    const plan = mergePlan([note('Faction', 'abc')], vault({ Faction: 'abc' }), 'Federalist')
    expect(plan[0].action).toBe('identical')
  })

  it('same name, different bytes collides — saved as "Name (Book)", never over the original', () => {
    const plan = mergePlan([note('Faction', 'abc')], vault({ Faction: 'zzz' }), 'Federalist')
    expect(plan[0]).toEqual({
      name: 'Faction',
      action: 'collides',
      targetName: 'Faction (Federalist)'
    })
  })

  it('names are compared case-insensitively (macOS/Windows would collide on disk)', () => {
    const plan = mergePlan([note('faction', 'abc')], vault({ Faction: 'zzz' }), 'Federalist')
    expect(plan[0].action).toBe('collides')
    const same = mergePlan([note('faction', 'abc')], vault({ Faction: 'abc' }), 'Federalist')
    expect(same[0].action).toBe('identical')
  })

  it('a disambiguated name that is itself taken counts up', () => {
    const plan = mergePlan(
      [note('Faction', 'abc')],
      vault({ Faction: 'zzz', 'Faction (Federalist)': 'yyy' }),
      'Federalist'
    )
    expect(plan[0].targetName).toBe('Faction (Federalist) 2')
  })

  it('two staged notes never get the same target', () => {
    const plan = mergePlan(
      [note('Faction', 'a'), note('Faction (Federalist)', 'b')],
      vault({ Faction: 'z', 'Faction (Federalist)': 'y' }),
      'Federalist'
    )
    expect(plan.map((p) => p.targetName)).toEqual([
      'Faction (Federalist) 2',
      'Faction (Federalist) (Federalist)'
    ])
    expect(new Set(plan.map((p) => p.targetName)).size).toBe(2)
  })

  it('a source title with path-hostile characters is sanitised into the name', () => {
    const plan = mergePlan([note('Faction', 'a')], vault({ Faction: 'z' }), 'A/B: The Book')
    expect(plan[0].targetName).toBe('Faction (A B The Book)')
  })

  it('plans every note in order, mixing all three outcomes', () => {
    const plan = mergePlan(
      [note('New'), note('Same', 'h'), note('Clash', 'x')],
      vault({ Same: 'h', Clash: 'other' }),
      'Book'
    )
    expect(plan.map((p) => p.action)).toEqual(['new', 'identical', 'collides'])
  })
})

describe('rewriteLinks', () => {
  const renames = new Map([['Faction', 'Faction (Federalist)']])

  it('rewrites a bare wikilink', () => {
    expect(rewriteLinks('see [[Faction]] here', renames)).toBe(
      'see [[Faction (Federalist)]] here'
    )
  })

  it('keeps the alias and the heading anchor', () => {
    expect(rewriteLinks('[[Faction|factions]]', renames)).toBe('[[Faction (Federalist)|factions]]')
    expect(rewriteLinks('[[Faction#Causes]]', renames)).toBe('[[Faction (Federalist)#Causes]]')
    expect(rewriteLinks('[[Faction#Causes|why]]', renames)).toBe(
      '[[Faction (Federalist)#Causes|why]]'
    )
  })

  it('rewrites a `key:: [[target]]` body field, which is just a wikilink', () => {
    expect(rewriteLinks('about:: [[Faction]]\n', renames)).toBe('about:: [[Faction (Federalist)]]\n')
  })

  it('leaves everything else byte-identical', () => {
    const src = '# Title\n\nsource:: [[Book]]\n\n[[Union]] and [[Liberty|air]].\n\n> a quote\n'
    expect(rewriteLinks(src, renames)).toBe(src)
  })

  it('an empty rename map is the identity', () => {
    const src = '[[Faction]]'
    expect(rewriteLinks(src, new Map())).toBe(src)
  })

  it('matches the target case-insensitively but writes the planned name', () => {
    expect(rewriteLinks('[[faction]]', renames)).toBe('[[Faction (Federalist)]]')
  })

  it('preserves padding inside the brackets', () => {
    expect(rewriteLinks('[[ Faction ]]', renames)).toBe('[[ Faction (Federalist) ]]')
  })

  it('rewrites every occurrence, not just the first', () => {
    expect(rewriteLinks('[[Faction]] x [[Faction]]', renames)).toBe(
      '[[Faction (Federalist)]] x [[Faction (Federalist)]]'
    )
  })
})

describe('withSameAs', () => {
  it('goes right after the source:: field', () => {
    const src = '---\nkind: concept\n---\n\n# Faction (Federalist)\n\nsource:: [[Federalist]]\nabout:: [[Union]]\n\nBody.\n'
    expect(withSameAs(src, 'Faction')).toBe(
      '---\nkind: concept\n---\n\n# Faction (Federalist)\n\nsource:: [[Federalist]]\nsame_as:: [[Faction]]\nabout:: [[Union]]\n\nBody.\n'
    )
  })

  it('a note with no source:: field (the book itself) gets it after the frontmatter', () => {
    expect(withSameAs('---\nkind: document\n---\n# Book\n', 'Book')).toBe(
      '---\nkind: document\n---\nsame_as:: [[Book]]\n# Book\n'
    )
  })

  it('plain text with no frontmatter gets it as the first line', () => {
    expect(withSameAs('# Book\n\ntext\n', 'Book')).toBe('same_as:: [[Book]]\n# Book\n\ntext\n')
  })
})
