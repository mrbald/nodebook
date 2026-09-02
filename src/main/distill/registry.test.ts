import { describe, it, expect } from 'vitest'
import { ConceptRegistry } from './registry'
import { weightOf } from '../rag/chunk'

describe('ConceptRegistry', () => {
  it('renders nothing before anything has been extracted', () => {
    expect(new ConceptRegistry().render(4000)).toBe('')
  })

  it('names the block and tells the model what to do with it', () => {
    const r = new ConceptRegistry()
    r.add(['Faction'])
    const block = r.render(4000)
    expect(block).toMatch(/reuse these exact titles/i)
    expect(block).toContain('- Faction')
  })

  it('lists the most recent concepts first', () => {
    const r = new ConceptRegistry()
    r.add(['Faction', 'Union'])
    r.add(['Ambition'])
    expect(r.titles()).toEqual(['Ambition', 'Union', 'Faction'])
  })

  it('keeps one entry per name, and a repeat moves it back to the front', () => {
    const r = new ConceptRegistry()
    r.add(['Faction', 'Union'])
    r.add(['faction'])
    // Same concept, one line — and the spelling the model used last.
    expect(r.titles()).toEqual(['faction', 'Union'])
  })

  it('ignores blank titles', () => {
    const r = new ConceptRegistry()
    r.add(['  ', '', 'Union'])
    expect(r.titles()).toEqual(['Union'])
  })

  it('cuts the list at the budget, keeping the most recent', () => {
    const r = new ConceptRegistry()
    r.add(['Alpha', 'Beta', 'Gamma', 'Delta'])
    const full = r.render(4000)
    expect(weightOf(full)).toBeLessThanOrEqual(4000)
    const cut = r.render(weightOf(full) - 8) // one line less
    expect(weightOf(cut)).toBeLessThanOrEqual(weightOf(full) - 8)
    expect(cut).toContain('- Delta') // the newest survives…
    expect(cut).not.toContain('- Alpha') // …the oldest is what drops off
  })

  it('renders nothing at all rather than a truncated instruction', () => {
    const r = new ConceptRegistry()
    r.add(['Alpha'])
    expect(r.render(10)).toBe('')
  })

  it('never exceeds the budget, whatever it is', () => {
    const r = new ConceptRegistry()
    r.add(Array.from({ length: 500 }, (_, i) => `Concept number ${i}`))
    for (const budget of [0, 50, 120, 1000, 4000]) {
      expect(weightOf(r.render(budget))).toBeLessThanOrEqual(budget)
    }
  })
})
