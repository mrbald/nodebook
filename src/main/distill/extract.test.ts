import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  parseExtraction,
  locateQuote,
  groundItems,
  relationOf,
  RELATIONS,
  FALLBACK_RELATION,
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

  it('pins the output language to the source language (a Russian book yields Russian notes)', () => {
    const { system } = buildExtractionPrompt([{ chunkId: 1, heading: '', text: 'Дао рождает одно.' }])
    expect(system).toMatch(/same\s+language/i)
    expect(system).toMatch(/never\s+translate/i)
  })

  it('carries the concepts earlier windows named, after the schema', () => {
    const chunks = [{ chunkId: 7, heading: '', text: 'Faction returns here.' }]
    const registry = 'Known concepts so far — reuse these exact titles:\n- Faction'
    const { system, user } = buildExtractionPrompt(chunks, { registry })
    expect(system).toContain('- Faction')
    // After the schema, so the shape of the answer is stated before the names
    // it may reuse — and never mixed into the source chunks themselves.
    expect(system.indexOf('- Faction')).toBeGreaterThan(system.indexOf('"items"'))
    expect(user).not.toContain('- Faction')
  })

  it('says nothing about known concepts on the first window', () => {
    const chunks = [{ chunkId: 0, heading: '', text: 'A first passage.' }]
    expect(buildExtractionPrompt(chunks).system).not.toMatch(/known concepts/i)
    expect(buildExtractionPrompt(chunks, { registry: '   ' }).system).not.toMatch(/known concepts/i)
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

  it('folds curly quotes to their plain equivalent', () => {
    const curly = 'She whispered, “Don’t stop now.”'
    const loc = locateQuote(curly, '"Don\'t stop now."')!
    expect(curly.slice(loc.start, loc.end)).toBe('“Don’t stop now.”')
  })

  it('folds em/en dashes to a plain hyphen', () => {
    const dashed = 'Progress—not perfection—is the goal.'
    const loc = locateQuote(dashed, 'Progress-not perfection-is the goal.')!
    expect(dashed.slice(loc.start, loc.end)).toBe('Progress—not perfection—is the goal.')
  })

  it('folds the ellipsis glyph to three dots (and back)', () => {
    const ell = 'We hold these truths…self-evident.'
    const loc = locateQuote(ell, 'We hold these truths...self-evident.')!
    expect(ell.slice(loc.start, loc.end)).toBe('We hold these truths…self-evident.')
  })

  it('matches case-insensitively while returning the source casing', () => {
    const cased = 'The Constitution protects LIBERTY.'
    const loc = locateQuote(cased, 'the constitution protects liberty.')!
    expect(cased.slice(loc.start, loc.end)).toBe('The Constitution protects LIBERTY.')
  })

  it('combines case-folding with whitespace reflow', () => {
    const mixed = 'Extend the sphere, and\nyou take in a greater variety.'
    const loc = locateQuote(mixed, 'YOU TAKE IN A greater variety')!
    expect(mixed.slice(loc.start, loc.end)).toBe('you take in a greater variety')
  })

  // The fold table, one case per source of noise a converted document carries.
  it('ignores a soft hyphen inside a word', () => {
    const soft = 'The consti\u00adtution protects liberty.'
    const loc = locateQuote(soft, 'constitution protects liberty')!
    expect(soft.slice(loc.start, loc.end)).toBe('consti\u00adtution protects liberty')
  })

  it('joins a word hyphenated across a line break', () => {
    const wrapped = 'The consti-\n  tution protects liberty.'
    const loc = locateQuote(wrapped, 'constitution protects liberty')!
    expect(wrapped.slice(loc.start, loc.end)).toBe('consti-\n  tution protects liberty')
  })

  it('joins a word broken with a soft hyphen at a line end', () => {
    const wrapped = 'The consti\u00ad\ntution protects liberty.'
    expect(locateQuote(wrapped, 'constitution protects liberty')).not.toBeNull()
  })

  it('keeps a hyphen that is not a line-end break', () => {
    // Only a hyphen AT a line end, continued in lower case, is a typesetter's
    // break. A mid-line compound keeps its hyphen, and "Anti-\nFederalist" —
    // continued with a capital — is a real compound too, not a broken word.
    expect(locateQuote('a well-known fact', 'wellknown fact')).toBeNull()
    expect(locateQuote('The Anti-\nFederalist papers.', 'AntiFederalist papers')).toBeNull()
  })

  it('folds typographic ligatures to their letters', () => {
    const lig = 'The \ufb01rst di\ufb03cult e\ufb00ort a\ufb04uent \ufb02ows.'
    const loc = locateQuote(lig, 'first difficult effort affluent flows')!
    expect(lig.slice(loc.start, loc.end)).toBe('\ufb01rst di\ufb03cult e\ufb00ort a\ufb04uent \ufb02ows')
  })

  it('treats NBSP and other Unicode spaces as ordinary whitespace', () => {
    const spaced = 'Extend\u00a0the\u2009sphere\u202fand\u2003take.'
    const loc = locateQuote(spaced, 'Extend the sphere and take.')!
    expect(spaced.slice(loc.start, loc.end)).toBe(spaced)
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

  it('folds every link onto the controlled relation vocabulary', () => {
    const raw = JSON.stringify({
      items: [
        {
          title: 'Faction',
          links: [
            { relation: 'Part Of', target: 'A' },
            { relation: 'contrasts-with', target: 'B' },
            { relation: 'is a kind of', target: 'C' },
            { target: 'D' }
          ]
        }
      ]
    })
    expect(parseExtraction(raw).items[0].links).toEqual([
      { relation: 'part_of', target: 'A' },
      { relation: 'contrasts_with', target: 'B' },
      { relation: 'related_to', target: 'C' },
      { relation: 'related_to', target: 'D' }
    ])
  })

  it('still drops a link with no target at all', () => {
    const raw = '{"items":[{"title":"Faction","links":[{"relation":"about"}]}]}'
    expect(parseExtraction(raw).items[0].links).toEqual([])
  })
})

describe('relationOf', () => {
  it('keeps a vocabulary relation, forgiving case and separators', () => {
    for (const r of RELATIONS) expect(relationOf(r)).toBe(r)
    expect(relationOf('  DEPENDS ON ')).toBe('depends_on')
    expect(relationOf('example-of')).toBe('example_of')
  })

  it('folds anything else to the one honest fallback', () => {
    expect(relationOf('is a kind of')).toBe(FALLBACK_RELATION)
    expect(relationOf('')).toBe(FALLBACK_RELATION)
    expect(relationOf('mentions')).toBe(FALLBACK_RELATION) // link.ts writes those, not the model
  })
})

describe('buildExtractionPrompt vocabulary', () => {
  it('offers exactly the controlled relations, and says to use only those', () => {
    const { system } = buildExtractionPrompt([{ chunkId: 1, heading: '', text: 't' }])
    for (const r of RELATIONS) expect(system).toContain(`"${r}"`)
    expect(system).toMatch(/only the listed relation values/i)
    expect(system).not.toContain(`"${FALLBACK_RELATION}"`)
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
    const { notes, droppedTitles, dropped, recovered } = groundItems(
      [item({ title: 'Extend the sphere', evidence: [{ chunkId: 1, quote: 'Extend the sphere' }] })],
      chunks
    )
    expect(droppedTitles).toEqual([])
    expect(notes[0].citations[0]).toMatchObject({ file: 'Federalist.md', start: 1000, end: 1017 })
    expect(dropped).toEqual({ noEvidence: 0, notFound: 0, ambiguous: 0 })
    expect(recovered).toBe(0)
  })

  it('drops an item whose quote is not in the cited chunk (the gate)', () => {
    const { notes, droppedTitles, dropped } = groundItems(
      [item({ title: 'Hallucinated', evidence: [{ chunkId: 1, quote: 'never written here' }] })],
      chunks
    )
    expect(notes).toEqual([])
    expect(droppedTitles).toEqual(['Hallucinated'])
    expect(dropped.notFound).toBe(1)
  })

  it('keeps only the locatable evidence when an item mixes good and bad quotes', () => {
    const { notes, dropped } = groundItems(
      [item({ evidence: [{ chunkId: 1, quote: 'more parties' }, { chunkId: 1, quote: 'fabricated' }] })],
      chunks
    )
    expect(notes[0].citations.length).toBe(1)
    expect(notes[0].citations[0].quote).toBe('more parties')
    expect(dropped.notFound).toBe(1)
  })

  it('drops evidence pointing at an unknown chunk id', () => {
    const { droppedTitles, dropped } = groundItems(
      [item({ title: 'NoChunk', evidence: [{ chunkId: 999, quote: 'whatever' }] })],
      chunks
    )
    expect(droppedTitles).toEqual(['NoChunk'])
    expect(dropped.notFound).toBe(1)
  })

  it('counts an item the model backed with no quote at all as noEvidence', () => {
    const { droppedTitles, dropped } = groundItems([item({ title: 'Unsupported' })], chunks)
    expect(droppedTitles).toEqual(['Unsupported'])
    expect(dropped).toEqual({ noEvidence: 1, notFound: 0, ambiguous: 0 })
  })
})

/**
 * The fallback chain: a quote the model tagged with the wrong chunk id is
 * recovered — but only when the match is unique. Never a guess.
 */
describe('groundItems fallbacks', () => {
  const A = 'Extend the sphere and take in more parties.'
  const B = 'Ambition must be made to counteract ambition.'
  const C = 'The accumulation of all powers is tyranny.'
  const REPEATED = 'Liberty is to faction what air is to fire.'
  // One document holding all four passages, at known offsets.
  const doc = [A, B, C, REPEATED, 'A later page repeats: ' + REPEATED].join('\n\n')
  const at = (t: string): number => doc.indexOf(t)
  const chunks = new Map<number, ChunkProvenance>([
    [0, { file: 'Book.md', start: at(A), text: A }],
    [1, { file: 'Book.md', start: at(B), text: B }],
    [2, { file: 'Book.md', start: at(C), text: C }],
    [3, { file: 'Book.md', start: at(REPEATED), text: REPEATED }]
  ])
  const window = (): number[] => [0, 1, 2]
  const item = (evidence: ExtractedItem['evidence'], title = 'T'): ExtractedItem => ({
    kind: 'claim',
    title,
    summary: 's',
    evidence,
    links: []
  })

  it('recovers a quote cited under the wrong chunk of the same call, with the corrected id', () => {
    const { notes, dropped, recovered } = groundItems(
      [item([{ chunkId: 0, quote: 'counteract ambition' }])],
      chunks,
      { windowOf: window, fullText: doc }
    )
    expect(recovered).toBe(1)
    expect(dropped).toEqual({ noEvidence: 0, notFound: 0, ambiguous: 0 })
    const c = notes[0].citations[0]
    expect(c.chunkId).toBe(1) // corrected from the model's 0
    expect(doc.slice(c.start, c.end)).toBe('counteract ambition')
  })

  it('recovers from the whole document when the window does not hold the quote', () => {
    const { notes, recovered } = groundItems(
      [item([{ chunkId: 0, quote: 'accumulation of all powers' }])],
      chunks,
      { windowOf: () => [0, 1], fullText: doc } // chunk 2 was not in the call
    )
    expect(recovered).toBe(1)
    const c = notes[0].citations[0]
    expect(c.chunkId).toBe(2)
    expect(doc.slice(c.start, c.end)).toBe('accumulation of all powers')
  })

  it('drops a quote that occurs twice in the document as ambiguous, never guessing', () => {
    const { notes, droppedTitles, dropped, recovered } = groundItems(
      [item([{ chunkId: 0, quote: 'air is to fire' }], 'Twice')],
      chunks,
      { windowOf: window, fullText: doc }
    )
    expect(notes).toEqual([])
    expect(droppedTitles).toEqual(['Twice'])
    expect(dropped).toEqual({ noEvidence: 0, notFound: 0, ambiguous: 1 })
    expect(recovered).toBe(0)
  })

  it('drops a quote that is nowhere in the document as notFound', () => {
    const { dropped } = groundItems(
      [item([{ chunkId: 0, quote: 'a sentence no author wrote' }], 'Absent')],
      chunks,
      { windowOf: window, fullText: doc }
    )
    expect(dropped).toEqual({ noEvidence: 0, notFound: 1, ambiguous: 0 })
  })

  it('is ambiguous, not recovered, when two window chunks each hold the quote once', () => {
    const twins = new Map<number, ChunkProvenance>([
      [0, { file: 'B.md', start: 0, text: 'nothing to see' }],
      [1, { file: 'B.md', start: 100, text: 'a shared sentence' }],
      [2, { file: 'B.md', start: 200, text: 'a shared sentence' }]
    ])
    const { dropped, recovered } = groundItems(
      [item([{ chunkId: 0, quote: 'a shared sentence' }])],
      twins,
      { windowOf: () => [0, 1, 2] } // no fullText: the window's verdict stands
    )
    expect(recovered).toBe(0)
    expect(dropped.ambiguous).toBe(1)
  })

  it('counts a point with no quote at all separately from a missing quote', () => {
    const { dropped } = groundItems(
      [
        item([], 'No quote'),
        item([{ chunkId: 0, quote: 'not in the book' }], 'Bad quote')
      ],
      chunks,
      { windowOf: window, fullText: doc }
    )
    expect(dropped).toEqual({ noEvidence: 1, notFound: 1, ambiguous: 0 })
  })

  it('still grounds against the cited chunk alone when no fallbacks are given', () => {
    const { notes, recovered } = groundItems([item([{ chunkId: 1, quote: 'Ambition must be made' }])], chunks)
    expect(notes[0].citations[0].chunkId).toBe(1)
    expect(recovered).toBe(0)
  })
})
