import { describe, it, expect } from 'vitest'
import {
  clusterNotes,
  parseThemeNames,
  themeK,
  themeNameOf,
  themeNamingPrompt,
  MAX_THEMES,
  MIN_THEMES
} from './themes'
import { attachThemes, renderThemeNote, type EmittedNote } from './emit'

/** A unit vector pointing along axis `axis`, nudged by `jitter` so members of
 *  one group are close but not identical. */
function vec(axis: number, jitter = 0, dims = 4): Float32Array {
  const v = new Float32Array(dims)
  v[axis] = 1
  v[(axis + 1) % dims] = jitter
  return v
}

describe('themeK', () => {
  it('is about the square root of the note count', () => {
    expect(themeK(9)).toBe(3)
    expect(themeK(36)).toBe(6)
    expect(themeK(100)).toBe(10)
  })

  it('clamps to [3, 16] and never exceeds the note count', () => {
    expect(themeK(6)).toBe(MIN_THEMES) // √6 ≈ 2.4, floored at the minimum
    expect(themeK(10_000)).toBe(MAX_THEMES)
    expect(themeK(2)).toBe(2) // fewer notes than the minimum → one each
    expect(themeK(0)).toBe(0)
  })
})

describe('clusterNotes', () => {
  const vectors = [
    vec(0, 0.1), vec(0, 0.2), vec(0, 0.15),
    vec(1, 0.1), vec(1, 0.2), vec(1, 0.15),
    vec(2, 0.1), vec(2, 0.2), vec(2, 0.15)
  ]

  it('groups notes by direction, every note in exactly one theme', () => {
    const clusters = clusterNotes(vectors)
    expect(clusters.length).toBe(themeK(vectors.length))
    const seen = clusters.flatMap((c) => c.members).sort((a, b) => a - b)
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    // The three notes of one topic land together.
    for (const group of [[0, 1, 2], [3, 4, 5], [6, 7, 8]])
      expect(clusters.some((c) => c.members.join() === group.join())).toBe(true)
  })

  it('names a medoid that is one of the theme members', () => {
    for (const c of clusterNotes(vectors)) expect(c.members).toContain(c.medoid)
  })

  it('is deterministic — same vectors, same themes', () => {
    expect(clusterNotes(vectors)).toEqual(clusterNotes(vectors))
  })

  it('does not need the caller to normalise: scale carries no meaning', () => {
    const scaled = vectors.map((v) => Float32Array.from(v, (x) => x * 17))
    expect(clusterNotes(scaled)).toEqual(clusterNotes(vectors))
  })

  it('honours an explicit k, capped at the note count', () => {
    expect(clusterNotes(vectors, { k: 2 }).length).toBe(2)
    expect(clusterNotes(vectors.slice(0, 2), { k: 9 }).length).toBe(2)
    expect(clusterNotes([])).toEqual([])
  })
})

describe('themeNamingPrompt', () => {
  const clusters = [
    { members: [{ title: 'Faction', summary: 'A number of citizens.' }] },
    { members: [{ title: 'Union', summary: 'A firm union.' }, { title: 'Liberty', summary: '' }] }
  ]

  it('asks for one JSON name per indexed group, in the source language', () => {
    const { system, user } = themeNamingPrompt(clusters)
    expect(system).toContain('"themes"')
    expect(system).toContain('2 to 4 words')
    expect(system).toContain('SAME LANGUAGE')
    expect(user).toContain('[theme 0]')
    expect(user).toContain('[theme 1]')
    expect(user).toContain('- Faction')
    expect(user).toContain('- Liberty')
  })

  it('lists each member title with its summary under it', () => {
    const { user } = themeNamingPrompt(clusters)
    expect(user).toContain('- Faction\n  A number of citizens.')
    // A member with no summary is still listed, on its own line.
    expect(user).toContain('- Liberty')
  })
})

