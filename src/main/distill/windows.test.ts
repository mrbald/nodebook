import { describe, it, expect } from 'vitest'
import { coverageOf, evenStride, planWindows, unionWeight } from './windows'
import type { Chunk } from '../rag/chunk'

/** A chunk of `text` starting at `start` — the chunker's own invariant
 *  (`source.slice(start, end) === text`) held by construction. */
function chunk(start: number, text: string, heading = ''): Chunk {
  return { heading, start, end: start + text.length, text }
}

/** `n` consecutive chunks of `len` characters each, laid end to end — so
 *  weight, length and offsets are all the same easy number. */
function run(n: number, len = 100): Chunk[] {
  return Array.from({ length: n }, (_, i) => chunk(i * len, 'x'.repeat(len)))
}

describe('unionWeight', () => {
  it('sums disjoint ranges', () => {
    expect(unionWeight(run(3, 100))).toBe(300)
  })

  it('counts an overlap once (the chunker overlaps consecutive chunks)', () => {
    // [0,100) and [90,190): 190 characters of text, not 200.
    expect(unionWeight([chunk(0, 'x'.repeat(100)), chunk(90, 'y'.repeat(100))])).toBe(190)
  })

  it('ignores a range wholly inside one already counted', () => {
    expect(unionWeight([chunk(0, 'x'.repeat(100)), chunk(10, 'y'.repeat(20))])).toBe(100)
  })

  it('weighs CJK three times a Latin character, like the chunker does', () => {
    expect(unionWeight([chunk(0, '道德经')])).toBe(9)
  })
})

describe('evenStride', () => {
  it('keeps everything when the budget is not binding', () => {
    expect(evenStride(3, 5)).toEqual([0, 1, 2])
    expect(evenStride(3, 3)).toEqual([0, 1, 2])
  })

  it('spreads the kept positions across the whole range, not just the front', () => {
    expect(evenStride(10, 3)).toEqual([1, 5, 8])
    expect(evenStride(9, 3)).toEqual([1, 4, 7])
  })

  it('is deterministic and strictly increasing', () => {
    const a = evenStride(97, 13)
    expect(a).toEqual(evenStride(97, 13))
    expect(a.every((v, i) => i === 0 || v > a[i - 1])).toBe(true)
    expect(a).toHaveLength(13)
  })
})

describe('planWindows', () => {
  it('packs consecutive chunks up to the weight budget', () => {
    const plan = planWindows(run(6, 100), { windowWeight: 250, maxCalls: 100 })
    expect(plan.windows.map((w) => w.chunkIds)).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(plan.totalWindows).toBe(3)
    expect(plan.coverage).toBe(1)
  })

  it('charges the per-chunk prompt scaffolding when asked to', () => {
    // 100 + 30 each, so only one fits a 250 window instead of two.
    const plan = planWindows(run(4, 100), {
      windowWeight: 250,
      maxCalls: 100,
      perChunkOverhead: 30
    })
    expect(plan.windows.map((w) => w.chunkIds)).toEqual([[0], [1], [2], [3]])
  })

  it('gives a lone over-budget chunk its own window rather than dropping it', () => {
    const chunks = [chunk(0, 'a'.repeat(50)), chunk(50, 'b'.repeat(400)), chunk(450, 'c'.repeat(50))]
    const plan = planWindows(chunks, { windowWeight: 100, maxCalls: 100 })
    expect(plan.windows.map((w) => w.chunkIds)).toEqual([[0], [1], [2]])
    expect(plan.coverage).toBe(1)
  })

  it('counts the heading in a chunk’s weight (it is sent with the text)', () => {
    // Body 40 + heading 7 + the blank line between them = 49 per chunk.
    const chunks = [chunk(0, 'x'.repeat(40), 'Chapter'), chunk(40, 'y'.repeat(40), 'Chapter')]
    expect(planWindows(chunks, { windowWeight: 97, maxCalls: 9 }).windows).toHaveLength(2)
    expect(planWindows(chunks, { windowWeight: 98, maxCalls: 9 }).windows).toHaveLength(1)
  })

  it('samples evenly by position when the document needs more windows than calls', () => {
    const chunks = run(10, 100) // one window each
    const plan = planWindows(chunks, { windowWeight: 100, maxCalls: 3 })
    expect(plan.totalWindows).toBe(10)
    expect(plan.windows.map((w) => w.chunkIds)).toEqual([[1], [5], [8]])
    // Coverage is the union math, not a window count that happens to agree.
    expect(plan.coverage).toBeCloseTo(300 / 1000)
    expect(plan.coverage).toBeCloseTo(coverageOf(chunks, [1, 5, 8]))
  })

  it('reports coverage by WEIGHT, so a heavy passage counts for more', () => {
    // Three windows: 300 characters, then 100, then 100. Keeping the first is
    // 60% of the text even though it is one window of three.
    const chunks = [chunk(0, 'x'.repeat(300)), chunk(300, 'y'.repeat(100)), chunk(400, 'z'.repeat(100))]
    const plan = planWindows(chunks, { windowWeight: 100, maxCalls: 1 })
    expect(plan.windows.map((w) => w.chunkIds)).toEqual([[1]])
    expect(plan.coverage).toBeCloseTo(100 / 500)
  })

  it('never counts an overlapping passage twice in coverage', () => {
    // Chunk 1 overlaps chunk 0's tail; the document is 190 characters wide.
    const chunks = [chunk(0, 'x'.repeat(100)), chunk(90, 'y'.repeat(100))]
    const plan = planWindows(chunks, { windowWeight: 100, maxCalls: 1 })
    expect(plan.coverage).toBeCloseTo(100 / 190)
  })

  it('handles an empty document as trivially fully covered', () => {
    expect(planWindows([], { windowWeight: 100, maxCalls: 10 })).toEqual({
      windows: [],
      coverage: 1,
      totalWindows: 0
    })
  })

  it('clamps a nonsensical budget instead of planning zero calls', () => {
    const plan = planWindows(run(4, 100), { windowWeight: 0, maxCalls: 0 })
    expect(plan.windows).toHaveLength(1)
    expect(plan.totalWindows).toBe(4)
  })
})
