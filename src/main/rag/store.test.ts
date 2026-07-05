import { describe, it, expect } from 'vitest'
import { topCosine, needsEmbeddingReset, ftsOrMatch } from './store'

// Note: VectorStore itself (the sqlite-vec/FTS5-backed class) is exercised
// only by the e2e suite (talk-graph, ask), not here. `better-sqlite3` is
// rebuilt against Electron's ABI by `postinstall` (electron-builder
// install-app-deps), so `new Database(...)` cannot load under plain-Node
// vitest — hence the two pure helpers below carry the unit-level coverage for
// the model-gating and chunk-search-token fixes, same pattern as `topCosine`.

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

/**
 * `talk_meta` now gates on the embedding model id, not just its dims — two
 * different models can share a width (MiniLM → bge-small, both 384) but never
 * a vector space, so a model swap must be treated exactly like a dims change:
 * `VectorStore.setDims` drops the vectors and the chunks (so the vault is
 * re-chunked under current chunking policy too) whenever this returns true.
 */
describe('needsEmbeddingReset', () => {
  it('is a no-op when both dims and model id are unchanged', () => {
    expect(needsEmbeddingReset({ dims: 384, modelId: 'model-a' }, { dims: 384, modelId: 'model-a' })).toBe(
      false
    )
  })

  it('resets on a model swap even at the same dims (the MiniLM → bge-small case)', () => {
    expect(needsEmbeddingReset({ dims: 384, modelId: 'model-a' }, { dims: 384, modelId: 'model-b' })).toBe(
      true
    )
  })

  it('resets on a plain dims change, independent of the model id', () => {
    expect(needsEmbeddingReset({ dims: 384, modelId: 'model-a' }, { dims: 768, modelId: 'model-a' })).toBe(
      true
    )
  })

  it('switching back and forth between two models keeps resetting both ways', () => {
    let current = { dims: 384, modelId: 'model-a' }
    expect(needsEmbeddingReset(current, { dims: 384, modelId: 'model-b' })).toBe(true)
    current = { dims: 384, modelId: 'model-b' }
    expect(needsEmbeddingReset(current, { dims: 384, modelId: 'model-a' })).toBe(true)
    current = { dims: 384, modelId: 'model-a' }
    expect(needsEmbeddingReset(current, { dims: 384, modelId: 'model-a' })).toBe(false)
  })

  it('omitting the model id (a legacy caller that only knows dims) never triggers a reset by itself', () => {
    expect(needsEmbeddingReset({ dims: 384, modelId: 'model-a' }, { dims: 384 })).toBe(false)
  })
})

/**
 * `chunkSearch` grounds "Ask": FTS5's implicit AND between tokens usually
 * matches nothing for a natural-language question, silently dropping the
 * keyword leg out of hybrid retrieval. `ftsOrMatch` is the fix — OR the
 * tokens instead (bm25 still ranks a chunk matching more of them higher).
 */
describe('ftsOrMatch', () => {
  it('ORs a natural-language question\'s tokens, prefix-matched', () => {
    expect(ftsOrMatch('what is the capital of France')).toBe(
      'what* OR is* OR the* OR capital* OR of* OR France*'
    )
  })

  it('returns null for a query with no word/number tokens', () => {
    expect(ftsOrMatch('   ---   ')).toBeNull()
  })

  it('tokenizes unicode letters, not just ASCII', () => {
    expect(ftsOrMatch('café résumé')).toBe('café* OR résumé*')
  })
})
