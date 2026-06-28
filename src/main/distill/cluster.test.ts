import { describe, it, expect } from 'vitest'
import { chooseK, kmeans, type Point } from './cluster'

const P = (id: number, x: number, y: number): Point => ({ id, vec: Float32Array.from([x, y]) })

/** Every input id lands in exactly one cluster (a partition). */
function memberUnion(clusters: { memberIds: number[] }[]): number[] {
  return clusters.flatMap((c) => c.memberIds).sort((a, b) => a - b)
}

describe('chooseK', () => {
  it('scales ~one cluster per `perCluster` chunks, clamped', () => {
    expect(chooseK(60)).toBe(8) // ceil(60/8)=8, inside [4,24]
    expect(chooseK(400)).toBe(24) // capped at max
    expect(chooseK(10)).toBe(4) // ceil(10/8)=2 → lifted to min 4
  })

  it('never asks for more clusters than points, and 0 for empty', () => {
    expect(chooseK(3)).toBe(3) // min would be 4 but only 3 points
    expect(chooseK(0)).toBe(0)
  })
})

describe('kmeans', () => {
  // Two well-separated blobs: ids 1-3 near origin, 10-12 near (10,10).
  const blobs = [P(1, 0, 0), P(2, 0.1, 0.1), P(3, 0, 0.1), P(10, 10, 10), P(11, 10.1, 10), P(12, 10, 10.2)]

  it('separates two blobs into the right clusters', () => {
    const cs = kmeans(blobs, 2)
    expect(cs.length).toBe(2)
    const withOne = cs.find((c) => c.memberIds.includes(1))!
    const withTen = cs.find((c) => c.memberIds.includes(10))!
    expect(withOne.memberIds).toEqual([1, 2, 3])
    expect(withTen.memberIds).toEqual([10, 11, 12])
  })

  it('returns a partition of all input ids', () => {
    expect(memberUnion(kmeans(blobs, 2))).toEqual([1, 2, 3, 10, 11, 12])
    expect(memberUnion(kmeans(blobs, 4))).toEqual([1, 2, 3, 10, 11, 12])
  })

  it('is deterministic', () => {
    expect(kmeans(blobs, 2)).toEqual(kmeans(blobs, 2))
    expect(kmeans(blobs, 3)).toEqual(kmeans(blobs, 3))
  })

  it('caps representatives at repCount, nearest-first set', () => {
    const cs = kmeans(blobs, 2, { repCount: 1 })
    for (const c of cs) expect(c.representativeIds.length).toBe(1)
    // Nearest the cluster mean (~0.03,0.07), not the origin: id 3 at (0,0.1).
    const withOne = cs.find((c) => c.memberIds.includes(1))!
    expect(withOne.representativeIds).toEqual([3])
  })

  it('handles empty, singleton, and k≥n inputs', () => {
    expect(kmeans([], 3)).toEqual([])
    expect(kmeans([P(5, 1, 1)], 3)).toEqual([{ memberIds: [5], representativeIds: [5] }])
    // k≥n → every point its own singleton cluster.
    const cs = kmeans([P(7, 0, 0), P(8, 9, 9), P(9, 0, 9)], 10)
    expect(cs.length).toBe(3)
    expect(cs.every((c) => c.memberIds.length === 1)).toBe(true)
  })

  it('does not crash or loop on identical vectors', () => {
    const same = [P(1, 1, 1), P(2, 1, 1), P(3, 1, 1), P(4, 1, 1)]
    const cs = kmeans(same, 2)
    expect(memberUnion(cs)).toEqual([1, 2, 3, 4])
    expect(kmeans(same, 2)).toEqual(cs) // still deterministic
  })
})
