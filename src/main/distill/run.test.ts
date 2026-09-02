import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { distill, probeChat, estimateDistill, DistillAborted, type DistillProgress } from './run'
import { planRunFiles } from './artifact'
import {
  replayCheckpoint,
  type CheckpointRecord,
  type CheckpointStore
} from './artifact'
import { tagError } from './retry'
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

  it('prefers probe() over a real chat round-trip when both are present', async () => {
    const okProbe: ChatModel = {
      id: 'has-probe',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('chat() should not be called when probe() is present')
      },
      async probe() {
        /* cheap check succeeds */
      }
    }
    await expect(probeChat(okProbe)).resolves.toBeUndefined()

    const badProbe: ChatModel = {
      id: 'has-failing-probe',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('chat() should not be called when probe() is present')
      },
      async probe() {
        throw new Error("Codex isn't signed in")
      }
    }
    await expect(probeChat(badProbe)).rejects.toThrow(/isn't signed in/)
  })

  it('falls back to the first-token stream ping when probe() is absent', async () => {
    // `ok`/`bad` above already exercise this path (neither defines `probe`);
    // this test makes the fallback explicit and checks chat() actually ran.
    let called = false
    const noProbe: ChatModel = {
      id: 'no-probe',
      async *chat() {
        called = true
        yield 'hi'
      }
    }
    await expect(probeChat(noProbe)).resolves.toBeUndefined()
    expect(called).toBe(true)
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
    expect(res.stats.droppedByReason).toEqual({ noEvidence: 0, notFound: 0, ambiguous: 0 })
    expect(res.stats.recovered).toBe(0)
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
    // A fabricated quote is nowhere in the document — reported as such, not as
    // "no evidence": the model DID give a quote, it just isn't real.
    expect(res.stats.droppedByReason.notFound).toBe(res.stats.dropped)
    expect(res.stats.droppedByReason.noEvidence).toBe(0)
  })

  it('recovers a real quote the model filed under the wrong chunk, and says so', async () => {
    // Every item quotes chunk 5's sentence but tags it chunk 0 — the quote is
    // real, only the id is wrong, so grounding re-attributes instead of dropping.
    const misfiler: ChatModel = {
      id: 'misfiler',
      async *chat() {
        yield JSON.stringify({
          items: [
            {
              kind: 'claim',
              title: 'Separation of powers',
              summary: 's',
              evidence: [{ chunkId: 0, quote: 'The separation of powers guards public liberty.' }],
              links: []
            }
          ]
        })
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: misfiler }, opts)
    expect(res.stats.dropped).toBe(0)
    expect(res.stats.recovered).toBeGreaterThan(0)
    expect(res.stats.notes).toBeGreaterThan(0)
    // The citation points at the passage that really holds the quote.
    const cite = /span:\s*(\d+)\s*-\s*(\d+)/.exec(res.notes[0].content)!
    expect(SRC.slice(Number(cite[1]), Number(cite[2]))).toBe(
      'The separation of powers guards public liberty.'
    )
  })

  it('counts a point the model backed with no quote at all as its own reason', async () => {
    const unsupported: ChatModel = {
      id: 'unsupported',
      async *chat() {
        yield '{"items":[{"kind":"claim","title":"Bare assertion","summary":"x","evidence":[],"links":[]}]}'
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: unsupported }, opts)
    expect(res.stats.notes).toBe(0)
    expect(res.stats.droppedByReason).toEqual({ noEvidence: 2, notFound: 0, ambiguous: 0 })
    expect(res.stats.dropped).toBe(2)
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

  it('a cancel during embedding reaches the embedder and surfaces as DistillAborted', async () => {
    // The bridge (main's rendererEmbedder) rejects on abort; the orchestrator
    // must report that as a cancellation, not as an embedding failure.
    const hanging = {
      embed: (_texts: string[], signal?: AbortSignal): Promise<Float32Array[]> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('bridge closed')))
        })
    }
    const ctrl = new AbortController()
    const p = distill(
      { file: 'Book.md', text: SRC },
      { embedder: hanging, chat: quotingChat() },
      { ...opts, signal: ctrl.signal }
    )
    setTimeout(() => ctrl.abort(), 5)
    await expect(p).rejects.toBeInstanceOf(DistillAborted)
  })

  it('keeps the book note: a concept titled like the source gets a suffixed name', async () => {
    // A chat stub that titles its one concept exactly like the book, which is
    // written as a note of the run under that same name.
    const titleThief: ChatModel = {
      id: 'thief',
      async *chat(req) {
        const user = req.messages.map((m) => m.content).join('\n')
        const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
        if (!m) {
          yield '{"items":[]}'
          return
        }
        const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
        yield JSON.stringify({
          items: [
            { kind: 'concept', title: 'Book', summary: 's', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }
          ]
        })
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: titleThief }, opts)
    expect(res.notes.length).toBeGreaterThan(0)
    // Not one emitted note may claim the source note's file name.
    expect(res.notes.map((n) => n.fileName)).not.toContain('Book.md')
    expect(res.notes[0].name).toBe('Book 2')
    // …so the run's files can actually be planned (the source note survives).
    const planned = planRunFiles({ file: 'Book.md', text: SRC }, res.notes)
    expect(planned.map((f) => f.relPath)).toContain(join('notes', 'Book.md'))
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
    expect(res.stats.coverage).toBe(1) // nothing to sample — trivially "fully covered"
  })

  it('reports coverage as the fraction of chunks actually shown to the LLM', async () => {
    // 6 chunks, forced into 2 clusters (opts), default repsPerCluster=4 — every
    // cluster has 3 members, so all 3 become representatives: full coverage.
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    expect(res.stats.coverage).toBe(1)
  })

  it('reports partial coverage when a cluster has more members than reps shown', async () => {
    const res = await distill(
      { file: 'Book.md', text: SRC },
      { embedder, chat: quotingChat() },
      { ...opts, repsPerCluster: 1 } // 2 clusters × 1 rep = 2 of 6 chunks shown
    )
    expect(res.stats.coverage).toBeCloseTo(2 / 6)
  })

  it('is deterministic for fixed stubs', async () => {
    const a = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    const b = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    expect(a.notes).toEqual(b.notes)
  })
})

