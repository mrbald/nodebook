import { describe, it, expect } from 'vitest'
import { radialLayout } from './radialLayout'

const r = (p: { x: number; y: number }): number => Math.hypot(p.x - 400, p.y - 300)

describe('radialLayout', () => {
  it('puts the focus at the centre and its neighbours on one ring', () => {
    const nodes = [{ id: 'A', focus: true }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' }
    ]
    const pos = radialLayout(nodes, edges, { width: 800, height: 600 })
    expect(pos.get('A')).toEqual({ x: 400, y: 300 })
    expect(r(pos.get('B')!)).toBeGreaterThan(0)
    expect(r(pos.get('B')!)).toBeCloseTo(r(pos.get('C')!)) // same hop → same radius
  })

  it('rings grow with hop-distance', () => {
    const nodes = [{ id: 'A', focus: true }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' }
    ]
    const pos = radialLayout(nodes, edges, {})
    expect(r(pos.get('C')!)).toBeGreaterThan(r(pos.get('B')!)) // C is two hops out
  })

  it('anchors the highest-degree node when there is no focus', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { source: 'B', target: 'A' },
      { source: 'B', target: 'C' }
    ]
    expect(radialLayout(nodes, edges, {}).get('B')).toEqual({ x: 400, y: 300 })
  })

  it('leaves space between first-hop neighbours even with a long tail', () => {
    const neighbours = Array.from({ length: 72 }, (_, i) => ({ id: `near-${i}` }))
    const tail = Array.from({ length: 5 }, (_, i) => ({ id: `tail-${i}` }))
    const edges = neighbours.map(({ id }) => ({ source: 'centre', target: id }))
    tail.forEach(({ id }, i) => edges.push({ source: i ? tail[i - 1].id : neighbours[0].id, target: id }))
    const pos = radialLayout([{ id: 'centre', focus: true }, ...neighbours, ...tail], edges)
    const adjacent = 2 * r(pos.get(neighbours[0].id)!) * Math.sin(Math.PI / neighbours.length)
    expect(adjacent).toBeGreaterThan(8)
    expect(r(pos.get(tail[4].id)!)).toBeGreaterThan(r(pos.get(neighbours[0].id)!))
  })

  it('handles empty and single-node graphs', () => {
    expect(radialLayout([], []).size).toBe(0)
    expect(radialLayout([{ id: 'X' }], [])).toEqual(new Map([['X', { x: 400, y: 300 }]]))
  })
})
