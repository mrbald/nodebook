import { describe, it, expect } from 'vitest'
import { computeMetrics, type EvalDistillResult, type GoldenSet } from './metrics'
import type { EmittedNote } from '../emit'

/** Build an `EmittedNote` whose markdown matches what `emit.ts` actually
 *  produces (single-colon frontmatter, double-colon body links) — the shape
 *  `computeMetrics`'s link parser must read the same way `harvest()` does. */
function note(name: string, links: { key: string; target: string }[], opts: { source?: string } = {}): EmittedNote {
  const fields = [
    ...(opts.source ? [`source:: [[${opts.source}]]`] : []),
    ...links.map((l) => `${l.key}:: [[${l.target}]]`)
  ]
  const content = ['---', 'kind: concept', '---', '', `# ${name}`, '', ...fields, '', 'Summary.', ''].join('\n')
  return { name, fileName: `${name}.md`, content }
}

const stats = { coverage: 0.5, dropped: 2, failedClusters: 1, merged: 3 }

function result(notes: EmittedNote[], overrides: Partial<typeof stats> = {}): EvalDistillResult {
  return { notes, stats: { ...stats, ...overrides } }
}

describe('computeMetrics — reference-free', () => {
  it('computes yieldPer10k from source weight and note count', () => {
    const source = 'a'.repeat(20_000) // pure Latin: weightOf === length
    const notes = [note('A', []), note('B', []), note('C', []), note('D', [])]
    const m = computeMetrics(source, result(notes))
    expect(m.yieldPer10k).toBeCloseTo(2) // 4 notes / (20000/10000)
  })

  it('returns 0 yield for empty source rather than dividing by zero', () => {
    const m = computeMetrics('', result([]))
    expect(m.yieldPer10k).toBe(0)
    expect(Number.isFinite(m.yieldPer10k)).toBe(true)
  })

  it('passes stats through unchanged', () => {
    const m = computeMetrics('text', result([], { coverage: 0.75, dropped: 5, failedClusters: 2, merged: 7 }))
    expect(m.coverage).toBe(0.75)
    expect(m.dropped).toBe(5)
    expect(m.failedClusters).toBe(2)
    expect(m.merged).toBe(7)
  })

  it('counts non-source relation links per note, ignoring source:: and frontmatter', () => {
    const notes = [
      note('A', [{ key: 'about', target: 'B' }], { source: 'Book' }),
      note('B', [], { source: 'Book' })
    ]
    const m = computeMetrics('x', result(notes))
    expect(m.edgesPerNote).toBeCloseTo(0.5) // 1 relation link / 2 notes
  })

  it('flags a link whose target is not an emitted note as a ghost, excluding source::', () => {
    const notes = [
      note('A', [{ key: 'about', target: 'B' }, { key: 'about', target: 'Nowhere' }], { source: 'Book' }),
      note('B', [], { source: 'Book' })
    ]
    const m = computeMetrics('x', result(notes))
    // 2 relation links (source:: excluded), 1 targets a real note (B), 1 is a ghost.
    expect(m.ghostLinkRate).toBeCloseTo(0.5)
  })

  it('reports 0 ghostLinkRate when there are no relation links at all', () => {
    const m = computeMetrics('x', result([note('A', [], { source: 'Book' })]))
    expect(m.ghostLinkRate).toBe(0)
  })

  it('counts connected components over non-source links between real notes', () => {
    const notes = [
      note('A', [{ key: 'about', target: 'B' }]),
      note('B', []),
      note('C', []) // isolated — its own component
    ]
    const m = computeMetrics('x', result(notes))
    expect(m.components).toBe(2) // {A,B}, {C}
  })

  it('a ghost link does not merge components (there is no second node)', () => {
    const notes = [note('A', [{ key: 'about', target: 'Ghost' }]), note('B', [])]
    const m = computeMetrics('x', result(notes))
    expect(m.components).toBe(2)
  })

  it('flags near-duplicate titles via trigram similarity', () => {
    // "Judicial Review"/"Judicial Reviews" clear the 0.82 trigram bar (0.824);
    // the shorter "Faction"/"Factions" pair does not (0.667) — the bar is on
    // the character trigrams, not on being "obviously" the same word.
    const notes = [note('Judicial Review', []), note('Judicial Reviews', []), note('Liberty', [])]
    const m = computeMetrics('x', result(notes))
    expect(m.duplicateTitleRate).toBeCloseTo(2 / 3)
  })

  it('reports 0 duplicateTitleRate for an empty note set', () => {
    const m = computeMetrics('x', result([]))
    expect(m.duplicateTitleRate).toBe(0)
  })

  it('every core metric is a finite number', () => {
    const notes = [note('A', [{ key: 'about', target: 'B' }]), note('B', [])]
    const m = computeMetrics('some text', result(notes))
    for (const [k, v] of Object.entries(m)) expect(Number.isFinite(v), k).toBe(true)
  })
})

