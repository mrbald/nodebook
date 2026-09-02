import { describe, it, expect } from 'vitest'
import { buildGraph, overlayGraph, noteName, type FileRow, type TripleRow } from './graph'

/** A harvested triple: the subject IS the file it came from (identity is path). */
const t = (from: string, relation: string, object: string): TripleRow => ({
  subject: noteName(from),
  relation,
  object,
  source_file: from
})

const A = '/v/A.md'
const B = '/v/B.md'
const C = '/v/sub/C.md'

const files: FileRow[] = [
  { path: A, title: 'A' },
  { path: B, title: 'B' },
  { path: C, title: 'C' }
]
const triples: TripleRow[] = [
  t(A, 'links_to', 'B'),
  t(A, 'links_to', 'Ghost'), // no file → ghost
  t(B, 'links_to', 'C')
]
const ids = (g: { nodes: { id: string }[] }): Set<string> => new Set(g.nodes.map((n) => n.id))
const labels = (g: { nodes: { label: string }[] }): string[] => g.nodes.map((n) => n.label).sort()

describe('noteName', () => {
  it('strips directories and the .md extension', () => {
    expect(noteName('/v/sub/C.md')).toBe('C')
    expect(noteName('A.MD')).toBe('A')
  })
})

describe('buildGraph', () => {
  it('global: all referenced nodes + edges, with ghosts flagged', () => {
    const g = buildGraph(files, triples, null)
    expect(ids(g)).toEqual(new Set([A, B, C, 'ghost:Ghost']))
    const ghost = g.nodes.find((n) => n.id === 'ghost:Ghost')!
    expect(ghost.ghost).toBe(true)
    expect(ghost.path).toBeNull()
    expect(ghost.label).toBe('Ghost') // the link text, not the id
    const c = g.nodes.find((n) => n.id === C)!
    expect(c.path).toBe(C)
    expect(c.label).toBe('C') // a real note is keyed by path but labelled by name
    expect(g.edges).toHaveLength(3)
    expect(g.ambiguousTargets).toBe(0)
  })

  it('local depth-1: focus + immediate neighbours only', () => {
    const g = buildGraph(files, triples, A, { depth: 1 })
    // A links to B and Ghost; C is two hops away and excluded.
    expect(ids(g)).toEqual(new Set([A, B, 'ghost:Ghost']))
    expect(g.nodes.find((n) => n.id === A)!.focus).toBe(true)
    expect(g.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      `${A}->${B}`,
      `${A}->ghost:Ghost`
    ])
  })

  it('local: follows inbound edges too (B is linked from A and links to C)', () => {
    const g = buildGraph(files, triples, B, { depth: 1 })
    expect(ids(g)).toEqual(new Set([A, B, C]))
  })

  it('depth-2 from A reaches C', () => {
    const g = buildGraph(files, triples, A, { depth: 2 })
    expect(g.nodes.map((n) => n.id)).toContain(C)
  })

  it('degree counts edges within the slice and de-dupes parallel triples', () => {
    const dup = [...triples, t(A, 'links_to', 'B')]
    const g = buildGraph(files, dup, null)
    expect(g.edges).toHaveLength(3) // duplicate A->B dropped
    expect(g.nodes.find((n) => n.id === A)!.degree).toBe(2) // A-B, A-Ghost
  })

  it('resolves a path-suffix link target to the real note (not a ghost)', () => {
    // `[[sub/C]]` from A should resolve to the real note C at /v/sub/C.md.
    const g = buildGraph(files, [t(A, 'links_to', 'sub/C')], null)
    const c = g.nodes.find((n) => n.id === C)!
    expect(c.ghost).toBe(false)
    expect(g.edges).toEqual([{ source: A, target: C, relation: 'links_to' }])
  })

  it('isolated focus note yields a single node, no edges', () => {
    const g = buildGraph([{ path: '/v/Lonely.md', title: 'Lonely' }], [], '/v/Lonely.md')
    expect(g.nodes).toHaveLength(1)
    expect(g.edges).toHaveLength(0)
  })

  it('reports total candidates so the global cap can be surfaced honestly', () => {
    // Global with a tight cap: 4 distinct nodes are referenced (A, B, C, Ghost),
    // but only the top 2 by degree are kept — `total` still reports 4.
    const capped = buildGraph(files, triples, null, { cap: 2 })
    expect(capped.nodes).toHaveLength(2)
    expect(capped.total).toBe(4)
    // Local slices are never capped → total equals the shown count.
    const local = buildGraph(files, triples, A, { depth: 1 })
    expect(local.total).toBe(local.nodes.length)
  })

  it('drops self-loops (a note that references itself)', () => {
    const g = buildGraph(files, [t(A, 'links_to', 'A')], null)
    expect(g.edges).toHaveLength(0)
    // `[[sub/C]]` from C resolves to C itself → also a self-loop, dropped.
    const g2 = buildGraph(files, [t(C, 'links_to', 'sub/C')], null)
    expect(g2.edges).toHaveLength(0)
  })

  it('a typed relation supersedes the bare links_to for the same pair', () => {
    // A both `[[B]]`s in prose and declares `cites:: [[B]]` → one typed edge, no dup.
    const g = buildGraph(files, [t(A, 'links_to', 'B'), t(A, 'cites', 'B')], null)
    expect(g.edges).toEqual([{ source: A, target: B, relation: 'cites' }])
  })

  it('keeps links_to to a *different* target than the typed one', () => {
    const g = buildGraph(files, [t(A, 'links_to', 'B'), t(A, 'cites', 'C')], null)
    expect(g.edges.map((e) => `${e.source}-${e.relation}->${e.target}`).sort()).toEqual([
      `${A}-cites->${C}`,
      `${A}-links_to->${B}`
    ])
  })
})

