import { describe, it, expect } from 'vitest'
import { hashEmbedder, heuristicChat } from './stubs'
import { buildExtractionPrompt, parseExtraction, groundItems, type ChunkProvenance } from '../extract'

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // both are already L2-normalized, so the dot product is cosine
}

describe('hashEmbedder', () => {
  it('L2-normalizes every vector', async () => {
    const emb = hashEmbedder(32)
    const [v] = await emb.embed(['faction arises from the unequal distribution of property'])
    let normSq = 0
    for (const x of v) normSq += x * x
    expect(normSq).toBeCloseTo(1, 5)
  })

  it('returns a zero vector for empty text without dividing by zero', async () => {
    const emb = hashEmbedder(16)
    const [v] = await emb.embed([''])
    expect(v.length).toBe(16)
    expect([...v].every((x) => x === 0)).toBe(true)
  })

  it('is deterministic (same text, same vector, run to run)', async () => {
    const emb = hashEmbedder()
    const [a] = await emb.embed(['the same faction text twice'])
    const [b] = await emb.embed(['the same faction text twice'])
    expect(a).toEqual(b)
  })

  it('clusters same-topic prose closer than unrelated topics (real prose)', async () => {
    const emb = hashEmbedder(64)
    const faction1 =
      'Faction arises from the unequal distribution of property and from the diversity in the faculties of men.'
    const faction2 =
      'A faction is a number of citizens united by a common impulse of passion adverse to the rights of others.'
    const power =
      'Ambition must be made to counteract ambition; power must check power within the government.'
    const [f1, f2, p] = await emb.embed([faction1, faction2, power])
    const sameTopic = cosine(f1, f2)
    const crossTopic = cosine(f1, p)
    expect(sameTopic).toBeGreaterThan(crossTopic)
  })
})

// A miniature extraction prompt in the exact `buildExtractionPrompt` shape.
const CHUNKS = [
  {
    chunkId: 0,
    heading: 'Faction',
    text:
      'Faction arises from the unequal distribution of property. James Madison warned that the causes of faction are sown in the nature of man.'
  },
  {
    chunkId: 3,
    heading: 'Union',
    text: 'The Union is a safeguard against domestic faction and insurrection. It binds the several States together.'
  }
]

describe('heuristicChat', () => {
  it('answers a distill extraction prompt with valid, groundable JSON', async () => {
    const { system, user } = buildExtractionPrompt(CHUNKS)
    const chat = heuristicChat()
    let reply = ''
    for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) reply += tok

    const parsed = parseExtraction(reply)
    expect(parsed.ok).toBe(true)
    expect(parsed.items.length).toBeGreaterThan(0)
    // 1-3 items per chunk, 2 chunks.
    expect(parsed.items.length).toBeGreaterThanOrEqual(2)
    expect(parsed.items.length).toBeLessThanOrEqual(6)

    const prov = new Map<number, ChunkProvenance>(
      CHUNKS.map((c) => [c.chunkId, { file: 'Book.md', start: 0, text: c.text }])
    )
    const { notes, droppedTitles } = groundItems(parsed.items, prov)
    // Every quote is copied verbatim from its chunk, so grounding never drops one.
    expect(droppedTitles).toEqual([])
    expect(notes.length).toBe(parsed.items.length)
  })

  it('cites each item with a quote that is an exact substring of its own chunk', async () => {
    const { system, user } = buildExtractionPrompt(CHUNKS)
    const chat = heuristicChat()
    let reply = ''
    for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) reply += tok
    const { items } = parseExtraction(reply)
    const byId = new Map(CHUNKS.map((c) => [c.chunkId, c.text]))
    for (const item of items) {
      for (const ev of item.evidence) {
        expect(byId.get(ev.chunkId)).toContain(ev.quote)
      }
    }
  })

  it('links items produced in the same call to each other', async () => {
    const { system, user } = buildExtractionPrompt(CHUNKS)
    const chat = heuristicChat()
    let reply = ''
    for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) reply += tok
    const { items } = parseExtraction(reply)
    expect(items.length).toBeGreaterThan(1)
    // At least one item (every item after the first, by construction) links
    // to another item's title from the same call.
    const titles = new Set(items.map((i) => i.title))
    const linked = items.filter((i) => i.links.some((l) => titles.has(l.target)))
    expect(linked.length).toBeGreaterThan(0)
  })

  it('is deterministic for the same prompt', async () => {
    const { system, user } = buildExtractionPrompt(CHUNKS)
    const chat = heuristicChat()
    const run = async (): Promise<string> => {
      let out = ''
      for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) out += tok
      return out
    }
    expect(await run()).toEqual(await run())
  })

  it('returns the same JSON for a repair-style retry prompt (same items resent)', async () => {
    const { system, user } = buildExtractionPrompt(CHUNKS)
    const chat = heuristicChat()
    let first = ''
    for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) first += tok

    let repaired = ''
    for await (const tok of chat.chat({
      system,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: 'sorry, prose not json' },
        { role: 'user', content: 'That was not valid JSON. Reply with ONLY the JSON object, nothing else.' }
      ]
    }))
      repaired += tok

    expect(repaired).toEqual(first)
  })

  it('never invents a quote absent from every chunk it was shown', async () => {
    const oneChunk = [{ chunkId: 7, heading: '', text: 'A short chunk with no obvious capitalized proper noun here.' }]
    const { system, user } = buildExtractionPrompt(oneChunk)
    const chat = heuristicChat()
    let reply = ''
    for await (const tok of chat.chat({ system, messages: [{ role: 'user', content: user }] })) reply += tok
    const { items } = parseExtraction(reply)
    for (const item of items) {
      for (const ev of item.evidence) expect(oneChunk[0].text).toContain(ev.quote)
    }
  })

  it('handles a prompt with no recognisable chunk blocks without throwing (probe ping)', async () => {
    const chat = heuristicChat()
    let reply = ''
    for await (const tok of chat.chat({ messages: [{ role: 'user', content: 'ping' }] })) reply += tok
    expect(() => JSON.parse(reply)).not.toThrow()
  })
})
