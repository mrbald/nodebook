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
import { coverageOf } from './windows'
import { chunkMarkdown, weightOf } from '../rag/chunk'
import { ContextLengthError, type ChatModel } from '../rag/provider'

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

/** Nothing in this phase embeds anything; the dependency is still in the
 *  interface (the themes phase uses it), so tests pass one that would shout. */
const embedder = {
  embed: async (): Promise<Float32Array[]> => {
    throw new Error('distill must not embed chunks any more')
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

// Two windows on the small corpus: the three faction sections, then the three
// power ones (each chunk weighs 85-102 with its prompt scaffolding).
const opts = { windowSize: 300 }

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
    expect(res.stats.windows).toBe(2)
    expect(res.stats.calls).toBe(2)
    expect(res.stats.splits).toBe(0)
    expect(res.stats.notes).toBe(2)
    expect(res.stats.dropped).toBe(0)
    expect(res.stats.droppedByReason).toEqual({ noEvidence: 0, notFound: 0, ambiguous: 0 })
    expect(res.stats.recovered).toBe(0)
    expect(res.notes.every((n) => n.content.includes('source:: [[Book]]'))).toBe(true)
    // No embedding phase, no clustering phase: the document is read in order.
    expect([...new Set(phases.map((p) => p.phase))]).toEqual([
      'chunking',
      'extracting',
      'finalizing',
      'done'
    ])
  })

  it('reads the whole document in one call when the model’s budget allows it', async () => {
    // No window size forced: the default budget swallows this small corpus.
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() })
    expect(res.stats.windows).toBe(1)
    expect(res.stats.coverage).toBe(1)
  })

  it('sizes its windows from the budget the model declares', async () => {
    const small: ChatModel = { ...quotingChat(), inputBudget: 6_000 }
    const large: ChatModel = { ...quotingChat(), inputBudget: 40_000 }
    const text = SRC.repeat(20)
    const a = await distill({ file: 'B.md', text }, { embedder, chat: small })
    const b = await distill({ file: 'B.md', text }, { embedder, chat: large })
    expect(a.stats.windows).toBeGreaterThan(b.stats.windows)
    // Either way the whole document is read.
    expect(a.stats.coverage).toBe(1)
    expect(b.stats.coverage).toBe(1)
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
    expect(res.stats.failedWindows).toBe(0)
    expect(res.stats.notes).toBe(2)
    expect(calls).toBe(4) // 2 windows × (1 bad + 1 repair)
  })

  it('counts a still-malformed window, never silently swallows it', async () => {
    const broken: ChatModel = {
      id: 'broken',
      async *chat() {
        yield 'not json at all'
      }
    }
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: broken }, opts)
    expect(res.stats.failedWindows).toBe(2)
    expect(res.stats.notes).toBe(0)
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
    expect(res.stats.coverage).toBe(1) // nothing to read — trivially "fully read"
  })

  it('is deterministic for fixed stubs', async () => {
    const a = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    const b = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    expect(a.notes).toEqual(b.notes)
  })
})

// --- Coverage: read everything, or say exactly what was read ----------------

describe('distill — coverage', () => {
  it('reads every passage when the plan fits the call budget', async () => {
    const res = await distill({ file: 'Book.md', text: SRC }, { embedder, chat: quotingChat() }, opts)
    expect(res.stats.coverage).toBe(1)
  })

  it('samples evenly and reports the share BY WEIGHT when it cannot', async () => {
    // Six one-chunk windows, three calls allowed: windows 1, 3 and 5.
    const res = await distill(
      { file: 'Book.md', text: SRC },
      { embedder, chat: quotingChat() },
      { windowSize: 102, maxCalls: 3 }
    )
    expect(res.stats.windows).toBe(3)
    expect(res.stats.coverage).toBeLessThan(1)
    expect(res.stats.coverage).toBeCloseTo(coverageOf(chunkMarkdown(SRC), [1, 3, 5]))
  })
})

// --- The context-budget contract -------------------------------------------
// A document long enough to need several windows, with every section's wording
// unique so a quote is never ambiguous across the book.
const LONG = Array.from(
  { length: 8 },
  (_, i) =>
    `## Part ${i}\n\n` +
    `Part ${i} records that the council debated measure number ${i} and wrote the decision down. `
      .repeat(6)
      .trim()
).join('\n\n')

