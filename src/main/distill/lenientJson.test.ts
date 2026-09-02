import { describe, it, expect } from 'vitest'
import { escapeStrayQuotes, outerObject, parseLenientObject } from './lenientJson'
import { EXTRACTION_KEYS as KEYS } from './extract'

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
    expect(escapeStrayQuotes(text, KEYS)).toBe(text) // same reference: nothing to mend
    expect(parseLenientObject(`prose ${text} prose`, KEYS)).toEqual(JSON.parse(text))
  })

  it.each(REAL)('mends the real failure: %s', (summary) => {
    expect(() => JSON.parse(outerObject(reply(summary))!)).toThrow()
    const parsed = parseLenientObject(reply(summary), KEYS) as Parsed
    expect(parsed.items[0].summary).toBe(summary)
  })

  it('mends stray quotes inside an array element string', () => {
    const quote = 'tips.groupby(["day", "smoker"])'
    const parsed = parseLenientObject(reply('s', quote), KEYS) as Parsed
    expect(parsed.items[0].evidence[0].quote).toBe(quote)
  })

  it('mends a brace-shaped quote in the LAST member of an object', () => {
    const raw = '{"items":[{"title":"T","summary":"a dict like {"a": 1} here"}]}'
    const parsed = parseLenientObject(raw, KEYS) as Parsed
    expect(parsed.items[0].summary).toBe('a dict like {"a": 1} here')
  })

  it('keeps keys and real closers intact while mending values', () => {
    const raw = '{"items":[{"title":"the "x" flag","summary":"see "y"","links":[{"relation":"about","target":"the "z""}]}]}'
    const parsed = parseLenientObject(raw, KEYS) as { items: { title: string; summary: string; links: { target: string }[] }[] }
    expect(parsed.items[0].title).toBe('the "x" flag')
    expect(parsed.items[0].summary).toBe('see "y"')
    expect(parsed.items[0].links[0].target).toBe('the "z"')
  })

  it('gives up on what is not JSON at all', () => {
    expect(parseLenientObject('I could not produce JSON.', KEYS)).toBeUndefined()
    expect(parseLenientObject('{ not json', KEYS)).toBeUndefined()
    expect(parseLenientObject('{"items": [ {"title": "unterminated }', KEYS)).toBeUndefined()
  })

  it('does not end a field at a quoted word that is followed by a made-up key', () => {
    // Found in review: prose quoting a dict literal. `"x","age": 5}` looks like
    // the end of one member and the start of another — and the rest happened
    // to be valid JSON, so the reply parsed clean with `summary` cut at "x"
    // and an `age` field invented. A comma may only introduce a schema key.
    const raw = '{"items":[{"title":"T","summary":"pass {"name":"x","age": 5} to it","evidence":[]}]}'
    const parsed = parseLenientObject(raw, KEYS) as Parsed
    expect(parsed.items[0].summary).toBe('pass {"name":"x","age": 5} to it')
    // The same shape where the made-up member's own value carries a stray
    // quote: a padded member from a model is clean, so this reads as prose.
    const themed = '{"themes":[{"index":0,"name":"say "a","id": "b"c"}]}'
    const t = parseLenientObject(themed, new Set(['themes', 'index', 'name'])) as { themes: { name: string }[] }
    expect(t.themes[0].name).toBe('say "a","id": "b"c')
  })

  it('keeps a member the schema does not know, and a run of them', () => {
    // A model padding the reply with fields of its own: a real closing quote
    // before an unknown key must still close, or the mend would swallow the
    // extra member into the string before it.
    const raw =
      '{"items":[{"title":"the "x" flag","summary":"s","confidence":"high","note":{"a":[1,2]},"n":3,"evidence":[]}]}'
    const parsed = parseLenientObject(raw, KEYS) as { items: Record<string, unknown>[] }
    expect(parsed.items[0].title).toBe('the "x" flag')
    expect(parsed.items[0].summary).toBe('s')
    expect(parsed.items[0].confidence).toBe('high')
    expect(parsed.items[0].n).toBe(3)
    // …and a dict literal whose keys are all unknown still does not end the field:
    // its closing brace is followed by prose, not by a separator.
    const dict = '{"items":[{"title":"T","summary":"map {"a":"x","b":"y","c":"z"} then","evidence":[]}]}'
    expect((parseLenientObject(dict, KEYS) as Parsed).items[0].summary).toBe('map {"a":"x","b":"y","c":"z"} then')
  })

  it('reads prose that mimics a member with an unknown key, and fails loudly on a known one', () => {
    const unknown = '{"items":[{"summary":"he said "yes", "no": maybe","title":"T"}]}'
    expect((parseLenientObject(unknown, KEYS) as Parsed).items[0].summary).toBe('he said "yes", "no": maybe')
    // The residual case — the text names one of the schema's own keys — ends
    // the field early, and the mended text then fails strict parsing: the
    // caller gets undefined and makes its repair call, never a wrong parse.
    const known = '{"items":[{"summary":"a "b","title": 5","title":"T"}]}'
    expect(parseLenientObject(known, KEYS)).toBeUndefined()
  })
})
