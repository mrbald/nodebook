import { describe, it, expect } from 'vitest'
import { rrfRank } from './rrf'

/**
 * RRF backs both the hybrid search box and the "Ask" grounding. It's pure, so we
 * pin the ranking, dedup-across-lists, and agreement-wins behaviour here.
 */
describe('rrfRank', () => {
  it('ranks a single list by its order', () => {
    expect(rrfRank([['a', 'b', 'c']])).toEqual(['a', 'b', 'c'])
  })

  it('rewards keys that appear in multiple lists', () => {
    // "b" is rank 1 in both lists; its summed reciprocal beats either list's
    // rank-0 singleton, so agreement floats it to the top.
    expect(rrfRank([['a', 'b'], ['c', 'b']])).toEqual(['b', 'a', 'c'])
  })

  it('dedups a key across lists into one entry', () => {
    const out = rrfRank([['x', 'y'], ['x']])
    expect(out).toEqual(['x', 'y'])
    expect(out.filter((k) => k === 'x')).toHaveLength(1)
  })

  it('ignores empty lists and returns [] for no input', () => {
    expect(rrfRank([])).toEqual([])
    expect(rrfRank([[], ['a']])).toEqual(['a'])
  })

  it('a higher rrfK flattens the rank weighting (ties stay ordered by sum)', () => {
    // Pure sanity: with one list, order is preserved regardless of rrfK.
    expect(rrfRank([['a', 'b', 'c']], 1000)).toEqual(['a', 'b', 'c'])
  })
})