/** A chat stub that declares a prompt budget, optionally enforces a DIFFERENT
 *  (lower) real limit, and remembers every prompt it was sent. */
function budgetedChat(
  declared: number,
  realLimit = Infinity
): ChatModel & { prompts: { system: string; user: string; weight: number }[] } {
  const model = {
    id: 'budgeted',
    inputBudget: declared,
    prompts: [] as { system: string; user: string; weight: number }[],
    async *chat(req: { system?: string; messages: { content: string }[] }) {
      const system = req.system ?? ''
      const user = req.messages.map((m) => m.content).join('\n')
      const weight = weightOf(system) + weightOf(user)
      model.prompts.push({ system, user, weight })
      if (weight > realLimit) throw new ContextLengthError('prompt is too long')
      const first = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
      if (!first) {
        yield '{"items":[]}'
        return
      }
      const quote = first[2].split(/\s+/).slice(0, 8).join(' ')
      yield JSON.stringify({
        items: [
          {
            kind: 'concept',
            title: `Part ${first[1]}`,
            summary: 's',
            evidence: [{ chunkId: Number(first[1]), quote }],
            links: []
          }
        ]
      })
    }
  }
  return model as unknown as ChatModel & {
    prompts: { system: string; user: string; weight: number }[]
  }
}

/** The chunk ids a prompt actually showed the model. */
function chunkIdsIn(user: string): number[] {
  return [...user.matchAll(/\[chunk (\d+)[^\]]*\]/g)].map((m) => Number(m[1]))
}

describe('distill — the declared budget', () => {
  it.each([4_000, 8_000, 16_000])(
    'keeps every prompt inside the %i-weight budget the model declares',
    async (budget) => {
      const chat = budgetedChat(budget)
      const res = await distill({ file: 'L.md', text: LONG }, { embedder, chat })
      expect(chat.prompts.length).toBeGreaterThan(0)
      for (const p of chat.prompts) expect(p.weight).toBeLessThanOrEqual(budget)
      expect(res.stats.coverage).toBe(1)
      expect(res.stats.splits).toBe(0) // the plan fits: nothing had to be split
    }
  )

  it('makes fewer, fuller calls as the declared budget grows', async () => {
    const small = budgetedChat(4_000)
    const large = budgetedChat(16_000)
    await distill({ file: 'L.md', text: LONG }, { embedder, chat: small })
    await distill({ file: 'L.md', text: LONG }, { embedder, chat: large })
    expect(small.prompts.length).toBeGreaterThan(large.prompts.length)
  })

  it('lets [distill] windowSize override the derived size', async () => {
    const chat = budgetedChat(16_000)
    await distill({ file: 'L.md', text: LONG }, { embedder, chat }, { windowSize: 600 })
    // One ~535-weight chunk per window: eight calls, not one.
    expect(chat.prompts).toHaveLength(8)
  })
})

describe('distill — a hidden lower limit', () => {
  it('splits a rejected window in two and reads both halves, losing no text', async () => {
    // Declares 40k (so all eight chunks are planned as one window), really
    // rejects anything over 3k: the first call is refused, and the halving
    // continues until the halves fit.
    const chat = budgetedChat(40_000, 3_000)
    const res = await distill({ file: 'L.md', text: LONG }, { embedder, chat })

    expect(res.stats.windows).toBe(1) // one window PLANNED…
    expect(res.stats.calls).toBe(7) // …but 1 + 2 + 4 calls attempted
    expect(res.stats.splits).toBe(3)
    expect(res.stats.failedWindows).toBe(0)

    // The rejected parents are in the call count, and in the prompt log.
    const rejected = chat.prompts.filter((p) => p.weight > 3_000)
    expect(rejected).toHaveLength(3)
    expect(chat.prompts).toHaveLength(res.stats.calls)

    // Every chunk was read exactly once: the halves partition the window.
    const processed = chat.prompts.filter((p) => p.weight <= 3_000).map((p) => chunkIdsIn(p.user))
    const seen = processed.flat()
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(seen).size).toBe(seen.length)

    // …so coverage still counts each passage once, and stays 1.
    expect(res.stats.coverage).toBe(1)
    expect(res.stats.notes).toBeGreaterThan(0)
  })

  it('never retries a too-long prompt — retrying it could only fail again', async () => {
    const chat = budgetedChat(40_000, 3_000)
    await distill({ file: 'L.md', text: LONG }, { embedder, chat }, { retry: { tries: 3 } })
    // With retries the 3 rejected calls would have cost 9; they cost 3.
    expect(chat.prompts).toHaveLength(7)
  })

  it('stops splitting at the depth bound and marks the window failed, not the run', async () => {
    // Rejects even a single chunk: 1 + 2 + 4 = 7 calls of halving, then eight
    // one-chunk calls at the bound that are written off.
    const chat = budgetedChat(40_000, 1_500)
    const res = await distill({ file: 'L.md', text: LONG }, { embedder, chat })
    expect(res.stats.calls).toBe(15)
    expect(res.stats.splits).toBe(7)
    expect(res.stats.failedWindows).toBe(8)
    expect(res.stats.notes).toBe(0)
    // A window that cannot fit is this window's problem: the run still ends
    // normally, with the failure counted rather than thrown.
    expect(res.stats.windows).toBe(1)
  })
})

