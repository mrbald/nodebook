import { describe, it, expect } from 'vitest'
import { dagreLayout } from './dagreLayout'
import type { Point } from './layout'

describe('dagreLayout', () => {
  it('centres a single node', () => {
    expect(dagreLayout([{ id: 'A' }], [], { width: 800, height: 600 }).get('A')).toEqual({
      x: 400,
      y: 300
    })
  })

  it('lays out a chain hierarchically (deterministic, finite, distinct)', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' }
    ]
    const p = dagreLayout(nodes, edges)
    for (const id of ['A', 'B', 'C']) {
      const v = p.get(id) as Point
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
    }
    // Hierarchical TB layout: A above B above C (increasing y down the ranks).
    expect((p.get('A') as Point).y).toBeLessThan((p.get('B') as Point).y)
    expect((p.get('B') as Point).y).toBeLessThan((p.get('C') as Point).y)
    // Deterministic.
    expect([...dagreLayout(nodes, edges).entries()]).toEqual([...p.entries()])
  })

  it('tolerates a cycle without throwing', () => {
    const p = dagreLayout(
      [{ id: 'A' }, { id: 'B' }],
      [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' }
      ]
    )
    expect(p.size).toBe(2)
  })
})