describe('same-name notes (identity is the path)', () => {
  // Two different notes both called "Faction", one per folder, each linked to
  // from its own folder — the collision a name-keyed graph used to swallow.
  const twins: FileRow[] = [
    { path: '/v/x/A.md', title: 'A' },
    { path: '/v/x/Faction.md', title: 'Faction' },
    { path: '/v/y/B.md', title: 'B' },
    { path: '/v/y/Faction.md', title: 'Faction' },
    { path: '/v/z/D.md', title: 'D' }
  ]

  it('are two nodes with the same label, and each link prefers its own folder', () => {
    const g = buildGraph(
      twins,
      [t('/v/x/A.md', 'links_to', 'Faction'), t('/v/y/B.md', 'links_to', 'Faction')],
      null
    )
    expect(ids(g)).toEqual(new Set(['/v/x/A.md', '/v/x/Faction.md', '/v/y/B.md', '/v/y/Faction.md']))
    expect(labels(g)).toEqual(['A', 'B', 'Faction', 'Faction'])
    expect(g.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      '/v/x/A.md->/v/x/Faction.md',
      '/v/y/B.md->/v/y/Faction.md'
    ])
  })

  it('counts the target as ambiguous — once per target, not per link', () => {
    const g = buildGraph(
      twins,
      [t('/v/x/A.md', 'links_to', 'Faction'), t('/v/y/B.md', 'links_to', 'Faction')],
      null
    )
    expect(g.ambiguousTargets).toBe(1) // one target text ("Faction"), two links
  })

  it('falls back to the smallest path when no candidate shares the folder', () => {
    const g = buildGraph(twins, [t('/v/z/D.md', 'links_to', 'Faction')], null)
    expect(g.edges).toEqual([
      { source: '/v/z/D.md', target: '/v/x/Faction.md', relation: 'links_to' }
    ])
    expect(g.ambiguousTargets).toBe(1)
  })

  it('an unambiguous name is not counted, however many notes link to it', () => {
    const g = buildGraph(files, triples, null)
    expect(g.ambiguousTargets).toBe(0)
  })
})