// --- The concept registry ---------------------------------------------------

describe('distill — the concept registry', () => {
  it('carries the titles one window grounded into the next window’s prompt', async () => {
    const systems: string[] = []
    const chat: ChatModel = {
      id: 'recorder',
      async *chat(req) {
        systems.push(req.system ?? '')
        const user = req.messages.map((m) => m.content).join('\n')
        const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)!
        const quote = m[2].split(/\s+/).slice(0, 4).join(' ')
        yield JSON.stringify({
          items: [
            { kind: 'concept', title: quote, summary: 's', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }
          ]
        })
      }
    }
    await distill({ file: 'Book.md', text: SRC }, { embedder, chat }, opts)
    expect(systems).toHaveLength(2)
    // Nothing is known before the first window.
    expect(systems[0]).not.toMatch(/known concepts/i)
    // The first window's title is offered to the second, by its exact name.
    expect(systems[1]).toMatch(/known concepts/i)
    expect(systems[1]).toContain('Faction arises from liberty')
  })

  it('advertises only titles that survived the quote check', async () => {
    const systems: string[] = []
    const liar: ChatModel = {
      id: 'liar',
      async *chat(req) {
        systems.push(req.system ?? '')
        yield '{"items":[{"kind":"claim","title":"Invented concept","summary":"x","evidence":[{"chunkId":0,"quote":"nowhere in this book"}],"links":[]}]}'
      }
    }
    await distill({ file: 'Book.md', text: SRC }, { embedder, chat: liar }, opts)
    // An ungrounded title must not become the run's shared vocabulary.
    expect(systems[1]).not.toContain('Invented concept')
  })
})

// --- Resilience: retry, per-window failure, circuit breaker, resume ---------
// A four-idea corpus, one idea per section, read one section per window — so a
// test can talk about "the third call" without guessing how packing fell out.
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