// --- Resilience: retry, per-window failure, circuit breaker, resume ---------
// A four-idea corpus, one idea per section, with an embedder that gives each
// its own vector — so the plan is exactly four one-chunk windows and a test can
// talk about "the third call" without guessing how clustering fell out.
const SRC4 = [
  '# Book',
  '',
  '## Alpha',
  'Alpha is the first idea of the book.',
  '',
  '## Beta',
  'Beta is the second idea of the book.',
  '',
  '## Gamma',
  'Gamma is the third idea of the book.',
  '',
  '## Delta',
  'Delta is the fourth idea of the book.',
  ''
].join('\n')

const WORDS = ['alpha', 'beta', 'gamma', 'delta']
const embedder4: Embedder = {
  id: 'stub4',
  dims: 4,
  async embed(texts) {
    return texts.map((t) =>
      Float32Array.from(WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)))
    )
  }
}
/** Four windows of one chunk each. */
const opts4 = { minClusters: 4, perCluster: 1 }
/** No real waiting in tests — the backoff itself is covered in retry.test.ts. */
const noWait = { retry: { sleep: async (): Promise<void> => {} } }

/** An in-memory checkpoint store that replays through the real replay logic. */
function fakeCheckpoint(): CheckpointStore & { records: CheckpointRecord[] } {
  const records: CheckpointRecord[] = []
  return {
    records,
    load: () =>
      records.length
        ? replayCheckpoint(records.map((r) => JSON.stringify(r)).join('\n'))
        : null,
    save: (r) => {
      records.push(r)
    }
  }
}

