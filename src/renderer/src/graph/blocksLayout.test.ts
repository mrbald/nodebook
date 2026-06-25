import { describe, it, expect } from 'vitest'
import { blocksLayout } from './blocksLayout'
import type { Point } from './layout'

describe('blocksLayout', () => {
  it('separates min-cut halves into opposite regions of the canvas', () => {
    // Two triangles joined by one bridge → the bisection is {a,b,c}|{x,y,z}, so
    // on the (wider) canvas the first cut is vertical: one clique left, one right.
    const nodes = ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({ id }))
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
      { source: 'x', target: 'y' },
      { source: 'y', target: 'z' },
      { source: 'x', target: 'z' },
      { source: 'c', target: 'x' }
    ]
    const p = blocksLayout(nodes, edges, { width: 800, height: 600 })
    const xs = (ids: string[]): number[] => ids.map((id) => p.get(id)!.x)
    const left = xs(['a', 'b', 'c'])
    const right = xs(['x', 'y', 'z'])
    expect(Math.max(...left)).toBeLessThan(Math.min(...right))
  })

  it('keeps every node within the canvas bounds', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }))
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'd', target: 'e' },
      { source: 'f', target: 'g' }
    ]
    const p = blocksLayout(nodes, edges, { width: 800, height: 600 })
    expect(p.size).toBe(7)
    for (const { x, y } of p.values()) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(800)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(600)
    }
  })

  it('is deterministic', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' }
    ]
    const run = (): [string, Point][] => [...blocksLayout(nodes, edges).entries()]
    expect(run()).toEqual(run())
  })

  it('handles empty and single-node graphs', () => {
    expect(blocksLayout([], []).size).toBe(0)
    expect(blocksLayout([{ id: 'X' }], [])).toEqual(new Map([['X', { x: 400, y: 300 }]]))
  })
})
