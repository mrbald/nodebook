import { describe, it, expect } from 'vitest'
import { escapeStrayQuotes, outerObject, parseLenientObject } from './lenientJson'

// The four shapes that actually failed over a 171-window book (Sonnet,
// 2026-09-02): Python literals with double quotes inside a summary string.
const REAL = [
  'When selecting multiple values from a labeled Series, a list like ["c", "a", "d"] is interpreted as a list of indices',
  'fillna fills in missing data with some value or using an interpolation method such as forward fill ("ffill") or backward fill ("bfill").',
  'The DataFrame.join method is used to merge a dummy-variable DataFrame with other data, such as combining df["data1"] with a dummies DataFrame.',
  'The tips dataset is grouped by the day and smoker columns using tips.groupby(["day", "smoker"]) to demonstrate multiple-key grouping'
]

function reply(summary: string, quote = 'q'): string {
  return (
    '```json\n{\n  "language": "English",\n  "items": [\n    {\n      "kind": "concept",\n' +
    `      "title": "T",\n      "summary": "${summary}",\n` +
    `      "evidence": [ { "chunkId": 3, "quote": "${quote}" } ],\n` +
    '      "links": [ { "relation": "about", "target": "X" } ]\n    }\n  ]\n}\n```'
  )
}

type Parsed = { items: { summary: string; evidence: { quote: string }[] }[] }

describe('parseLenientObject', () => {
  it('reads strict JSON without touching it', () => {
    const text = '{"items":[{"title":"He said \\"hi\\"","summary":"a, \\"b\\": c"}]}'
    expect(escapeStrayQuotes(text)).toBe(text) // same reference: nothing to mend
    expect(parseLenientObject(`prose ${text} prose`)).toEqual(JSON.parse(text))
  })

  it.each(REAL)('mends the real failure: %s', (summary) => {
    expect(() => JSON.parse(outerObject(reply(summary))!)).toThrow()
    const parsed = parseLenientObject(reply(summary)) as Parsed
    expect(parsed.items[0].summary).toBe(summary)
  })

  it('mends stray quotes inside an array element string', () => {
    const quote = 'tips.groupby(["day", "smoker"])'
    const parsed = parseLenientObject(reply('s', quote)) as Parsed
    expect(parsed.items[0].evidence[0].quote).toBe(quote)
  })

  it('mends a brace-shaped quote in the LAST member of an object', () => {
    const raw = '{"items":[{"title":"T","summary":"a dict like {"a": 1} here"}]}'
    const parsed = parseLenientObject(raw) as Parsed
    expect(parsed.items[0].summary).toBe('a dict like {"a": 1} here')
  })

  it('keeps keys and real closers intact while mending values', () => {
    const raw = '{"items":[{"title":"the "x" flag","summary":"see "y"","links":[{"relation":"about","target":"the "z""}]}]}'
    const parsed = parseLenientObject(raw) as { items: { title: string; summary: string; links: { target: string }[] }[] }
    expect(parsed.items[0].title).toBe('the "x" flag')
    expect(parsed.items[0].summary).toBe('see "y"')
    expect(parsed.items[0].links[0].target).toBe('the "z"')
  })

  it('gives up on what is not JSON at all', () => {
    expect(parseLenientObject('I could not produce JSON.')).toBeUndefined()
    expect(parseLenientObject('{ not json')).toBeUndefined()
    expect(parseLenientObject('{"items": [ {"title": "unterminated }')).toBeUndefined()
  })

  it('never returns a wrong parse when the text mimics the grammar', () => {
    // A value that looks like `", "key": ` — the early close makes the mended
    // text invalid, so the caller gets undefined, not a truncated summary.
    const raw = '{"items":[{"summary":"he said "yes", "no": maybe","title":"T"}]}'
    expect(parseLenientObject(raw)).toBeUndefined()
  })
})
