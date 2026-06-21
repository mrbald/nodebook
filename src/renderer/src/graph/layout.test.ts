import { describe, it, expect } from 'vitest'
import { forceLayout, type Point } from './layout'

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('forceLayout', () => {
  it('is deterministic — same input gives identical output', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [{ source: 'A', target: 'B' }]
    const a = forceLayout(nodes, edges)
    const b = forceLayout(nodes, edges)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('places a single node at the centre', () => {
    const p = forceLayout([{ id: 'A' }], [], { width: 800, height: 600 })
    expect(p.get('A')).toEqual({ x: 400, y: 300 })
  })

  it('produces finite coordinates for every node', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}` }))
    const edges = [
      { source: 'n0', target: 'n1' },
      { source: 'n1', target: 'n2' },
      { source: 'n0', target: 'n3' }
    ]
    const p = forceLayout(nodes, edges)
    for (const n of nodes) {
      const v = p.get(n.id) as Point
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
    }
  })

  it('pulls connected nodes closer than unconnected ones', () => {
    const connected = forceLayout([{ id: 'A' }, { id: 'B' }], [{ source: 'A', target: 'B' }])
    const apart = forceLayout([{ id: 'A' }, { id: 'B' }], [])
    expect(dist(connected.get('A') as Point, connected.get('B') as Point)).toBeLessThan(
      dist(apart.get('A') as Point, apart.get('B') as Point)
    )
  })
})
