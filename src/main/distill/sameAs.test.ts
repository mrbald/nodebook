import { describe, it, expect } from 'vitest'
import { noteVector, sameAsCandidates, type NoteVec } from './sameAs'

const unit = (...xs: number[]): Float32Array => {
  const v = Float32Array.from(xs)
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / n)
}
const nv = (id: string, ...xs: number[]): NoteVec => ({ id, vec: unit(...xs) })

describe('noteVector', () => {
  it('is the normalised mean of the chunk vectors, ignoring a chunk of the wrong width', () => {
    const v = noteVector([unit(1, 0), unit(0, 1), Float32Array.from([1, 2, 3])])
    expect(v).not.toBeNull()
    expect(Array.from(v!).map((x) => +x.toFixed(4))).toEqual([0.7071, 0.7071])
  })
  it('is null with nothing to average', () => {
    expect(noteVector([])).toBeNull()
    expect(noteVector([new Float32Array(0)])).toBeNull()
  })
})

describe('sameAsCandidates', () => {
  it('pairs mutual nearest neighbours only', () => {
    // r1 ↔ v1 are each other's closest. r2's closest is v1 too, but v1's
    // closest is r1 — so r2 gets nothing, and v2 (near nobody) is never proposed.
    const run = [nv('r1', 1, 0.1), nv('r2', 1, 0.5)]
    const vault = [nv('/v/v1.md', 1, 0), nv('/v/v2.md', 0, 1)]
    expect([...sameAsCandidates(run, vault, 0.5)]).toEqual([['r1', '/v/v1.md']])
  })

  it('respects the floor: a mutual pair below minScore is not proposed', () => {
    const run = [nv('r', 1, 1)]
    const vault = [nv('v', 1, 0)] // cosine ≈ 0.71
    expect(sameAsCandidates(run, vault, 0.9).size).toBe(0)
    expect(sameAsCandidates(run, vault, 0.5).size).toBe(1)
  })

  it('never compares vectors of different widths', () => {
    const run = [nv('r', 1, 0, 0)]
    const vault = [nv('v', 1, 0)]
    expect(sameAsCandidates(run, vault, 0).size).toBe(0)
  })

  it('is one-to-one and deterministic on ties', () => {
    const run = [nv('a', 1, 0), nv('b', 1, 0)] // identical run notes
    const vault = [nv('x', 1, 0)]
    expect([...sameAsCandidates(run, vault, 0.5)]).toEqual([['a', 'x']]) // the earlier one wins
  })

  it('is empty when either side is empty', () => {
    expect(sameAsCandidates([], [nv('v', 1)], 0).size).toBe(0)
    expect(sameAsCandidates([nv('r', 1)], [], 0).size).toBe(0)
  })
})
