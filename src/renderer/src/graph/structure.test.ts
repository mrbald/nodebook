import { describe, it, expect } from 'vitest'
import { pageRank, community, minCutBisect } from './structure'

/** Count edges crossing a bipartition (both endpoints present, opposite sides). */
function cutSize(
  a: string[],
  b: string[],
  edges: { source: string; target: string }[]
): number {
  const inA = new Set(a)
  const inB = new Set(b)
  let cut = 0
  for (const e of edges) {
    if (e.source === e.target) continue
    const cross =
      (inA.has(e.source) && inB.has(e.target)) || (inB.has(e.source) && inA.has(e.target))
    if (cross) cut++
  }
  return cut
}

describe('pageRank', () => {
  it('ranks a hub (linked from many) highest', () => {
    const nodes = [{ id: 'H' }, { id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [
      { source: 'a', target: 'H' },
      { source: 'b', target: 'H' },
      { source: 'c', target: 'H' }
    ]
    const pr = pageRank(nodes, edges)
    const top = [...pr.entries()].sort((x, y) => y[1] - x[1])[0][0]
    expect(top).toBe('H')
  })

  it('scores sum to ~1 and are deterministic', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' }
    ]
    const pr = pageRank(nodes, edges)
    const sum = [...pr.values()].reduce((s, v) => s + v, 0)
    expect(sum).toBeCloseTo(1, 5)
    expect([...pageRank(nodes, edges).entries()]).toEqual([...pr.entries()])
  })
})

describe('community', () => {
  it('puts two disconnected cliques in separate communities', () => {
    const nodes = ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({ id }))
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
      { source: 'x', target: 'y' },
      { source: 'y', target: 'z' },
      { source: 'x', target: 'z' }
    ]
    const c = community(nodes, edges)
    // a,b,c share one community; x,y,z another; the two differ.
    expect(c.get('a')).toBe(c.get('b'))
    expect(c.get('a')).toBe(c.get('c'))
    expect(c.get('x')).toBe(c.get('y'))
    expect(c.get('a')).not.toBe(c.get('x'))
  })

  it('is deterministic', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [{ source: 'a', target: 'b' }]
    expect([...community(nodes, edges).entries()]).toEqual([...community(nodes, edges).entries()])
  })
})

describe('minCutBisect', () => {
  it('splits two triangles joined by one edge into balanced halves, cut = 1', () => {
    const ids = ['a', 'b', 'c', 'x', 'y', 'z']
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
      { source: 'x', target: 'y' },
      { source: 'y', target: 'z' },
      { source: 'x', target: 'z' },
      { source: 'c', target: 'x' } // the single bridge
    ]
    const [A, B] = minCutBisect(ids, edges)
    expect(A.length).toBe(3)
    expect(B.length).toBe(3)
    expect(cutSize(A, B, edges)).toBe(1)
    // Each triangle lands wholly on one side.
    const side = (id: string): number => (A.includes(id) ? 0 : 1)
    expect(new Set(['a', 'b', 'c'].map(side)).size).toBe(1)
    expect(new Set(['x', 'y', 'z'].map(side)).size).toBe(1)
  })

  it('beats the id-order initial split (KL escapes the seed partition)', () => {
    // Natural halves are {a,c} and {b,d}: edges a-c and b-d, no cross edges.
    // The sorted-id seed split {a,b}|{c,d} cuts 2; KL must reach cut 0.
    const ids = ['a', 'b', 'c', 'd']
    const edges = [
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' }
    ]
    const [A, B] = minCutBisect(ids, edges)
    expect(A.length).toBe(2)
    expect(B.length).toBe(2)
    expect(cutSize(A, B, edges)).toBe(0)
  })

  it('keeps the halves balanced (sizes differ by ≤ 1)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const edges = [{ source: 'a', target: 'b' }]
    const [A, B] = minCutBisect(ids, edges)
    expect(Math.abs(A.length - B.length)).toBeLessThanOrEqual(1)
    expect(A.length + B.length).toBe(5)
  })

  it('is deterministic', () => {
    const ids = ['a', 'b', 'c', 'd']
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' }
    ]
    expect(minCutBisect(ids, edges)).toEqual(minCutBisect(ids, edges))
  })

  it('handles empty / single / pair inputs', () => {
    expect(minCutBisect([], [])).toEqual([[], []])
    expect(minCutBisect(['x'], [])).toEqual([['x'], []])
    const [A, B] = minCutBisect(['a', 'b'], [{ source: 'a', target: 'b' }])
    expect(A.length).toBe(1)
    expect(B.length).toBe(1)
  })
})