describe('source hubs (showSources)', () => {
  // Two notes distilled from the same book both carry `source:: [[Book]]`; A also
  // links to B directly, so the map stays connected once the hub is hidden.
  const BOOK = '/v/Book.md'
  const withSource: FileRow[] = [
    { path: A, title: 'A' },
    { path: B, title: 'B' },
    { path: BOOK, title: 'Book' }
  ]
  const sourceTriples: TripleRow[] = [
    t(A, 'source', 'Book'),
    t(B, 'source', 'Book'),
    t(A, 'links_to', 'B')
  ]

  it('hides the hub by default, dropping its edges, and reports it as hidden', () => {
    const g = buildGraph(withSource, sourceTriples, null)
    expect(ids(g)).toEqual(new Set([A, B]))
    expect(g.edges).toEqual([{ source: A, target: B, relation: 'links_to' }])
    expect(g.hiddenSources).toBe(1)
  })

  it('showSources keeps the hub and its edges; hiddenSources is 0', () => {
    const g = buildGraph(withSource, sourceTriples, null, { showSources: true })
    expect(ids(g)).toEqual(new Set([A, B, BOOK]))
    expect(g.edges.filter((e) => e.relation === 'source')).toHaveLength(2)
    expect(g.hiddenSources).toBe(0)
  })

  it('with themes, a shown hub keeps only its theme edges: book → themes → notes, not a star', () => {
    // Every note hangs under a theme and every theme links to the book, so the
    // note → book edges add nothing the map does not already show. Hidden, the
    // whole hub still goes, theme edge included.
    const T = '/v/Theme.md'
    const themedFiles: FileRow[] = [...withSource, { path: T, title: 'Theme', kind: 'theme' }]
    const themedTriples: TripleRow[] = [
      ...sourceTriples,
      t(A, 'part_of', 'Theme'),
      t(B, 'part_of', 'Theme'),
      t(T, 'source', 'Book')
    ]
    const g = buildGraph(themedFiles, themedTriples, null, { showSources: true })
    expect(ids(g)).toEqual(new Set([A, B, T, BOOK]))
    expect(g.edges.filter((e) => e.relation === 'source')).toEqual([
      { source: T, target: BOOK, relation: 'source' }
    ])
    expect(g.edges.filter((e) => e.relation === 'part_of')).toHaveLength(2)
    expect(g.hiddenSources).toBe(0)

    const h = buildGraph(themedFiles, themedTriples, null)
    expect(ids(h)).toEqual(new Set([A, B, T]))
    expect(h.edges.filter((e) => e.relation === 'source')).toHaveLength(0)
    expect(h.hiddenSources).toBe(1)
  })

  it('opening the book itself still shows every note that cites it', () => {
    // The focus exemption wins over the theme rule: the user asked for the
    // book, so its full neighbourhood is what they get.
    const T = '/v/Theme.md'
    const themedFiles: FileRow[] = [...withSource, { path: T, title: 'Theme', kind: 'theme' }]
    const themedTriples: TripleRow[] = [...sourceTriples, t(A, 'part_of', 'Theme'), t(T, 'source', 'Book')]
    const g = buildGraph(themedFiles, themedTriples, BOOK, { showSources: true, depth: 1 })
    expect(g.edges.filter((e) => e.relation === 'source').map((e) => e.source).sort()).toEqual([A, B, T].sort())
  })

  it('a vault with no source triples is untouched, hiddenSources=0', () => {
    const g = buildGraph(files, triples, null)
    expect(ids(g)).toEqual(new Set([A, B, C, 'ghost:Ghost']))
    expect(g.hiddenSources).toBe(0)
  })

  it('keeps a kind: document note out of the global view, but not out of its own', () => {
    // A book is what the notes are ABOUT, not a hub of your thinking: its
    // degree is one edge per distilled note, so degree ranking would always
    // put it first. Here it is linked from a note that is NOT a `source::`
    // edge, so the hub rule alone would keep it.
    const docFiles: FileRow[] = [
      { path: A, title: 'A' },
      { path: B, title: 'B' },
      { path: BOOK, title: 'Book', kind: 'document' }
    ]
    const docTriples: TripleRow[] = [t(A, 'mentions', 'Book'), t(B, 'mentions', 'Book')]
    expect(ids(buildGraph(docFiles, docTriples, null))).toEqual(new Set([A, B]))
    // …unless the user asked for source documents, or opened the book itself.
    expect(ids(buildGraph(docFiles, docTriples, null, { showSources: true }))).toEqual(
      new Set([A, B, BOOK])
    )
    expect(ids(buildGraph(docFiles, docTriples, BOOK, { depth: 1 }))).toEqual(new Set([A, B, BOOK]))
  })

  it('reports each note kind on its node, and nothing on an ordinary note', () => {
    const g = buildGraph(
      [
        { path: A, title: 'A', kind: 'concept' },
        { path: B, title: 'B', kind: 'note' }
      ],
      [t(A, 'links_to', 'B')],
      null
    )
    expect(g.nodes.find((n) => n.id === A)!.kind).toBe('concept')
    expect(g.nodes.find((n) => n.id === B)!.kind).toBeUndefined()
  })

  it('never hides the hub when it is the focus itself — exempted, not just re-shown', () => {
    // Focusing the book is the one case where the user explicitly asked for it.
    const g = buildGraph(withSource, sourceTriples, BOOK, { depth: 1 })
    expect(ids(g)).toEqual(new Set([A, B, BOOK]))
    expect(g.edges.filter((e) => e.relation === 'source')).toHaveLength(2)
    // Nothing was actually dropped (the only hub is the focus), so the count is 0.
    expect(g.hiddenSources).toBe(0)
  })
})

