/**
 * The distill orchestrator: source text → cited, de-duplicated markdown notes.
 * It wires the pure core (chunk → cluster → extract → ground → dedup → emit) and
 * drives the two impure steps — embedding and chat extraction — through INJECTED
 * interfaces. That keeps this logic unit-testable with stubs; the Electron layer
 * (renderer WASM embedder, main-process chat model) supplies the real ones.
 *
 * Cost is bounded by clustering (one extraction call per cluster, capped). Bad
 * model JSON gets one repair retry, then that cluster is skipped (counted, never
 * silently). Every claim passes the citation gate before becoming a note.
 *
 * A run is also resilient: a call that fails for a transient reason is retried
 * with backoff, a call that keeps failing costs its own window and not the run,
 * and every window that lands is written to a checkpoint — so a cancelled or
 * crashed run resumes from where it stopped instead of starting over. The one
 * thing that DOES stop a run is three failing windows in a row: an expired key
 * should cost three slow calls, not a hundred.
 */

import type { ChatModel, ChatRequest } from '../rag/provider'
import { chunkMarkdown, embedText, type Chunk } from '../rag/chunk'
import { chooseK, kmeans, type Point } from './cluster'
import {
  buildExtractionPrompt,
  parseExtraction,
  groundItems,
  type ChunkProvenance,
  type ExtractedItem
} from './extract'
import { dedup } from './dedup'
import { emitRun, type EmittedNote } from './emit'
import { sourceNoteName, type CheckpointStore } from './artifact'
import { withRetry, type RetryOptions } from './retry'

/** Thrown when a run is cancelled via its AbortSignal. */
export class DistillAborted extends Error {
  constructor() {
    super('Distill cancelled')
    this.name = 'DistillAborted'
  }
}

export type DistillPhase =
  | 'chunking'
  | 'embedding'
  | 'clustering'
  | 'extracting'
  | 'finalizing'
  | 'done'

export interface DistillProgress {
  phase: DistillPhase
  done: number
  total: number
}

/** The book being distilled. `file` identifies it in citations + `source::` edges. */
export interface DistillSource {
  file: string
  text: string
}

/** The orchestrator only needs to turn text into vectors (the renderer's WASM
 *  embedder satisfies this via the main↔renderer bridge; tests pass a stub).
 *  The signal is passed on so a cancel reaches the bridge instead of waiting
 *  out an in-flight round trip. */
export interface DistillEmbedder {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface DistillDeps {
  embedder: DistillEmbedder
  chat: ChatModel
}

export interface DistillOptions {
  signal?: AbortSignal
  onProgress?: (p: DistillProgress) => void
  /** Roughly one cluster per this many chunks (default 8). */
  perCluster?: number
  /** Cluster-count floor / ceiling (defaults 4 / 24). The ceiling bounds LLM calls. */
  minClusters?: number
  maxClusters?: number
  /** Representative chunks shown to the model per cluster (default 4). */
  repsPerCluster?: number
  /** Embedding batch size (default 32). */
  embedBatch?: number
  /** Per-call retry policy (see retry.ts). Defaults to 3 tries, 1 s × 2. */
  retry?: RetryOptions
  /** Consecutive failing windows that stop the run (default 3). One bad window
   *  is the model's problem; three in a row is the provider's, and the rest of
   *  the calls would only repeat it more slowly. */
  maxConsecutiveFailures?: number
  /** Where completed windows are recorded, and where a resume reads them back.
   *  Absent = a run that cannot be resumed (the unit tests' default). */
  checkpoint?: CheckpointStore
}

/** What a run will cost, from the converted text alone — no model calls, no
 *  embedding. Shown before the run so "reading a book" is never a surprise. */
export interface DistillEstimate {
  /** Passages the document splits into. */
  chunks: number
  /** Model calls the plan needs — one per window (an upper bound: a window
   *  that turns out to hold no passages is not called). */
  calls: number
  /** Fraction (0..1) of those passages the model will actually be shown. */
  coverage: number
}

/**
 * Plan a run without running it: chunk the text and ask the same pure planner
 * the run uses. Cheap and deterministic, so the estimate the user sees is the
 * plan the run then follows.
 */
export function estimateDistill(text: string, opts: DistillOptions = {}): DistillEstimate {
  const chunks = chunkMarkdown(text).length
  if (chunks === 0) return { chunks: 0, calls: 0, coverage: 1 }
  const calls = chooseK(chunks, {
    perCluster: opts.perCluster,
    min: opts.minClusters,
    max: opts.maxClusters
  })
  // Each call shows at most `repsPerCluster` chunks, and no chunk twice.
  const shown = Math.min(chunks, calls * (opts.repsPerCluster ?? 4))
  return { chunks, calls, coverage: shown / chunks }
}

export interface DistillResult {
  notes: EmittedNote[]
  stats: {
    chunks: number
    clusters: number
    extracted: number
    grounded: number
    /** Total drops: `droppedByReason`'s three counts summed. */
    dropped: number
    /** Why grounding dropped things (see extract.ts's GroundingResult). */
    droppedByReason: { noEvidence: number; notFound: number; ambiguous: number }
    /** Quotes the fallback found under a different passage and kept. */
    recovered: number
    merged: number
    notes: number
    failedClusters: number
    /** Shape of the run's link graph (see shared DistillStats and link.ts). */
    edges: number
    ghostLinks: number
    mentions: number
    components: number
    /** Fraction (0..1) of `chunks` actually shown to the LLM (see shared DistillStats). */
    coverage: number
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DistillAborted()
}

/** Drain a chat stream to a string, honouring cancellation between tokens. */
async function collect(stream: AsyncIterable<string>, signal?: AbortSignal): Promise<string> {
  let out = ''
  for await (const tok of stream) {
    throwIfAborted(signal)
    out += tok
  }
  return out
}

/** Extract one cluster, with a single repair retry on unparseable JSON. */
async function extractCluster(
  chat: ChatModel,
  chunks: { chunkId: number; heading: string; text: string }[],
  signal?: AbortSignal
): Promise<{ items: ExtractedItem[]; failed: boolean }> {
  const { system, user } = buildExtractionPrompt(chunks)
  const first = await collect(
    chat.chat({ system, messages: [{ role: 'user', content: user }], signal }),
    signal
  )
  let parsed = parseExtraction(first)
  if (!parsed.ok) {
    const repair: ChatRequest = {
      system,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: first.slice(0, 800) },
        { role: 'user', content: 'That was not valid JSON in the required shape. Reply with ONLY the JSON object, nothing else.' }
      ],
      signal
    }
    parsed = parseExtraction(await collect(chat.chat(repair), signal))
  }
  return parsed.ok ? { items: parsed.items, failed: false } : { items: [], failed: true }
}