/** A chat stub that quotes the first chunk shown, and lets a test decide what
 *  each call does. `calls` counts every chat round-trip. */
function scriptedChat(fail: (call: number, prompt: string) => Error | null): ChatModel & {
  calls: number
} {
  const model = {
    calls: 0,
    async *chat(req: { messages: { content: string }[] }) {
      const user = req.messages.map((m) => m.content).join('\n')
      const err = fail(++model.calls, user)
      if (err) throw err
      const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
      if (!m) {
        yield '{"items":[]}'
        return
      }
      const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
      yield JSON.stringify({
        items: [
          { kind: 'concept', title: quote, summary: 's', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }
        ]
      })
    }
  }
  return model as unknown as ChatModel & { calls: number }
}

const rateLimit = (): Error => tagError(new Error('API 429'), { status: 429 })

describe('distill — resilience', () => {
  it('retries a transient failure and completes, at the cost of one extra call', async () => {
    const chat = scriptedChat((n) => (n === 1 ? rateLimit() : null))
    const res = await distill({ file: 'B.md', text: SRC4 }, { embedder: embedder4, chat }, { ...opts4, ...noWait })
    expect(res.stats.clusters).toBe(4)
    expect(res.stats.failedClusters).toBe(0)
    expect(res.stats.notes).toBe(4)
    expect(chat.calls).toBe(5) // 4 windows + 1 retried call
  })

  it('a window that keeps failing costs that window, not the run', async () => {
    // Every attempt at the second window fails; the other three are fine.
    const chat = scriptedChat((_n, prompt) => (/beta/i.test(prompt) ? rateLimit() : null))
    const res = await distill({ file: 'B.md', text: SRC4 }, { embedder: embedder4, chat }, { ...opts4, ...noWait })
    expect(res.stats.failedClusters).toBe(1)
    expect(res.stats.notes).toBe(3) // the other three windows still produced notes
    expect(chat.calls).toBe(6) // 3 good windows + 3 tries on the bad one
  })

  it('stops the run after three failing windows in a row, reporting the real error', async () => {
    const chat = scriptedChat(() => tagError(new Error('API 500: gateway'), { status: 500 }))
    await expect(
      distill({ file: 'B.md', text: SRC4 }, { embedder: embedder4, chat }, { ...opts4, ...noWait })
    ).rejects.toThrow('API 500: gateway')
    expect(chat.calls).toBe(9) // 3 windows × 3 tries — the fourth is never attempted
  })

  it('does not retry a permanent failure (a wrong key must not be spent three times)', async () => {
    const chat = scriptedChat(() => tagError(new Error('API 401'), { status: 401 }))
    await expect(
      distill({ file: 'B.md', text: SRC4 }, { embedder: embedder4, chat }, { ...opts4, ...noWait })
    ).rejects.toThrow('API 401')
    expect(chat.calls).toBe(3) // one per window, three windows, then the breaker
  })

  it('checkpoints the plan and every window, so a cancelled run resumes where it stopped', async () => {
    const store = fakeCheckpoint()
    const ctrl = new AbortController()
    // Cancel as the third window's call starts: two windows are already recorded.
    const first = scriptedChat((n) => {
      if (n === 3) ctrl.abort()
      return null
    })
    await expect(
      distill(
        { file: 'B.md', text: SRC4 },
        { embedder: embedder4, chat: first },
        { ...opts4, ...noWait, checkpoint: store, signal: ctrl.signal }
      )
    ).rejects.toBeInstanceOf(DistillAborted)
    expect(store.records.filter((r) => r.type === 'window')).toHaveLength(2)

    // Resume: same store, a healthy model, no embedding needed.
    let embedded = 0
    const countingEmbedder = {
      embed: (texts: string[]): Promise<Float32Array[]> => {
        embedded += texts.length
        return embedder4.embed(texts)
      }
    }
    const second = scriptedChat(() => null)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder: countingEmbedder, chat: second },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(second.calls).toBe(2) // only the two windows that were left
    expect(embedded).toBe(0) // the plan was saved, so nothing is re-embedded
    expect(res.stats.clusters).toBe(4)
    expect(res.stats.notes).toBe(4) // including the notes from the first attempt
  })

  it('a resumed run does not re-run a window that already failed', async () => {
    const store = fakeCheckpoint()
    const failing = scriptedChat((_n, prompt) => (/beta/i.test(prompt) ? rateLimit() : null))
    const a = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder: embedder4, chat: failing },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(a.stats.failedClusters).toBe(1)

    const again = scriptedChat(() => null)
    const b = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder: embedder4, chat: again },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(again.calls).toBe(0) // everything was already decided
    expect(b.stats.failedClusters).toBe(1) // and the failure is still reported
    expect(b.notes).toEqual(a.notes) // replay is exact
  })

  it('ignores a checkpoint plan that does not fit the text, rather than trusting it', async () => {
    const store = fakeCheckpoint()
    store.save({ type: 'plan', windows: [[99]] })
    const chat = scriptedChat(() => null)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder: embedder4, chat },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(res.stats.clusters).toBe(4)
    expect(res.stats.notes).toBe(4)
  })
})

