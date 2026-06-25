/**
 * Reciprocal Rank Fusion — combine several ranked lists (e.g. keyword/FTS and
 * vector hits) into one ranking without needing comparable scores. Each list
 * contributes `1 / (rrfK + rank + 1)` per key; keys are summed across lists and
 * sorted descending. Pure + golden-tested; used by both the hybrid search and
 * the "Ask" grounding retrieval so they fuse identically.
 *
 * `rrfK` dampens the contribution of lower ranks; 60 is the conventional default
 * (Cormack et al.) and matches what the search box has always used.
 */
export function rrfRank(lists: string[][], rrfK = 60): string[] {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((key, rank) => {
      score.set(key, (score.get(key) ?? 0) + 1 / (rrfK + rank + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)
}