/** Four windows of one chunk each (a chunk here weighs ~75 with scaffolding). */
const opts4 = { windowSize: 80 }
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
    const res = await distill({ file: 'B.md', text: SRC4 }, { embedder, chat }, { ...opts4, ...noWait })
    expect(res.stats.windows).toBe(4)
    expect(res.stats.failedWindows).toBe(0)
    expect(res.stats.notes).toBe(4)
    expect(chat.calls).toBe(5) // 4 windows + 1 retried call
  })

  it('a window that keeps failing costs that window, not the run', async () => {
    // Every attempt at the second window fails; the other three are fine.
    const chat = scriptedChat((_n, prompt) => (/beta/i.test(prompt) ? rateLimit() : null))
    const res = await distill({ file: 'B.md', text: SRC4 }, { embedder, chat }, { ...opts4, ...noWait })
    expect(res.stats.failedWindows).toBe(1)
    expect(res.stats.notes).toBe(3) // the other three windows still produced notes
    expect(chat.calls).toBe(6) // 3 good windows + 3 tries on the bad one
  })

  it('stops the run after three failing windows in a row, reporting the real error', async () => {
    const chat = scriptedChat(() => tagError(new Error('API 500: gateway'), { status: 500 }))
    await expect(
      distill({ file: 'B.md', text: SRC4 }, { embedder, chat }, { ...opts4, ...noWait })
    ).rejects.toThrow('API 500: gateway')
    expect(chat.calls).toBe(9) // 3 windows × 3 tries — the fourth is never attempted
  })

  it('does not retry a permanent failure (a wrong key must not be spent three times)', async () => {
    const chat = scriptedChat(() => tagError(new Error('API 401'), { status: 401 }))
    await expect(
      distill({ file: 'B.md', text: SRC4 }, { embedder, chat }, { ...opts4, ...noWait })
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
        { embedder, chat: first },
        { ...opts4, ...noWait, checkpoint: store, signal: ctrl.signal }
      )
    ).rejects.toBeInstanceOf(DistillAborted)
    expect(store.records.filter((r) => r.type === 'window')).toHaveLength(2)
    // The plan is the chunk ids per window, recorded before the first call.
    expect(store.records[0]).toEqual({ type: 'plan', windows: [[0], [1], [2], [3]] })

    // Resume: same store, a healthy model.
    const second = scriptedChat(() => null)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat: second },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(second.calls).toBe(2) // only the two windows that were left
    expect(res.stats.windows).toBe(4)
    expect(res.stats.calls).toBe(2) // a replayed window costs nothing
    expect(res.stats.notes).toBe(4) // including the notes from the first attempt
  })

  it('a resumed run does not re-run a window that already failed', async () => {
    const store = fakeCheckpoint()
    const failing = scriptedChat((_n, prompt) => (/beta/i.test(prompt) ? rateLimit() : null))
    const a = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat: failing },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(a.stats.failedWindows).toBe(1)

    const again = scriptedChat(() => null)
    const b = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat: again },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(again.calls).toBe(0) // everything was already decided
    expect(b.stats.failedWindows).toBe(1) // and the failure is still reported
    expect(b.notes).toEqual(a.notes) // replay is exact
  })

  it('ignores a checkpoint plan that does not fit the text, rather than trusting it', async () => {
    const store = fakeCheckpoint()
    store.save({ type: 'plan', windows: [[99]] })
    const chat = scriptedChat(() => null)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(res.stats.windows).toBe(4)
    expect(res.stats.notes).toBe(4)
  })

  it('reports the coverage of a resumed plan, not of a freshly planned one', async () => {
    const store = fakeCheckpoint()
    // A plan that read half the document — as a sampled first attempt would.
    store.save({ type: 'plan', windows: [[0], [2]] })
    const chat = scriptedChat(() => null)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat },
      { ...opts4, ...noWait, checkpoint: store }
    )
    expect(res.stats.windows).toBe(2)
    expect(res.stats.coverage).toBeCloseTo(coverageOf(chunkMarkdown(SRC4), [0, 2]))
  })
})

describe('estimateDistill', () => {
  it('predicts the passages, calls and coverage of a run, without calling anything', async () => {
    const est = estimateDistill(SRC4, opts4)
    const res = await distill(
      { file: 'B.md', text: SRC4 },
      { embedder, chat: scriptedChat(() => null) },
      opts4
    )
    expect(est.chunks).toBe(res.stats.chunks)
    expect(est.calls).toBe(res.stats.windows)
    expect(est.coverage).toBe(res.stats.coverage)
    expect(est.totalWindows).toBe(4)
  })

  it('is honest about a document that needs more steps than the budget allows', () => {
    const est = estimateDistill(LONG, { windowSize: 600, maxCalls: 3 })
    expect(est.totalWindows).toBe(8)
    expect(est.calls).toBe(3)
    expect(est.maxCalls).toBe(3)
    expect(est.coverage).toBeLessThan(1)
  })

  it('reads the whole document by default', () => {
    const est = estimateDistill(LONG)
    expect(est.coverage).toBe(1)
    expect(est.calls).toBe(est.totalWindows)
  })

  it('handles an empty document', () => {
    expect(estimateDistill('')).toEqual({
      chunks: 0,
      calls: 0,
      coverage: 1,
      totalWindows: 0,
      maxCalls: 120
    })
  })
})

describe('distill — link integrity', () => {
  /**
   * Two windows. The first names one idea twice, so dedup merges them and the
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
        const items = /faction/i.test(m[2])
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