describe('estimateDistill', () => {
  it('predicts the passages, calls and coverage of a run, without calling anything', async () => {
    const est = estimateDistill(SRC4, opts4)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder: embedder4, chat: scriptedChat(() => null) },
      opts4
    )
    expect(est.chunks).toBe(res.stats.chunks)
    expect(est.calls).toBe(res.stats.clusters)
    expect(est.coverage).toBe(res.stats.coverage)
  })

  it('is honest about sampling a long document', () => {
    // 400 passages: 24 calls (the ceiling) × 4 shown each = 96 of them.
    const est = estimateDistill('x'.repeat(400_000))
    expect(est.calls).toBe(24)
    expect(est.coverage).toBeLessThan(1)
  })

  it('handles an empty document', () => {
    expect(estimateDistill('')).toEqual({ chunks: 0, calls: 0, coverage: 1 })
  })
})

describe('distill — link integrity', () => {
  /**
   * Two clusters. The first names one idea twice, so dedup merges them and the
   * longer title stops existing; the second links to that lost title. Without
   * the alias map that link would be a dead end in the run's map.
   */
  function renamingChat(): ChatModel {
    return {
      id: 'renaming',
      async *chat(req) {
        const user = req.messages.map((m) => m.content).join('\n')
        const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
        if (!m) {
          yield '{"items":[]}'
          return
        }
        const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
        const evidence = [{ chunkId: Number(m[1]), quote }]
        const items = /faction/i.test(user)
          ? [
              { kind: 'concept', title: 'Faction and its causes', summary: 's', evidence, links: [] },
              { kind: 'concept', title: 'Faction', summary: 's', evidence, links: [] }
            ]
          : [
              {
                kind: 'concept',
                title: 'Separation of powers',
                summary: 's',
                evidence,
                links: [{ relation: 'about', target: 'Faction and its causes' }]
              }
            ]
        yield JSON.stringify({ items })
      }
    }
  }

  it('leaves no ghost links when dedup renamed the note a link points at', async () => {
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: renamingChat() }, opts)
    expect(res.stats.merged).toBe(1) // the two faction titles became one note
    expect(res.notes.map((n) => n.name)).toEqual(['Faction', 'Separation of powers'])
    // The link written against the title dedup dropped now finds the survivor…
    expect(res.notes[1].content).toContain('about:: [[Faction]]')
    // …so the run's map is one connected piece with no dead ends.
    expect(res.stats.ghostLinks).toBe(0)
    expect(res.stats.edges).toBe(1)
    expect(res.stats.components).toBe(1)
  })

  it('reports the link graph it emitted', async () => {
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    // Two unlinked notes: no edges, no ghosts, two islands.
    expect(res.stats).toMatchObject({ edges: 0, ghostLinks: 0, mentions: 0, components: 2 })
  })
})