describe('overlayGraph', () => {
  // Vault and run share the name "Faction" — the overlap to preview.
  const vault = {
    files: [
      { path: '/v/A.md', title: 'A' },
      { path: '/v/Faction.md', title: 'Faction' }
    ],
    triples: [t('/v/A.md', 'about', 'Faction')]
  }
  const run = {
    files: [
      { path: '/run/Faction.md', title: 'Faction' },
      { path: '/run/Republic.md', title: 'Republic' }
    ],
    triples: [t('/run/Republic.md', 'contrasts_with', 'Faction')]
  }

  it('tags each node by the side its file came from: vault or run', () => {
    const g = overlayGraph(vault, run, null)
    const src = (id: string): string | undefined => g.nodes.find((n) => n.id === id)?.source
    expect(src('/v/A.md')).toBe('vault')
    expect(src('/run/Republic.md')).toBe('run')
    expect(src('/v/Faction.md')).toBe('vault')
    expect(src('/run/Faction.md')).toBe('run')
  })

  it('keeps same-name notes apart — two dots, flagged, joined by a same_name edge', () => {
    const g = overlayGraph(vault, run, null)
    const factions = g.nodes.filter((n) => n.label === 'Faction')
    expect(factions.map((n) => n.id).sort()).toEqual(['/run/Faction.md', '/v/Faction.md'])
    expect(factions.every((n) => n.sameName === true)).toBe(true)
    expect(g.edges.filter((e) => e.relation === 'same_name')).toEqual([
      { source: '/v/Faction.md', target: '/run/Faction.md', relation: 'same_name' }
    ])
    // Each side's link still points at its OWN note — nothing was collapsed.
    expect(g.edges.filter((e) => e.relation === 'about')[0].target).toBe('/v/Faction.md')
    expect(g.edges.filter((e) => e.relation === 'contrasts_with')[0].target).toBe(
      '/run/Faction.md'
    )
    // The map admits the name could have meant either note.
    expect(g.ambiguousTargets).toBe(1)
  })

  it('leaves notes with no twin unflagged', () => {
    const g = overlayGraph(vault, run, null)
    expect(g.nodes.find((n) => n.id === '/v/A.md')!.sameName).toBeUndefined()
    expect(g.nodes.find((n) => n.id === '/run/Republic.md')!.sameName).toBeUndefined()
  })

  it('is deterministic and writes nothing (a pure view)', () => {
    expect(overlayGraph(vault, run, null)).toEqual(overlayGraph(vault, run, null))
  })

  it('passes showSources through to buildGraph and propagates hiddenSources', () => {
    // The run's notes all cite the book — the star this feature exists to hide.
    const bookRun = {
      files: [
        { path: '/run/A.md', title: 'A' },
        { path: '/run/Book.md', title: 'Book' }
      ],
      triples: [t('/run/A.md', 'source', 'Book')]
    }
    const hidden = overlayGraph(vault, bookRun, null)
    expect(labels(hidden)).not.toContain('Book')
    expect(hidden.hiddenSources).toBe(1)
    // The vault's A is flagged (the run has an "A" too) but its twin isn't drawn
    // in this slice, so there is no pair and no edge.
    expect(hidden.nodes.find((n) => n.id === '/v/A.md')!.sameName).toBe(true)
    expect(hidden.edges.filter((e) => e.relation === 'same_name')).toHaveLength(0)

    const shown = overlayGraph(vault, bookRun, null, { showSources: true })
    expect(labels(shown)).toContain('Book')
    expect(shown.hiddenSources).toBe(0)
    expect(shown.edges.filter((e) => e.relation === 'same_name')).toEqual([
      { source: '/v/A.md', target: '/run/A.md', relation: 'same_name' }
    ])
  })
})

