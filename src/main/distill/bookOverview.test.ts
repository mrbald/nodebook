import { describe, expect, it } from 'vitest'
import { buildGraph, DEFAULT_GRAPH_CAP, noteName, type GraphRows } from '../graph'
import { harvest } from '../harvest'
import type { NoteKind } from '../../shared/types'
import { projectBook } from './bookOverview'

const path = (name: string): string => `/run/notes/${name}.md`

function stagedBook(): {
  rows: GraphRows
  file: (name: string, kind?: NoteKind) => string
  link: (from: string, relation: string, to: string) => void
  theme: (name: string, members: number) => string[]
  pad: (count: number) => void
} {
  const rows: GraphRows = { files: [], triples: [] }
  const file = (name: string, kind: NoteKind = 'concept'): string => {
    const id = path(name)
    rows.files.push({ path: id, title: null, kind })
    return id
  }
  const link = (from: string, relation: string, to: string): void => {
    rows.triples.push({ subject: noteName(from), source_file: from, relation, object: to })
    if (!['links_to', 'part_of', 'source', 'same_as'].includes(relation)) {
      rows.triples.push({ subject: noteName(from), source_file: from, relation: 'links_to', object: to })
    }
  }
  const theme = (name: string, members: number): string[] => {
    link(file(name, 'theme'), 'source', 'Book')
    return Array.from({ length: members }, (_, i) => {
      const member = file(`${name}-${i}`)
      link(member, 'part_of', name)
      return member
    })
  }
  const pad = (count: number): void => {
    for (let i = 0; i < count; i++) file(`Unassigned-${i}`)
  }
  file('Book', 'document')
  return { rows, file, link, theme, pad }
}

