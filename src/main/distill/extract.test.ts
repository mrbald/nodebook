import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  parseExtraction,
  locateQuote,
  groundItems,
  type ChunkProvenance,
  type ExtractedItem
} from './extract'

describe('buildExtractionPrompt', () => {
  it('tags chunks with ids and states the grounding rule', () => {
    const { system, user } = buildExtractionPrompt([
      { chunkId: 42, heading: 'Intro', text: 'A republic checks faction.' }
    ])
    expect(system).toMatch(/no.*evidence.*no item/i)
    expect(user).toContain('[chunk 42 — Intro]')
    expect(user).toContain('A republic checks faction.')
  })
})

describe('locateQuote', () => {
  const src = 'Extend the sphere, and you take\nin a greater variety of parties.'

  it('finds an exact substring with raw offsets', () => {
    const loc = locateQuote(src, 'Extend the sphere')
    expect(loc).toEqual({ start: 0, end: 17 })
  })

  it('tolerates whitespace reflow (newline vs space)', () => {
    // The quote collapses the source newline to a single space.
    const loc = locateQuote(src, 'you take in a greater variety')!
    expect(src.slice(loc.start, loc.end)).toBe('you take\nin a greater variety')
  })

  it('returns null for missing or empty quotes, and escapes regex metachars', () => {
    expect(locateQuote(src, 'monarchy')).toBeNull()
    expect(locateQuote(src, '   ')).toBeNull()
    expect(locateQuote('a (b) c', '(b)')).toEqual({ start: 2, end: 5 })
  })
})

describe('parseExtraction', () => {
  it('parses a clean object', () => {
    const r = parseExtraction('{"items":[{"title":"Faction","kind":"concept","summary":"x","evidence":[{"chunkId":1,"quote":"q"}],"links":[]}]}')
    expect(r.ok).toBe(true)
    expect(r.items[0].title).toBe('Faction')
    expect(r.items[0].evidence[0]).toEqual({ chunkId: 1, quote: 'q' })
  })

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure:\n```json\n{ "items": [ { "title": "Republic" } ] }\n```\nDone.'
    const r = parseExtraction(raw)
    expect(r.ok).toBe(true)
    expect(r.items[0].title).toBe('Republic')
    expect(r.items[0].kind).toBe('concept') // defaulted
  })

  it('flags unparseable output so the caller can repair-retry', () => {
    expect(parseExtraction('I could not produce JSON.').ok).toBe(false)
    expect(parseExtraction('{ not json').ok).toBe(false)
    expect(parseExtraction('{"notitems":1}').ok).toBe(false)
  })

  it('drops malformed items but keeps the well-formed ones', () => {
    const r = parseExtraction('{"items":[{"summary":"no title"},{"title":"Keep","evidence":[{"chunkId":"7","quote":"q"}]}]}')
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => i.title)).toEqual(['Keep'])
    expect(r.items[0].evidence[0].chunkId).toBe(7) // coerced from string
  })
})

describe('groundItems', () => {
  const chunks = new Map<number, ChunkProvenance>([
    [1, { file: 'Federalist.md', start: 1000, text: 'Extend the sphere and take in more parties.' }]
  ])

  const item = (over: Partial<ExtractedItem>): ExtractedItem => ({
    kind: 'claim',
    title: 'T',
    summary: 's',
    evidence: [],
    links: [],
    ...over
  })

  it('keeps an item and resolves its quote to an absolute source span', () => {
    const { notes, droppedTitles } = groundItems(
      [item({ title: 'Extend the sphere', evidence: [{ chunkId: 1, quote: 'Extend the sphere' }] })],
      chunks
    )
    expect(droppedTitles).toEqual([])
    expect(notes[0].citations[0]).toMatchObject({ file: 'Federalist.md', start: 1000, end: 1017 })
  })

  it('drops an item whose quote is not in the cited chunk (the gate)', () => {
    const { notes, droppedTitles } = groundItems(
      [item({ title: 'Hallucinated', evidence: [{ chunkId: 1, quote: 'never written here' }] })],
      chunks
    )
    expect(notes).toEqual([])
    expect(droppedTitles).toEqual(['Hallucinated'])
  })

  it('keeps only the locatable evidence when an item mixes good and bad quotes', () => {
    const { notes } = groundItems(
      [item({ evidence: [{ chunkId: 1, quote: 'more parties' }, { chunkId: 1, quote: 'fabricated' }] })],
      chunks
    )
    expect(notes[0].citations.length).toBe(1)
    expect(notes[0].citations[0].quote).toBe('more parties')
  })

  it('drops evidence pointing at an unknown chunk id', () => {
    const { droppedTitles } = groundItems(
      [item({ title: 'NoChunk', evidence: [{ chunkId: 999, quote: 'whatever' }] })],
      chunks
    )
    expect(droppedTitles).toEqual(['NoChunk'])
  })
})