/**
 * Pre-flight check: confirm the chat model actually responds — API key valid,
 * local server (Ollama/LM Studio) reachable, CLI binary found and signed in —
 * before the expensive embedding work, not half-way through. The optional
 * signal bounds the wait.
 *
 * CLI backends supply a cheap `probe()` (binary found, signed in) because a
 * real round-trip bills the user's subscription quota; HTTP providers have no
 * such probe, so they fall back to pulling the first token of a tiny request.
 */
export async function probeChat(chat: ChatModel, signal?: AbortSignal): Promise<void> {
  if (chat.probe) return chat.probe(signal)
  const stream = chat.chat({ messages: [{ role: 'user', content: 'ping' }], signal })
  const iter = stream[Symbol.asyncIterator]()
  try {
    await iter.next()
  } finally {
    await iter.return?.()
  }
}

export async function distill(
  source: DistillSource,
  deps: DistillDeps,
  opts: DistillOptions = {}
): Promise<DistillResult> {
  const report = (phase: DistillPhase, done: number, total: number): void =>
    opts.onProgress?.({ phase, done, total })

  throwIfAborted(opts.signal)

  // 1. Chunk (pure). Chunk id = its index; provenance maps id → source span.
  const chunks: Chunk[] = chunkMarkdown(source.text)
  report('chunking', chunks.length, chunks.length)
  const prov = new Map<number, ChunkProvenance>()
  chunks.forEach((c, id) => prov.set(id, { file: source.file, start: c.start, text: c.text }))

  // A resume starts from the plan the first attempt committed to: the windows
  // are already decided, so embedding and clustering are skipped entirely (the
  // expensive half of the run, and re-deciding could only shift the windows
  // under the results already recorded). A plan that no longer fits the text is
  // ignored rather than trusted.
  const saved = opts.checkpoint?.load() ?? null
  const savedPlan =
    saved?.plan && saved.plan.every((w) => w.every((id) => id >= 0 && id < chunks.length))
      ? saved.plan
      : null

  // 2. Embed (injected), batched.
  const embedBatch = opts.embedBatch ?? 32
  const points: Point[] = []
  report('embedding', savedPlan ? chunks.length : 0, chunks.length)
  for (let i = 0; savedPlan === null && i < chunks.length; i += embedBatch) {
    throwIfAborted(opts.signal)
    const slice = chunks.slice(i, i + embedBatch)
    // The embedder gets the signal so a cancel interrupts the round trip; its
    // rejection is then reported as a cancellation, not as an embedding fault.
    const vecs = await deps.embedder.embed(slice.map(embedText), opts.signal).catch((err) => {
      throwIfAborted(opts.signal)
      throw err
    })
    throwIfAborted(opts.signal)
    if (vecs.length !== slice.length) throw new Error('embedder returned the wrong number of vectors')
    slice.forEach((_, j) => points.push({ id: i + j, vec: vecs[j] }))
    report('embedding', Math.min(i + embedBatch, chunks.length), chunks.length)
  }

  // 3. Cluster (pure). The ceiling bounds the extraction-call budget. The plan
  //    — the chunk ids each call will be shown — is recorded before the first
  //    call, so a resume never has to reproduce it.
  throwIfAborted(opts.signal)
  let plan: number[][]
  if (savedPlan) {
    plan = savedPlan
  } else {
    const k = chooseK(chunks.length, {
      perCluster: opts.perCluster,
      min: opts.minClusters,
      max: opts.maxClusters
    })
    plan = kmeans(points, k, { repCount: opts.repsPerCluster }).map((c) => c.representativeIds)
    opts.checkpoint?.save({ type: 'plan', windows: plan })
  }
  report('clustering', plan.length, plan.length)

  // 4. Extract per window (injected chat), with repair retry. Each shown chunk
  //    remembers the call it was shown in, so grounding can look for a
  //    mislabelled quote in the other chunks of that same prompt.
  //
  //    A failed call costs its window, not the run: transient failures are
  //    retried with backoff, and what is left is counted and skipped. Three
  //    failures in a row do stop the run — that is a provider that is not
  //    coming back, and the remaining windows would fail just as slowly.
  const extracted: ExtractedItem[] = []
  const window = new Map<number, number[]>()
  const maxConsecutive = opts.maxConsecutiveFailures ?? 3
  let failedClusters = 0
  let consecutiveErrors = 0
  report('extracting', 0, plan.length)
  for (let i = 0; i < plan.length; i++) {
    throwIfAborted(opts.signal)
    const shown = plan[i]
    for (const id of shown) window.set(id, shown)
    const already = saved?.done.get(i)
    if (already) {
      // Recorded by an earlier attempt — replay it, don't pay for it twice.
      if (already.failed) failedClusters++
      extracted.push(...already.items)
      report('extracting', i + 1, plan.length)
      continue
    }
    const cc = shown.map((id) => ({
      chunkId: id,
      heading: chunks[id].heading,
      text: chunks[id].text
    }))
    let items: ExtractedItem[] = []
    let failed: boolean
    try {
      ;({ items, failed } = await withRetry(() => extractCluster(deps.chat, cc, opts.signal), {
        ...opts.retry,
        signal: opts.signal
      }))
      consecutiveErrors = 0
    } catch (err) {
      throwIfAborted(opts.signal)
      if (err instanceof DistillAborted) throw err
      failed = true
      if (++consecutiveErrors >= maxConsecutive) throw err
    }
    if (failed) failedClusters++
    opts.checkpoint?.save(
      failed ? { type: 'window', index: i, failed: true } : { type: 'window', index: i, items }
    )
    extracted.push(...items)
    report('extracting', i + 1, plan.length)
  }

  // 5–7. Ground → dedup → emit (all pure).
  report('finalizing', 0, 1)
  const {
    notes: grounded,
    dropped: droppedByReason,
    recovered
  } = groundItems(extracted, prov, {
    windowOf: (chunkId) => window.get(chunkId) ?? [],
    fullText: source.text
  })
  // dedup renames notes and emit de-collides them, so a link written earlier
  // can name a note that no longer exists; `aliases` lets link.ts (inside
  // emitRun) point it at the surviving note instead of leaving a dead end.
  const { notes: deduped, merged, aliases } = dedup(grounded)
  // The book itself is written as a note of the run (artifact.planRunFiles), so
  // its name is off-limits to the emitted notes — see emitRun.
  const emitted = emitRun(deduped, { reserved: [sourceNoteName(source.file)], aliases })
  report('done', 1, 1)

  // Coverage honesty: clusters partition every chunk, and each window shows a
  // subset of one cluster's members, so summing the plan counts each shown
  // chunk exactly once — this is what the LLM actually saw, out of the whole.
  const shown = plan.reduce((sum, ids) => sum + ids.length, 0)
  const coverage = chunks.length > 0 ? shown / chunks.length : 1

  return {
    notes: emitted.notes,
    stats: {
      chunks: chunks.length,
      clusters: plan.length,
      extracted: extracted.length,
      grounded: grounded.length,
      dropped: droppedByReason.noEvidence + droppedByReason.notFound + droppedByReason.ambiguous,
      droppedByReason,
      recovered,
      merged,
      notes: emitted.notes.length,
      failedClusters,
      edges: emitted.edges,
      ghostLinks: emitted.ghostLinks,
      mentions: emitted.mentions,
      components: emitted.components,
      coverage
    }
  }
}