describe('computeMetrics — golden set', () => {
  const golden: GoldenSet = {
    concepts: [
      { title: 'Faction', aliases: ['factions'] },
      // "Judicial Reviews" (below) clears 0.82 trigram similarity against
      // this title (0.824) without being equal after normalizing — a real
      // fuzzy match, not the exact-equality branch.
      { title: 'Judicial Review' },
      { title: 'Republic', aliases: ['republican government'] },
      { title: 'Unmentioned Concept' }
    ],
    edges: [
      ['Faction', 'Judicial Review'],
      ['Faction', 'Republic'],
      ['Judicial Review', 'Unmentioned Concept']
    ]
  }

  it('omits golden fields when no golden set is given', () => {
    const m = computeMetrics('x', result([note('A', [])]))
    expect(m.conceptRecall).toBeUndefined()
    expect(m.edgePrecision).toBeUndefined()
    expect(m.edgeRecall).toBeUndefined()
  })

  it('matches concepts by exact title, alias, and trigram fuzz', () => {
    const notes = [
      note('Faction', []), // exact title match
      note('republican government', []), // exact alias match
      note('Judicial Reviews', []) // fuzzy match on "Judicial Review" (0.824 similarity)
    ]
    const m = computeMetrics('x', result(notes), golden)
    // 3 of 4 golden concepts matched (Faction, Republic via alias, Judicial
    // Review via fuzz); "Unmentioned Concept" has no emitted counterpart.
    expect(m.conceptRecall).toBeCloseTo(3 / 4)
  })

  it('resolves an emitted edge to a golden pair and scores precision/recall', () => {
    const notes = [
      note('Faction', [{ key: 'about', target: 'Judicial Review' }]),
      note('Judicial Review', [])
    ]
    const m = computeMetrics('x', result(notes), golden)
    // One predicted edge (Faction–Judicial Review), and it matches a golden edge.
    expect(m.edgePrecision).toBeCloseTo(1)
    // Only 1 of the 3 golden edges was found (Faction–Republic and Judicial
    // Review–Unmentioned Concept were never emitted).
    expect(m.edgeRecall).toBeCloseTo(1 / 3)
  })

  it('an edge to a non-golden target lowers precision without raising recall', () => {
    const notes = [
      note('Faction', [
        { key: 'about', target: 'Judicial Review' },
        { key: 'about', target: 'Nothing To Do With Golden' }
      ]),
      note('Judicial Review', [])
    ]
    const m = computeMetrics('x', result(notes), golden)
    expect(m.edgePrecision).toBeCloseTo(0.5) // 1 of 2 predicted edges resolves correctly
  })

  it('scores 0 precision (not 1) when nothing was predicted', () => {
    const m = computeMetrics('x', result([note('Solo', [])]), golden)
    expect(m.edgePrecision).toBe(0)
  })

  it('scores vacuous 1 recall/precision-adjacent cases when the golden set is empty', () => {
    const empty: GoldenSet = { concepts: [], edges: [] }
    const m = computeMetrics('x', result([note('A', [])]), empty)
    expect(m.conceptRecall).toBe(1)
    expect(m.edgeRecall).toBe(1)
  })

  it('every golden metric is a finite number in [0, 1]', () => {
    const notes = [note('Faction', [{ key: 'about', target: 'Judicial Review' }]), note('Judicial Review', [])]
    const m = computeMetrics('x', result(notes), golden)
    for (const k of ['conceptRecall', 'edgePrecision', 'edgeRecall'] as const) {
      expect(Number.isFinite(m[k])).toBe(true)
      expect(m[k]).toBeGreaterThanOrEqual(0)
      expect(m[k]).toBeLessThanOrEqual(1)
    }
  })
})