describe('staged book projection', () => {
  it('counts confirmed cross-theme links even when an ambiguous spelling was seen first', () => {
    const { rows, file, link, pad, theme } = stagedBook()
    const [origin] = theme('First', 1)
    theme('Second', 1)
    for (const folder of ['left', 'right']) link(file(`${folder}/Twin`), 'part_of', 'Second')
    const alias = file('Alias')
    link(alias, 'same_as', 'Twin')
    link(origin, 'cites', 'Twin')
    link(origin, 'supports', 'Alias')
    pad(200)
    const before = projectBook(rows).overview!
    expect(before.links).toEqual([])
    expect(before.unassignedCount).toBe(201)
    expect(projectBook(rows).linkEvidence(path('First'), path('Second'))).toBeNull()
    link(origin, 'cites', 'left/Twin')
    const projection = projectBook(rows)
    expect(projection.overview?.links).toEqual([
      { source: path('First'), target: path('Second'), count: 1, strong: true }
    ])
    expect(projection.linkEvidence(path('First'), path('Second'))?.pairs).toEqual([{
      source: { id: origin, title: 'First-0' },
      target: { id: path('left/Twin'), title: 'Twin' },
      relationships: [{ source: origin, target: path('left/Twin'), relation: 'cites' }]
    }])
  })

  it('offers an overview for themed books on either side of the graph cap', () => {
    const { rows, file, link, theme, pad } = stagedBook()
    pad(DEFAULT_GRAPH_CAP + 1)
    expect(projectBook(rows).overview).toBeNull()
    const small = stagedBook()
    small.theme('A', 98)
    small.theme('B', 102)
    const smallBook = projectBook(small.rows)
    expect(smallBook.overview).toMatchObject({ noteCount: 200, unassignedCount: 0 })
    expect(smallBook.overview?.themes.map((t) => t.count)).toEqual([98, 102])
    expect(smallBook.themeOf(path('A-0'))).toEqual({ id: path('A'), label: 'A' })
    expect(smallBook.themeGraph(path('A'))?.total).toBe(98)
    expect(smallBook.themeDetails(path('A'))).toEqual({ subthemes: [], remainder: null })
    small.file('Isolated')
    expect(projectBook(small.rows).overview).toMatchObject({
      themes: [
        { id: path('A'), label: 'A', count: 98 },
        { id: path('B'), label: 'B', count: 102 }
      ],
      links: [],
      noteCount: 201,
      unassignedCount: 1
    })
    file('No source', 'theme')
    theme('Valid', 0)
    theme('Also valid', 0)
    expect(projectBook(rows).overview).toBeNull()
    link(file('Member'), 'part_of', 'Valid')
    expect(projectBook(rows).overview?.themes.map(({ count }) => count)).toEqual([0, 1])
    file('Ambiguous book anchor', 'document')
    expect(projectBook(rows).overview).toBeNull()
  })

  it('validates structural edges while keeping canonical aliases and directed member relations', () => {
    const { rows, file, link, theme, pad } = stagedBook()
    const [a, b] = theme('A', 2)
    const [c] = theme('B', 1)
    theme('Empty', 0)
    const stale = file('Stale', 'theme')
    link(stale, 'source', 'Missing document')
    link(file('Wrong book'), 'part_of', 'Stale')
    const wrongWay = file('Wrong way')
    link(path('A'), 'part_of', 'Wrong way')
    link(wrongWay, 'about', 'A')
    const conflicting = file('Conflicting')
    link(conflicting, 'part_of', 'A')
    link(conflicting, 'part_of', 'B')
    link(file('Missing theme'), 'part_of', 'Missing')

    link(file('a/Shared', 'theme'), 'source', 'Book')
    link(file('b/Shared', 'theme'), 'source', 'Book')
    const explicit = file('a/Explicit')
    link(explicit, 'part_of', 'Shared')
    link(explicit, 'part_of', 'a/Shared')
    link(file('a/Ambiguous'), 'part_of', 'Shared')

    const alias = file('Alias')
    link(alias, 'same_as', 'A-0')
    link(alias, 'part_of', 'A')
    link(alias, 'part_of', 'A-1')
    link(b, 'links_to', 'A-0')
    link(b, 'cites', 'A-0')
    link(a, 'source', 'Book')
    link(a, 'about', 'B-0')
    link(a, 'cites', 'B-0')
    link(c, 'links_to', 'A-0')
    link(b, 'links_to', 'B-0')
    link(a, 'about', 'Ghost')
    link(path('Deleted'), 'part_of', 'A')
    pad(200)

    const projection = projectBook(rows)
    expect(projection.overview).toMatchObject({
      themes: [
        { id: path('A'), label: 'A', count: 2 },
        { id: path('B'), label: 'B', count: 1 },
        { id: path('Empty'), label: 'Empty', count: 0 },
        { id: path('a/Shared'), label: 'Shared', count: 1 },
        { id: path('b/Shared'), label: 'Shared', count: 0 }
      ],
      links: [{ source: path('A'), target: path('B'), count: 2, strong: true }],
      noteCount: 209,
      unassignedCount: 205
    })
    expect(projection.themeGraph(path('A'))).toMatchObject({
      nodes: [{ id: a, aliases: ['Alias'], degree: 2 }, { id: b, degree: 2 }],
      edges: [
        { source: a, target: b, relation: 'part_of' },
        { source: b, target: a, relation: 'cites' }
      ],
      total: 2
    })
    expect(projection.themeGraph(path('a/Shared'))?.nodes.map(({ id }) => id)).toEqual([explicit])
    expect(projection.themeGraph(path('Empty'))).toMatchObject({ total: 0, nodes: [], edges: [] })
    expect(projection.themeGraph('/somewhere/else.md')).toBeNull()
    expect(projection.themeGraph(stale)).toBeNull()
  })

  it('shows representative staged titles and one evidence row per pair with directed relations', () => {
    const { rows, file, link, theme, pad } = stagedBook()
    const [a, b, c, d] = theme('A', 4)
    const [other] = theme('B', 1)
    for (const id of [a, b]) rows.files.find(({ path }) => path === id)!.title = 'Same heading'
    rows.files.find(({ path }) => path === d)!.title = 'Actual heading'
    link(d, 'about', 'A-0')
    link(d, 'cites', 'A-1')
    link(d, 'uses', 'A-2')
    const alias = file('A alias')
    link(alias, 'same_as', 'A-3')
    link(alias, 'links_to', 'B-0')
    link(alias, 'cites', 'B-0')
    link(alias, 'cites', 'B-0')
    link(d, 'supports', 'B-0')
    link(other, 'links_to', 'A alias')
    pad(200)

    const projection = projectBook(rows)
    expect(projection.overview?.themes[0].examples).toEqual([
      { id: d, title: 'Actual heading' },
      { id: a, title: 'Same heading' },
      { id: c, title: 'A-2' }
    ])
    expect(projection.overview?.links[0].count).toBe(1)
    const evidence = projection.linkEvidence(path('B'), path('A'))
    expect(evidence).toEqual({ pairs: [{
      source: { id: other, title: 'B-0' },
      target: { id: d, title: 'Actual heading' },
      relationships: [
        { source: d, target: other, relation: 'cites', originalSource: { id: alias, title: 'A alias' } },
        { source: d, target: other, relation: 'supports' },
        { source: other, target: d, relation: 'links_to', originalTarget: { id: alias, title: 'A alias' } }
      ]
    }] })
    expect(projection.themeOf(alias)).toEqual({ id: path('A'), label: 'A' })
    expect(projection.linkEvidence(path('B'), path('B'))).toBeNull()
    expect(projection.linkEvidence(path('B'), '/wrong/run/A.md')).toBeNull()
    expect(projectBook({ files: [...rows.files].reverse(), triples: [...rows.triples].reverse() })
      .linkEvidence(path('B'), path('A'))).toEqual(evidence)
  })

  it('requires link evidence while preserving plain legacy membership fields', () => {
    const { rows, theme, pad, file, link } = stagedBook()
    const [origin] = theme('First', 1)
    theme('Second', 0)
    const draft = file('Draft')
    link(draft, 'part_of', 'Second')
    pad(200)

    const startingTriples = [...rows.triples]
    const projectText = (text: string): ReturnType<typeof projectBook> => {
      rows.triples = [...startingTriples, ...harvest(origin, text).triples.map((triple) => ({
        ...triple, source_file: origin
      }))]
      return projectBook(rows, (path) => path === origin ? text : undefined)
    }
    const literalOnly = projectText('status:: draft')
    expect(literalOnly.overview?.links).toEqual([])
    expect(literalOnly.themeOf(draft)?.id).toBe(path('Second'))
    expect(projectBook(rows).overview?.links).toEqual([])

    const linked = projectText('status:: draft\n\nSee [[Draft]].')
    expect(linked.linkEvidence(path('First'), path('Second'))?.pairs[0].relationships).toEqual([
      { source: origin, target: draft, relation: 'links_to' }
    ])
    const typed = projectText('supports:: [[Draft]]')
    expect(typed.linkEvidence(path('First'), path('Second'))?.pairs[0].relationships).toEqual([
      { source: origin, target: draft, relation: 'supports' }
    ])
    expect(projectBook(rows).overview?.links[0]?.count).toBe(1)
  })

  it('derives one named level from the full theme with an explicit remainder', () => {
    const { rows, file, link, theme, pad } = stagedBook()
    theme('Landscape', 0)
    theme('Portrait', 1)
    const collections = [['Velvet Dune', 24], ['Forest Trail', 22], ['Unsorted', 22]] as const
    const ids = collections.flatMap(([label, count]) => Array.from({ length: count }, (_, i) => {
      const id = file(`${label} ${i}`)
      link(id, 'part_of', 'Landscape')
      // The remainder has no common identifying term in the actual headings.
      if (label === 'Unsorted') rows.files.find(({ path }) => path === id)!.title = `Standalone${i}`
      return id
    }))
    link(ids[0], 'about', 'Velvet Dune 1')
    link(ids[0], 'cites', 'Forest Trail 0')
    pad(200)
    const projection = projectBook(rows)
    expect(projection.themeGraph(path('Landscape'), 5)?.nodes).toHaveLength(5)
    const details = projection.themeDetails(path('Landscape'))!
    expect(details.subthemes.map(({ label, count }) => [label, count])).toEqual([
      ['Velvet Dune', 24], ['Forest Trail', 22]
    ])
    expect(details.remainder?.count).toBe(22)
    const grouped = [...details.subthemes, details.remainder!]
      .flatMap(({ id }) => projection.themeGraph(id)!.nodes.map(({ id }) => id))
    expect(grouped.sort()).toEqual(ids.sort())
    expect(projection.themeDetails(details.subthemes[0].id)).toBeNull()
    expect(projection.themeGraph(details.subthemes[0].id)?.edges).toEqual([
      { source: path('Velvet Dune 0'), target: path('Velvet Dune 1'), relation: 'about' }
    ])
    const fresh = projectBook({ files: [...rows.files].reverse(), triples: [...rows.triples].reverse() })
    expect(fresh.themeGraph(details.subthemes[0].id)?.total).toBe(24)
    expect(fresh.themeDetails(path('Landscape'))).toEqual(details)
    expect(projectBook(stagedBook().rows).themeGraph(details.subthemes[0].id)).toBeNull()
  })

  it('keeps a flat theme when title overlap would only yield a giant or tiny groups', () => {
    const { rows, file, link, theme } = stagedBook()
    theme('Artwork', 0)
    for (let i = 0; i < 68; i++) {
      const name = i < 60 ? 'Common pattern' : i < 64 ? 'Velvet Dune' : 'Forest Trail'
      link(file(`${name} ${i}`), 'part_of', 'Artwork')
    }
    const projection = projectBook(rows)
    expect(projection.themeDetails(path('Artwork'))).toEqual({ subthemes: [], remainder: null })
    expect(projection.themeGraph(path('Artwork'))?.total).toBe(68)
  })

  it('preserves local-script headings and excludes words inherited from the parent label', () => {
    const { rows, file, link, theme } = stagedBook()
    theme('Forecasting', 0)
    const collections = [['Forecast', 28], ['Échantillonnage bayésien', 19], ['Arbres aléatoires', 18]] as const
    for (const [label, count] of collections) {
      for (let i = 0; i < count; i++) {
        const id = file(`${label} ${i}`)
        link(id, 'part_of', 'Forecasting')
      }
    }
    const details = projectBook(rows).themeDetails(path('Forecasting'))!
    expect(details.subthemes.map(({ label }) => label)).toEqual([
      'Échantillonnage bayésien', 'Arbres aléatoires'
    ])
    expect(details.subthemes[0].examples[0].title).toBe('Échantillonnage bayésien 0')
    expect(details.remainder?.count).toBe(28)
  })

  it('returns isolated theme members and grows the same slice on demand', () => {
    const { rows, theme, link } = stagedBook()
    const a = theme('A', 204)
    theme('B', 2)
    link(a[203], 'about', 'A-202')
    const projection = projectBook(rows)
    const full = projection.themeGraph(path('A'), 300)!
    const capped = projection.themeGraph(path('A'))!

    expect(buildGraph(rows.files, rows.triples, null, { showSources: true }).nodes).toHaveLength(200)
    expect(capped.total).toBe(204)
    expect(capped.nodes).toEqual(full.nodes.slice(0, 200))
    expect(capped.nodes[0].id).toBe(a[202])
    expect(full.nodes.map(({ id }) => id).sort()).toEqual([...a].sort())
    expect(full.edges).toEqual([{ source: a[203], target: a[202], relation: 'about' }])
    expect(full.nodes.filter(({ degree }) => degree === 0)).toHaveLength(202)
    expect(projection.themeGraph(path('A'), 0)).toMatchObject({ total: 204, nodes: [], edges: [] })
  })

  it('pages unassigned notes with only their mutual relations', () => {
    const { rows, file, theme, link, pad } = stagedBook()
    theme('A', 1)
    theme('B', 1)
    pad(200)
    const first = file('First')
    const second = file('Second')
    link(first, 'about', 'Second')
    link(second, 'about', 'A-0')
    const projection = projectBook(rows)
    expect(projection.overview?.unassignedCount).toBe(202)
    const capped = projection.themeGraph(null)!
    expect(capped.total).toBe(202)
    expect(capped.nodes).toHaveLength(200)
    expect(capped.edges).toEqual([{ source: first, target: second, relation: 'about' }])
    expect(projection.themeGraph(null, 400)?.nodes).toHaveLength(202)
  })

  it('ranks normalized mutual top-three links and gives an isolated theme its strongest link', () => {
    const { rows, theme, link, pad } = stagedBook()
    const a = theme('A', 10)
    const b = theme('B', 100)
    theme('C', 10)
    theme('D', 10)
    theme('E', 1)
    theme('F', 10)
    theme('G', 10)
    pad(60)
    for (let i = 0; i < 3; i++) {
      link(a[i], 'about', `B-${i}`)
      link(a[i], 'about', `C-${i}`)
    }
    link(a[0], 'about', 'D-0')
    link(a[1], 'about', 'D-1')
    link(a[0], 'about', 'E-0')
    link(a[0], 'about', 'F-0')
    link(a[0], 'about', 'G-0')
    for (let i = 0; i < 8; i++) link(b[i], 'about', `F-${i}`)

    const overview = projectBook(rows).overview!
    expect(overview.links.map(({ source, target, count, strong }) => [noteName(source), noteName(target), count, strong])).toEqual([
      ['A', 'B', 3, false],
      ['A', 'C', 3, true],
      ['A', 'D', 2, true],
      ['A', 'E', 1, true],
      ['A', 'F', 1, false],
      ['A', 'G', 1, true],
      ['B', 'F', 8, true]
    ])
    expect(projectBook({ files: [...rows.files].reverse(), triples: [...rows.triples].reverse() }).overview).toEqual(overview)
  })
})
