import { describe, it, expect } from 'vitest'
import { buildGraph, noteName, type FileRow, type TripleRow } from './graph'

const files: FileRow[] = [
  { path: '/v/A.md', title: 'A' },
  { path: '/v/B.md', title: 'B' },
  { path: '/v/sub/C.md', title: 'C' }
]
const triples: TripleRow[] = [
  { subject: 'A', relation: 'links_to', object: 'B' },
  { subject: 'A', relation: 'links_to', object: 'Ghost' }, // no file → ghost
  { subject: 'B', relation: 'links_to', object: 'C' }
]

describe('noteName', () => {
  it('strips directories and the .md extension', () => {
    expect(noteName('/v/sub/C.md')).toBe('C')
    expect(noteName('A.MD')).toBe('A')
  })
})

describe('buildGraph', () => {
  it('global: all referenced nodes + edges, with ghosts flagged', () => {
    const g = buildGraph(files, triples, null)
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set(['A', 'B', 'C', 'Ghost']))
    const ghost = g.nodes.find((n) => n.id === 'Ghost')!
    expect(ghost.ghost).toBe(true)
    expect(ghost.path).toBeNull()
    expect(g.nodes.find((n) => n.id === 'C')!.path).toBe('/v/sub/C.md')
    expect(g.edges).toHaveLength(3)
  })

  it('local depth-1: focus + immediate neighbours only', () => {
    const g = buildGraph(files, triples, 'A', { depth: 1 })
    // A links to B and Ghost; C is two hops away and excluded.
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set(['A', 'B', 'Ghost']))
    expect(g.nodes.find((n) => n.id === 'A')!.focus).toBe(true)
    expect(g.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(['A->B', 'A->Ghost'])
  })

  it('local: follows inbound edges too (B is linked from A and links to C)', () => {
    const g = buildGraph(files, triples, 'B', { depth: 1 })
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set(['A', 'B', 'C']))
  })

  it('depth-2 from A reaches C', () => {
    const g = buildGraph(files, triples, 'A', { depth: 2 })
    expect(g.nodes.map((n) => n.id)).toContain('C')
  })

  it('degree counts edges within the slice and de-dupes parallel triples', () => {
    const dup = [...triples, { subject: 'A', relation: 'links_to', object: 'B' }]
    const g = buildGraph(files, dup, null)
    expect(g.edges).toHaveLength(3) // duplicate A->B dropped
    expect(g.nodes.find((n) => n.id === 'A')!.degree).toBe(2) // A-B, A-Ghost
  })

  it('resolves a path-suffix link target to the real note (not a ghost)', () => {
    // `[[sub/C]]` from A should resolve to the real note C at /v/sub/C.md.
    const g = buildGraph(files, [{ subject: 'A', relation: 'links_to', object: 'sub/C' }], null)
    const c = g.nodes.find((n) => n.id === 'C')!
    expect(c.ghost).toBe(false)
    expect(g.edges).toEqual([{ source: 'A', target: 'C', relation: 'links_to' }])
  })

  it('isolated focus note yields a single node, no edges', () => {
    const g = buildGraph([{ path: '/v/Lonely.md', title: 'Lonely' }], [], 'Lonely')
    expect(g.nodes).toHaveLength(1)
    expect(g.edges).toHaveLength(0)
  })
})
