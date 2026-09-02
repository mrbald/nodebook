import { describe, it, expect } from 'vitest'
import { mergePlan, rewriteLinks, rewriteSourceField, rewriteThemeMembers, withSameAs, type RunNote, type VaultNotes, confirmedSameAs, twinOf } from './mergePlan'

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

describe('rewriteSourceField', () => {
  const renames = new Map([['Federalist', 'Federalist 2']])
  const note = (fm: string): string => `---\nkind: concept\n${fm}cite:\n  - chunk: 1\n---\n\n# Faction\n\nsource:: [[Federalist]]\n`

  it('follows the document to the name it actually landed under', () => {
    expect(rewriteSourceField(note('source: Federalist\n'), renames)).toContain(
      '\nsource: Federalist 2\n'
    )
  })

  it('leaves a line naming something else exactly as it was', () => {
    const other = note('source: Another Book\n')
    expect(rewriteSourceField(other, renames)).toBe(other)
    expect(rewriteSourceField(note('source: Federalist\n'), new Map())).toBe(
      note('source: Federalist\n')
    )
  })

  it('takes the whole line as one name — a title may contain commas', () => {
    const src = '---\nsource: Options, Futures\n---\n\n# X\n'
    expect(rewriteSourceField(src, new Map([['Options, Futures', 'Options, Futures 2']]))).toBe(
      '---\nsource: Options, Futures 2\n---\n\n# X\n'
    )
  })

  it('touches only the frontmatter — a `source:` line in the prose is the author\'s', () => {
    const src = '---\nkind: concept\n---\n\n# X\n\nsource: Federalist\n'
    expect(rewriteSourceField(src, renames)).toBe(src)
  })

  it('leaves a note with no frontmatter alone', () => {
    expect(rewriteSourceField('# X\n\nsource: Federalist\n', renames)).toBe(
      '# X\n\nsource: Federalist\n'
    )
  })
})

describe('rewriteThemeMembers', () => {
  const renames = new Map([['Faction', 'Faction (Federalist)']])
  const theme = (members: string[]): string =>
    `---\nkind: theme\nsource: Federalist\n---\n\n# Checks on power\n\nsource:: [[Federalist]]\n\n${members
      .map((m) => `- ${m}`)
      .join('\n')}\n`

  it('follows a member that the merge renamed', () => {
    expect(rewriteThemeMembers(theme(['Faction', 'Union']), renames)).toBe(
      theme(['Faction (Federalist)', 'Union'])
    )
  })

  it('leaves every other note alone — only a theme note lists members', () => {
    const concept = '---\nkind: concept\n---\n\n# X\n\n- Faction\n'
    expect(rewriteThemeMembers(concept, renames)).toBe(concept)
    expect(rewriteThemeMembers('- Faction\n', renames)).toBe('- Faction\n')
  })

  it('only rewrites a bullet that is exactly a renamed name', () => {
    const src = theme(['Faction and Union', 'Faction'])
    expect(rewriteThemeMembers(src, renames)).toBe(theme(['Faction and Union', 'Faction (Federalist)']))
  })
})

describe('confirmedSameAs', () => {
  const entry = (name: string, action: 'new' | 'identical' | 'collides', sameAsCandidate?: string) => ({
    name,
    action,
    targetName: action === 'collides' ? `${name} (Book)` : name,
    ...(sameAsCandidate ? { sameAsCandidate } : {})
  })

  it('names the twin a confirmation points at', () => {
    expect(twinOf(entry('Union', 'collides'))).toBe('Union')
    expect(twinOf(entry('Union', 'new', 'Federal union'))).toBe('Federal union')
    expect(twinOf(entry('Union', 'new'))).toBeUndefined()
    expect(twinOf(entry('Union', 'identical'))).toBeUndefined()
  })

  it('keeps a tick whose twin is still the entry\'s twin, bare or explicit', () => {
    const entries = [entry('Union', 'collides'), entry('Faction', 'new', 'Party spirit')]
    expect(confirmedSameAs(entries, ['union', { name: 'Faction', twin: 'Party spirit' }])).toEqual([
      { name: 'Union', twin: 'Union' },
      { name: 'Faction', twin: 'Party spirit' }
    ])
  })

  it('drops a tick when the plan changed under the dialog', () => {
    // Shown as new-with-twin; by merge time a vault note called "Faction"
    // exists, so the entry is a clash with a stranger. The tick said
    // "same as Party spirit" — it must not become "same as Faction".
    const now = [entry('Faction', 'collides')]
    expect(confirmedSameAs(now, [{ name: 'Faction', twin: 'Party spirit' }])).toEqual([])
    // A bare name on a new entry with no twin, or an unknown name: nothing.
    expect(confirmedSameAs([entry('Faction', 'new')], ['Faction', 'Ghost'])).toEqual([])
  })
})
