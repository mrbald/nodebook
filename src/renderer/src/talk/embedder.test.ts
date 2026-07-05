import { describe, it, expect } from 'vitest'
import { aggregateProgress, rolePrefix, wasmThreads } from './embedder'

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

/**
 * Asymmetric retrieval models (bge, nomic-embed) need different query/document
 * wording to retrieve well; feeding the raw text both ways still "works" but
 * measurably worse. This table decides the prefix per model + role.
 */
describe('rolePrefix', () => {
  it('adds the bge query prefix only for role "query"', () => {
    expect(rolePrefix('Xenova/bge-small-en-v1.5', 'query')).toBe(
      'Represent this sentence for searching relevant passages: '
    )
    expect(rolePrefix('Xenova/bge-small-en-v1.5', 'document')).toBe('')
  })

  it('adds asymmetric nomic-embed prefixes for both roles', () => {
    expect(rolePrefix('nomic-ai/nomic-embed-text-v1.5', 'query')).toBe('search_query: ')
    expect(rolePrefix('nomic-ai/nomic-embed-text-v1.5', 'document')).toBe('search_document: ')
  })

  it('adds no prefix for MiniLM or an unrecognized model', () => {
    expect(rolePrefix('Xenova/all-MiniLM-L6-v2', 'query')).toBe('')
    expect(rolePrefix('Xenova/all-MiniLM-L6-v2', 'document')).toBe('')
    expect(rolePrefix('some/other-model', 'query')).toBe('')
  })

  it('matches on a model-id substring, surviving a mirror/org prefix', () => {
    expect(rolePrefix('some-mirror/bge-base-en-v1.5', 'query')).not.toBe('')
  })
})

/**
 * The ONNX WASM thread count: explicit setting wins, auto = half the cores
 * capped at 4, and no SharedArrayBuffer always means single-threaded (threads
 * physically need shared memory).
 */
describe('wasmThreads', () => {
  it('is 1 without SharedArrayBuffer, whatever the setting', () => {
    expect(wasmThreads(0, 12, false)).toBe(1)
    expect(wasmThreads(8, 12, false)).toBe(1)
  })

  it('auto = half the cores, capped at 4', () => {
    expect(wasmThreads(0, 4, true)).toBe(2)
    expect(wasmThreads(0, 12, true)).toBe(4)
    expect(wasmThreads(0, 1, true)).toBe(1)
    expect(wasmThreads(0, 0, true)).toBe(2) // unknown cores → assume 4
  })

  it('an explicit positive setting wins over auto', () => {
    expect(wasmThreads(8, 12, true)).toBe(8)
    expect(wasmThreads(1, 12, true)).toBe(1)
  })
})
