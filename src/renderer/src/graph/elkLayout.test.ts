import { describe, it, expect } from 'vitest'
import { elkLayout } from './elkLayout'
import type { Point } from './layout'

describe('elkLayout', () => {
  it('centres a single node', async () => {
    expect((await elkLayout([{ id: 'A' }], [], { width: 800, height: 600 })).get('A')).toEqual({
      x: 400,
      y: 300
    })
  })

  it('lays out a chain in layers, top-down (deterministic, finite, distinct)', async () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' }
    ]
    const p = await elkLayout(nodes, edges)
    for (const id of ['A', 'B', 'C']) {
      const v = p.get(id) as Point
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
    }
    expect((p.get('A') as Point).y).toBeLessThan((p.get('B') as Point).y)
    expect((p.get('B') as Point).y).toBeLessThan((p.get('C') as Point).y)
    expect([...(await elkLayout(nodes, edges)).entries()]).toEqual([...p.entries()])
  })

  it('tolerates a cycle, a self-loop, a duplicate edge and an edge to a missing node', async () => {
    const p = await elkLayout(
      [{ id: 'A' }, { id: 'B' }],
      [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
        { source: 'A', target: 'A' },
        { source: 'A', target: 'B' },
        { source: 'A', target: 'Ghost' }
      ]
    )
    expect(p.size).toBe(2)
  })

  it('fits a wide graph into the viewport', async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }))
    const edges = nodes.slice(1).map((n) => ({ source: 'n0', target: n.id }))
    const p = await elkLayout(nodes, edges, { width: 400, height: 300 })
    for (const v of p.values()) {
      expect(v.x).toBeGreaterThanOrEqual(0)
      expect(v.x).toBeLessThanOrEqual(400)
      expect(v.y).toBeGreaterThanOrEqual(0)
      expect(v.y).toBeLessThanOrEqual(300)
    }
  })
})
