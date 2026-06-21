import { describe, it, expect } from 'vitest'
import { pageRank, community } from './structure'

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
