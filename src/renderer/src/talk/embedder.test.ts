import { describe, it, expect } from 'vitest'
import { aggregateProgress } from './embedder'

/**
 * The model-download progress bar aggregates per-file byte counts into one
 * fraction. Several files (tokenizer, config, onnx weights) download at once, so
 * the combined progress must weight by bytes, not average percentages.
 */
describe('aggregateProgress', () => {
  it('returns null when no totals are known yet', () => {
    expect(aggregateProgress([])).toBeNull()
    expect(aggregateProgress([{ loaded: 0, total: 0 }])).toBeNull()
  })

  it('byte-weights across files (a big file dominates a small one)', () => {
    // 50/100 on a big file + 10/10 on a tiny one = 60/110, not the 75% a naive
    // per-file average (50% and 100%) would give.
    expect(aggregateProgress([
      { loaded: 50, total: 100 },
      { loaded: 10, total: 10 }
    ])).toBeCloseTo(60 / 110)
  })

  it('reports a single file straightforwardly', () => {
    expect(aggregateProgress([{ loaded: 25, total: 100 }])).toBe(0.25)
  })

  it('clamps to 1 if reported loaded exceeds total', () => {
    expect(aggregateProgress([{ loaded: 120, total: 100 }])).toBe(1)
  })
})