describe('parseThemeNames', () => {
  it('reads names by index, through fences and prose', () => {
    const raw = 'Sure!\n```json\n{"themes":[{"index":1,"name":"Checks on power"},{"index":0,"name":"Faction and interest"}]}\n```'
    expect(parseThemeNames(raw, 2)).toEqual({
      ok: true,
      names: ['Faction and interest', 'Checks on power']
    })
  })

  it('falls back to array position when the model omits the index', () => {
    const raw = '{"themes":[{"name":"One"},{"name":"Two"}]}'
    expect(parseThemeNames(raw, 2).names).toEqual(['One', 'Two'])
  })

  it('leaves a group the model skipped null, for the caller to name', () => {
    const raw = '{"themes":[{"index":0,"name":"One"}]}'
    expect(parseThemeNames(raw, 3).names).toEqual(['One', null, null])
  })

  it('ignores out-of-range indexes and unusable entries', () => {
    const raw = '{"themes":[{"index":9,"name":"Nope"},{"index":0,"name":""},null,{"index":1,"name":"Yes"}]}'
    const { ok, names } = parseThemeNames(raw, 2)
    expect(ok).toBe(true)
    expect(names).toEqual([null, 'Yes'])
  })

  it('is not ok when there is no JSON object at all — that earns a repair retry', () => {
    expect(parseThemeNames('I cannot do that.', 2)).toEqual({ ok: false, names: [null, null] })
    expect(parseThemeNames('{oops', 1).ok).toBe(false)
    expect(parseThemeNames('{"items":[]}', 1).ok).toBe(false)
  })

  it('collapses whitespace and caps a run-on name', () => {
    const long = 'x'.repeat(200)
    expect(parseThemeNames(`{"themes":[{"index":0,"name":" Two   words "}]}`, 1).names[0]).toBe(
      'Two words'
    )
    expect((parseThemeNames(`{"themes":[{"index":0,"name":"${long}"}]}`, 1).names[0] ?? '').length)
      .toBeLessThanOrEqual(60)
  })
})

describe('themeNameOf', () => {
  const titles = ['Faction', 'Union', 'Liberty']
  const cluster = { members: [0, 1, 2], medoid: 1 }

  it('keeps the model name when there is one', () => {
    expect(themeNameOf(cluster, titles, 'Checks on power')).toBe('Checks on power')
  })

  it('falls back to the medoid note title', () => {
    expect(themeNameOf(cluster, titles, null)).toBe('Union')
  })
})

describe('renderThemeNote', () => {
  const md = renderThemeNote({
    name: 'Checks on power',
    members: ['Faction', 'Union'],
    sourceName: 'On Government'
  })

  it('is a kind: theme note that cites the book', () => {
    expect(md.startsWith('---\nkind: theme\nsource: On Government\n---\n')).toBe(true)
    expect(md).toContain('source:: [[On Government]]')
    expect(md).toContain('# Checks on power')
  })

  it('lists every member as plain text — one membership is one edge', () => {
    expect(md).toContain('- Faction')
    expect(md).toContain('- Union')
    // A wikilink here would be a second, opposite edge on top of the member's
    // own `part_of::` — two arrows per membership on the map.
    expect(md).not.toContain('[[Faction]]')
    expect(md).not.toContain('[[Union]]')
    // The book is still a link: that one IS the theme note's own edge.
    expect(md).toContain('source:: [[On Government]]')
  })
})

describe('attachThemes', () => {
  const note = (name: string, body: string): EmittedNote => ({
    name,
    fileName: `${name}.md`,
    content: body
  })
  const withFields = note(
    'Faction',
    '---\nkind: concept\n---\n\n# Faction\n\nsource:: [[Book]]\nabout:: [[Union]]\n\nA summary.\n\n> a quote\n'
  )
  const bare = note('Union', '---\nkind: concept\n---\n\n# Union\n\nA summary.\n')

  it('adds part_of after the note’s existing fields', () => {
    const { notes, added } = attachThemes(
      [withFields],
      new Map([['Faction', 'Checks on power']])
    )
    expect(added).toBe(1)
    expect(notes[0].content).toContain('about:: [[Union]]\npart_of:: [[Checks on power]]\n')
    // Nothing else moved.
    expect(notes[0].content).toContain('> a quote')
    expect(notes[0].name).toBe('Faction')
  })

  it('opens a field block on a note that has none', () => {
    const { notes } = attachThemes([bare], new Map([['Union', 'A theme']]))
    expect(notes[0].content).toContain('# Union\n\npart_of:: [[A theme]]\n\nA summary.')
  })

  it('leaves an unassigned note untouched', () => {
    const { notes, added } = attachThemes([withFields, bare], new Map([['Faction', 'T']]))
    expect(added).toBe(1)
    expect(notes[1]).toBe(bare)
  })

  it('never links a note to itself', () => {
    const { notes, added } = attachThemes([bare], new Map([['Union', 'Union']]))
    expect(added).toBe(0)
    expect(notes[0].content).not.toContain('part_of')
  })
})
