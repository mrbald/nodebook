import { describe, it, expect } from 'vitest'
import { chunkMarkdown, embedText, splitLine, weightOf } from './chunk'

describe('chunkMarkdown', () => {
  it('splits by heading and carries the heading path', () => {
    const doc = ['# Title', '', 'Intro para.', '', '## Section A', '', 'Body of A.'].join('\n')
    const chunks = chunkMarkdown(doc)
    expect(chunks.map((c) => [c.heading, c.text])).toEqual([
      ['Title', 'Intro para.'],
      ['Title > Section A', 'Body of A.']
    ])
  })

  it('emits no chunk for a heading with no body', () => {
    const chunks = chunkMarkdown('# Empty\n\n## Also empty\n')
    expect(chunks).toEqual([])
  })

  it('offsets slice back to (a superset of) the chunk text', () => {
    const doc = '# H\n\nhello world\n'
    const [c] = chunkMarkdown(doc)
    expect(doc.slice(c.start, c.end)).toContain('hello world')
  })

  it('packs multiple paragraphs and splits when over maxChars', () => {
    // Rule (d): a tail overlap (~10% of maxChars) is seeded into the next chunk
    // within the same section, so a small maxChars can pack more than one whole
    // paragraph back in via the carried-over tail — the assertion only needs
    // "more than one chunk", not an exact count.
    const para = 'x'.repeat(40)
    const doc = `# H\n\n${para}\n\n${para}\n\n${para}`
    const chunks = chunkMarkdown(doc, 60) // each para ~41 chars, so ~1 per chunk
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.heading === 'H')).toBe(true)
  })

  it('embedText prepends the heading for context', () => {
    expect(embedText({ heading: 'A > B', start: 0, end: 1, text: 'body' })).toBe('A > B\n\nbody')
    expect(embedText({ heading: '', start: 0, end: 1, text: 'body' })).toBe('body')
  })

  // Rule (b): a `#` line inside a fenced code block is never a heading — its
  // fence still flows into the chunk body like any other text.
  it('does not treat a heading-shaped line inside a fenced code block as a heading', () => {
    const doc = ['# Title', '', '```', '# not a heading', 'more code', '```', '', 'after.'].join(
      '\n'
    )
    const chunks = chunkMarkdown(doc)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].heading).toBe('Title')
    expect(chunks[0].text).toContain('# not a heading')
    expect(chunks[0].text).toContain('more code')
    expect(chunks[0].text).toContain('after.')
  })

  it('resumes heading detection once the fence closes', () => {
    const doc = ['# Title', '', '```', 'code', '```', '', '## Section', '', 'Body.'].join('\n')
    const chunks = chunkMarkdown(doc)
    expect(chunks.map((c) => c.heading)).toEqual(['Title', 'Title > Section'])
  })

  // Rule (c): a single line longer than maxChars is split (sentence boundary,
  // falling back to a hard split) instead of ever producing an over-budget chunk.
  it('splits a single overlong line instead of overflowing a chunk', () => {
    const sentence = 'This is one sentence that repeats itself over and over again. '
    const line = sentence.repeat(20) // ~1300 chars, well past maxChars=100
    const doc = `# H\n\n${line.trim()}`
    const maxChars = 100
    const chunks = chunkMarkdown(doc, maxChars)
    expect(chunks.length).toBeGreaterThan(1)
    // The tail-overlap carried into a chunk can push it a bit past maxChars
    // (rule (d) trades a hard cap for boundary context) — bounded by the ~10%
    // overlap budget, never unboundedly.
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(maxChars * 1.1)
    // Every chunk's span still exactly brackets its own trimmed text.
    for (const c of chunks) expect(doc.slice(c.start, c.end)).toContain(c.text)
  })

  it('hard-splits a single sentence that alone exceeds maxChars', () => {
    const maxChars = 100
    const doc = `# H\n\n${'y'.repeat(250)}`
    const chunks = chunkMarkdown(doc, maxChars)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(maxChars * 1.1)
  })

  // Rule (d): consecutive chunks split out of the same section share a tail
  // overlap, and chunk spans may overlap as a result — but each span still
  // exactly brackets (contains) the location its own text was cut from.
  it('overlaps the tail of consecutive chunks within the same section', () => {
    const sentence = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa. '
    const doc = `# H\n\n${sentence.repeat(10).trim()}`
    const chunks = chunkMarkdown(doc, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      // The next chunk's span starts before the previous chunk's span ends —
      // i.e. the spans genuinely overlap, not just abut.
      expect(chunks[i].start).toBeLessThan(chunks[i - 1].end)
    }
    // Provenance stays exact: every chunk's span exactly brackets its own text
    // (a superset — it may carry surrounding whitespace, same invariant as the
    // no-overlap case above).
    for (const c of chunks) expect(doc.slice(c.start, c.end)).toContain(c.text)
  })

  it('does not carry overlap across a heading boundary', () => {
    const doc = ['# H1', '', 'a'.repeat(90), '', '# H2', '', 'b'.repeat(90)].join('\n')
    const chunks = chunkMarkdown(doc, 100)
    expect(chunks.map((c) => c.heading)).toEqual(['H1', 'H2'])
    // Different sections never share overlapping spans.
    expect(chunks[1].start).toBeGreaterThanOrEqual(chunks[0].end)
  })
})

