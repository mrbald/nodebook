import { describe, it, expect } from 'vitest'
import { distill, probeChat, DistillAborted, type DistillProgress } from './run'
import type { Embedder, ChatModel } from '../rag/provider'

// A small two-topic corpus: three "faction" sections, three "power" sections.
const SRC = [
  '# Book',
  '',
  '## Faction one',
  'Faction arises from liberty and property.',
  '',
  '## Faction two',
  'A faction is a number of citizens united by passion.',
  '',
  '## Faction three',
  'The causes of faction cannot be removed only controlled.',
  '',
  '## Power one',
  'Power must check power within a government.',
  '',
  '## Power two',
  'Ambition must be made to counteract ambition by design.',
  '',
  '## Power three',
  'The separation of powers guards public liberty.',
  ''
].join('\n')

// Stub embedder: faction chunks → [1,0], power chunks → [0,1] (heading carries the
// keyword too), so k-means splits the corpus cleanly in two.
const embedder: Embedder = {
  id: 'stub',
  dims: 2,
  async embed(texts) {
    return texts.map((t) => Float32Array.from(t.toLowerCase().includes('faction') ? [1, 0] : [0, 1]))
  }
}

/** Chat stub: returns a valid item quoting the first chunk shown in the prompt. */
function quotingChat(): ChatModel {
  return {
    id: 'chat-stub',
    async *chat(req) {
      const user = req.messages.map((m) => m.content).join('\n')
      const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
      if (!m) {
        yield '{"items":[]}'
        return
      }
      const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
      yield JSON.stringify({
        items: [{ kind: 'concept', title: quote, summary: 's', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }]
      })
    }
  }
}

// Force two clusters on the small corpus.
const opts = { minClusters: 2, perCluster: 3 }

describe('probeChat', () => {
  it('resolves when the model responds', async () => {
    const ok: ChatModel = {
      id: 'ok',
      async *chat() {
        yield 'hi'
      }
    }
    await expect(probeChat(ok)).resolves.toBeUndefined()
  })

  it('rejects when the model errors (bad key / unreachable server)', async () => {
    const bad: ChatModel = {
      id: 'bad',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('No API key')
      }
    }
    await expect(probeChat(bad)).rejects.toThrow(/No API key/)
  })
})

describe('distill', () => {
  it('runs the full pipeline into cited notes, reporting phases in order', async () => {
    const phases: DistillProgress[] = []
    const res = await distill(
      { file: 'Book.md', text: SRC },
      { embedder, chat: quotingChat() },
      { ...opts, onProgress: (p) => phases.push(p) }
    )
    expect(res.stats.chunks).toBe(6)
    expect(res.stats.clusters).toBe(2)
    expect(res.stats.notes).toBe(2)
    expect(res.stats.dropped).toBe(0)
    expect(res.notes.every((n) => n.content.includes('source:: [[Book]]'))).toBe(true)
    expect([...new Set(phases.map((p) => p.phase))]).toEqual([
      'chunking',
      'embedding',
      'clustering',
      'extracting',
      'finalizing',
      'done'
    ])
  })

  it('drops claims whose quote is not in the source (the grounding gate)', async () => {
    const liar: ChatModel = {
      id: 'liar',
      async *chat() {
        yield '{"items":[{"kind":"claim","title":"Fabricated","summary":"x","evidence":[{"chunkId":0,"quote":"this appears nowhere in the book"}],"links":[]}]}'
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: liar }, opts)
    expect(res.stats.extracted).toBeGreaterThan(0)
    expect(res.stats.dropped).toBeGreaterThan(0)
    expect(res.stats.notes).toBe(0)
  })

  it('recovers from malformed JSON via one repair retry', async () => {
    let calls = 0
    const flaky: ChatModel = {
      id: 'flaky',
      async *chat(req) {
        calls++
        if (req.messages.length === 1) {
          yield 'sorry — prose, not json'
          return
        }
        const user = req.messages.map((m) => m.content).join('\n')
        const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)!
        const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
        yield JSON.stringify({
          items: [{ kind: 'concept', title: quote, summary: 's', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }]
        })
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: flaky }, opts)
    expect(res.stats.failedClusters).toBe(0)
    expect(res.stats.notes).toBe(2)
    expect(calls).toBe(4) // 2 clusters × (1 bad + 1 repair)
  })

  it('counts a still-malformed cluster, never silently swallows it', async () => {
    const broken: ChatModel = {
      id: 'broken',
      async *chat() {
        yield 'not json at all'
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: broken }, opts)
    expect(res.stats.failedClusters).toBe(2)
    expect(res.stats.notes).toBe(0)
  })

  it('aborts mid-run and rejects with DistillAborted', async () => {
    const ctrl = new AbortController()
    const p = distill(
      { file: 'Book.md', text: SRC },
      { embedder, chat: quotingChat() },
      { ...opts, signal: ctrl.signal, onProgress: (pr) => pr.phase === 'chunking' && ctrl.abort() }
    )
    await expect(p).rejects.toBeInstanceOf(DistillAborted)
  })

  it('rejects immediately when already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, { ...opts, signal: ctrl.signal })
    ).rejects.toBeInstanceOf(DistillAborted)
  })

  it('handles an empty source without error', async () => {
    const res = await distill({ file: 'Book.md', text: '' }, { embedder, chat: quotingChat() }, opts)
    expect(res.stats.chunks).toBe(0)
    expect(res.notes).toEqual([])
  })

  it('is deterministic for fixed stubs', async () => {
    const a = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    const b = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    expect(a.notes).toEqual(b.notes)
  })
})
