import { describe, it, expect } from 'vitest'
import { groupsLayout } from './groupsLayout'
import type { Point } from './layout'

const d = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('groupsLayout', () => {
  it('separates communities into distinct regions', () => {
    // Two triangles with no edge between them → two communities.
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id }))
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
      { source: 'D', target: 'E' },
      { source: 'E', target: 'F' },
      { source: 'F', target: 'D' }
    ]
    const p = groupsLayout(nodes, edges, { width: 800, height: 600 })
    const intra = d(p.get('A')!, p.get('B')!) // same community
    const inter = d(p.get('A')!, p.get('D')!) // different community
    expect(inter).toBeGreaterThan(intra)
  })

  it('is deterministic', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }]
    const edges = [{ source: 'A', target: 'B' }]
    expect([...groupsLayout(nodes, edges).entries()]).toEqual([
      ...groupsLayout(nodes, edges).entries()
    ])
  })

  it('handles empty and single-node graphs', () => {
    expect(groupsLayout([], []).size).toBe(0)
    expect(groupsLayout([{ id: 'X' }], [])).toEqual(new Map([['X', { x: 400, y: 300 }]]))
  })
})