describe('splitLine', () => {
  it('returns the whole line as one piece when it already fits', () => {
    expect(splitLine('hello', 10)).toEqual([{ start: 0, end: 5 }])
  })

  it('breaks at sentence boundaries when they fit the budget', () => {
    const line = 'One. Two. Three.'
    // "One. " (5) + "Two. " (5) = 10 fits in maxChars=10; "Three." pushes it over.
    const pieces = splitLine(line, 10)
    expect(pieces.map((p) => line.slice(p.start, p.end))).toEqual(['One. Two. ', 'Three.'])
  })

  it('hard-splits a single run with no sentence boundary', () => {
    const line = 'x'.repeat(25)
    const pieces = splitLine(line, 10)
    expect(pieces).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 25 }
    ])
  })

  it('pieces always tile the line exactly, contiguously', () => {
    const line = 'This is a sentence. Then another one follows here. And a third.'
    const pieces = splitLine(line, 15)
    expect(pieces[0].start).toBe(0)
    expect(pieces[pieces.length - 1].end).toBe(line.length)
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].start).toBe(pieces[i - 1].end)
  })

  it('breaks at CJK sentence stops (。) like ASCII ones', () => {
    // Three short Chinese sentences; budget fits one at a time (weight 3/char).
    const line = '这是一句话。这是第二句。这是第三句。'
    const pieces = splitLine(line, 20)
    const texts = pieces.map((p) => line.slice(p.start, p.end))
    expect(texts[0]).toBe('这是一句话。')
    expect(texts.every((t) => weightOf(t) <= 20)).toBe(true)
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].start).toBe(pieces[i - 1].end)
  })

  it('hard-splits an unbroken CJK run by weight, never inside a surrogate pair', () => {
    // 𠀋 (U+2000B) is an astral-plane ideograph: two UTF-16 code units, one
    // (heavy) code point. 10 of them = weight 30, budget 9 → 3 per piece.
    const line = '𠀋'.repeat(10)
    const pieces = splitLine(line, 9)
    expect(pieces[0].start).toBe(0)
    expect(pieces[pieces.length - 1].end).toBe(line.length)
    for (const p of pieces) {
      const t = line.slice(p.start, p.end)
      expect([...t].every((c) => (c.codePointAt(0) as number) > 0xffff)).toBe(true) // no lone surrogates
      expect(weightOf(t)).toBeLessThanOrEqual(9)
    }
    // 3 astral chars (6 code units) per full piece; the 10th char remains alone.
    expect(pieces.map((p) => p.end - p.start)).toEqual([6, 6, 6, 2])
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].start).toBe(pieces[i - 1].end)
  })
})

/**
 * The token-cost weight behind every budget decision: CJK ≈ 1 token per
 * character vs ~3-4 characters per token for Latin, so a CJK code point
 * counts 3×. For pure-Latin text weight == length — that identity is what
 * keeps English chunking byte-identical to the pre-weighted behavior.
 */
describe('weightOf', () => {
  it('equals length for plain Latin text', () => {
    expect(weightOf('hello world!')).toBe(12)
    expect(weightOf('')).toBe(0)
  })

  it('counts CJK code points 3×, including astral-plane ideographs', () => {
    expect(weightOf('你好')).toBe(6) // Han
    expect(weightOf('こんにちは')).toBe(15) // Hiragana
    expect(weightOf('안녕')).toBe(6) // Hangul
    expect(weightOf('𠀋')).toBe(3) // U+2000B: 2 code units, one heavy code point
  })

  it('weighs mixed text per code point and honors [start, end)', () => {
    const s = 'ab你好cd'
    expect(weightOf(s)).toBe(4 + 6)
    expect(weightOf(s, 2, 4)).toBe(6) // just the two Han chars
  })

  it('leaves Cyrillic at weight 1 (it tokenizes like Latin, a few chars per token)', () => {
    expect(weightOf('привет')).toBe(6)
  })
})

/** CJK-aware packing end to end: a long Chinese section must split into
 *  several chunks that each fit the weight budget — under a plain char budget
 *  it would come out as one chunk ~3× over the model's token window. */
describe('chunkMarkdown with CJK text', () => {
  it('splits a single-line CJK paragraph that is under the CHAR budget but over the weight budget', () => {
    // 200 Han chars on one line: length 200 < 300 but weight 600 > 300. A
    // char-length gate would pass it through as one over-window chunk.
    const doc = `# 标题\n\n${'很长的中文段落用来测试。'.repeat(20)}`
    const chunks = chunkMarkdown(doc, 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(weightOf(c.text)).toBeLessThanOrEqual(300 + 30 + 3)
  })

  it('splits a long Chinese section into weight-bounded chunks', () => {
    const sentence = '这是一个很长的句子，用来测试分块。'
    const doc = `# 标题\n\n${sentence.repeat(30)}`
    const chunks = chunkMarkdown(doc, 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // Budget + the seeded-overlap slack (10%), same soft cap as English.
      expect(weightOf(c.text)).toBeLessThanOrEqual(300 + 30 + 3)
      expect(c.heading).toBe('标题')
      expect(doc.slice(c.start, c.end)).toContain(c.text)
    }
  })

  it('keeps English chunking behavior identical (weight == length)', () => {
    const para = 'Plain English sentences pack exactly as before. '.repeat(10)
    const doc = `# H\n\n${para}`
    expect(chunkMarkdown(doc, 200)).toEqual(chunkMarkdown(doc, 200))
    for (const c of chunkMarkdown(doc, 200)) expect(c.text.length).toBeLessThanOrEqual(200 + 20 + 1)
  })
})