describe('confirmed same_as collapses two notes into one', () => {
  // The merge dialog wrote `same_as:: [[Options]]` into the run's copy, so the
  // two are one thing from here on. Files: the user's Options, the merged copy.
  const OPT = '/v/Options.md'
  const COPY = '/v/Distilled/book/Options (Book).md'
  const REF = '/v/Ref.md'
  const aliased: FileRow[] = [
    { path: OPT, title: 'Options' },
    { path: COPY, title: 'Options (Book)' },
    { path: REF, title: 'Ref' }
  ]

  it('folds the copy into the original, re-points its edges and keeps the alias', () => {
    const g = buildGraph(
      aliased,
      [
        t(COPY, 'same_as', 'Options'),
        t(COPY, 'about', 'Ref'), // the copy's own edge must survive, re-pointed
        t(REF, 'links_to', 'Options (Book)') // a link INTO the copy follows it too
      ],
      null
    )
    expect(ids(g)).toEqual(new Set([OPT, REF]))
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { source: OPT, target: REF, relation: 'about' },
        { source: REF, target: OPT, relation: 'links_to' }
      ])
    )
    // The alias edge itself is gone — the fold IS the statement.
    expect(g.edges.some((e) => e.relation === 'same_as')).toBe(false)
    expect(g.nodes.find((n) => n.id === OPT)!.aliases).toEqual(['Options (Book)'])
    expect(g.nodes.find((n) => n.id === REF)!.aliases).toBeUndefined()
  })

  it('a chain A→B→C lands everything on C, whatever order the triples arrive in', () => {
    const chain: FileRow[] = [
      { path: A, title: 'A' },
      { path: B, title: 'B' },
      { path: C, title: 'C' },
      { path: '/v/D.md', title: 'D' }
    ]
    const links = [t(A, 'about', 'D'), t(B, 'about', 'D'), t(C, 'about', 'D')]
    const forward = buildGraph(chain, [t(A, 'same_as', 'B'), t(B, 'same_as', 'C'), ...links], null)
    const reverse = buildGraph(chain, [t(B, 'same_as', 'C'), t(A, 'same_as', 'B'), ...links], null)
    for (const g of [forward, reverse]) {
      expect(ids(g)).toEqual(new Set([C, '/v/D.md']))
      expect(g.nodes.find((n) => n.id === C)!.aliases).toEqual(['A', 'B'])
      expect(g.edges).toEqual([{ source: C, target: '/v/D.md', relation: 'about' }])
    }
  })

  it('an alias naming a note that does not exist stays an ordinary edge to a ghost', () => {
    const g = buildGraph(files, [t(A, 'same_as', 'Nowhere')], null)
    expect(g.edges).toEqual([{ source: A, target: 'ghost:Nowhere', relation: 'same_as' }])
    expect(g.nodes.find((n) => n.id === A)!.aliases).toBeUndefined()
  })

  it('a self-loop left by the fold is dropped, not drawn', () => {
    // The copy also links to the original by name — after folding that is A→A.
    const g = buildGraph(
      aliased,
      [t(COPY, 'same_as', 'Options'), t(COPY, 'links_to', 'Options'), t(REF, 'about', 'Options')],
      null
    )
    expect(g.edges).toEqual([{ source: REF, target: OPT, relation: 'about' }])
  })

  it('focusing the folded note opens the surviving one', () => {
    const g = buildGraph(
      aliased,
      [t(COPY, 'same_as', 'Options'), t(REF, 'about', 'Options')],
      COPY
    )
    expect(g.nodes.find((n) => n.focus)?.id).toBe(OPT)
    expect(ids(g)).toEqual(new Set([OPT, REF]))
  })

  it('an unconfirmed name clash is untouched — two notes, two dots', () => {
    const clash: FileRow[] = [
      { path: OPT, title: 'Options' },
      { path: COPY, title: 'Options (Book)' },
      { path: REF, title: 'Ref' }
    ]
    const g = buildGraph(clash, [t(COPY, 'about', 'Ref'), t(REF, 'about', 'Options')], null)
    expect(ids(g)).toEqual(new Set([OPT, COPY, REF]))
    expect(g.nodes.every((n) => n.aliases === undefined)).toBe(true)
  })
})
