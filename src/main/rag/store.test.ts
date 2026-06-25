import { describe, it, expect } from 'vitest'
import { topCosine } from './store'

/**
 * The `topCosine` helper backs the map's ✨ "related" overlay and colour-by-
 * meaning. It's pure (no DB), so we test the ranking + the distance threshold
 * here; the sqlite-vec plumbing around it is covered by the e2e (talk-graph).
 */
describe('topCosine', () => {
  // Orthonormal-ish basis so dot products are easy to reason about.
  const x = Float32Array.from([1, 0, 0])
  const y = Float32Array.from([0, 1, 0])
  // 45° from x in the x/y plane → cosine 0.7071 with x.
  const xy = Float32Array.from([Math.SQRT1_2, Math.SQRT1_2, 0])

  it('ranks by cosine similarity, highest first', () => {
    const out = topCosine(x, [
      { id: 'far', vec: y }, // cosine 0
      { id: 'near', vec: x }, // cosine 1
      { id: 'mid', vec: xy } // cosine ~0.707
    ], 5)
    expect(out.map((r) => r.id)).toEqual(['near', 'mid', 'far'])
    expect(out[0].score).toBeCloseTo(1)
    expect(out[1].score).toBeCloseTo(Math.SQRT1_2)
    expect(out[2].score).toBeCloseTo(0)
  })

  it('drops pairs below minScore (the sparse-vault guard)', () => {
    // With a 0.5 cutoff, the orthogonal note is excluded but the 45° one stays.
    const out = topCosine(x, [
      { id: 'orthogonal', vec: y }, // 0 < 0.5 → dropped
      { id: 'diagonal', vec: xy } // 0.707 ≥ 0.5 → kept
    ], 5, 0.5)
    expect(out.map((r) => r.id)).toEqual(['diagonal'])
  })

  it('returns nothing when every candidate is below the threshold', () => {
    expect(topCosine(x, [{ id: 'orthogonal', vec: y }], 5, 0.5)).toEqual([])
  })

  it('caps the result at k after thresholding', () => {
    const out = topCosine(x, [
      { id: 'a', vec: x },
      { id: 'b', vec: x },
      { id: 'c', vec: x }
    ], 2, 0)
    expect(out).toHaveLength(2)
  })
})
