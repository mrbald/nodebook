/**
 * The distill orchestrator: source text → cited, de-duplicated markdown notes.
 * It wires the pure core (chunk → plan windows → extract → ground → dedup →
 * emit) and drives the one impure step — chat extraction — through an INJECTED
 * interface. That keeps this logic unit-testable with stubs; the Electron layer
 * (main-process chat model) supplies the real one.
 *
 * The run READS THE WHOLE DOCUMENT, in order. Consecutive chunks are packed
 * into windows as large as the model's declared prompt budget allows
 * (`windows.ts`), one call per window, sequentially, each call carrying the
 * concepts named so far (`registry.ts`) so names stay consistent and links
 * reach across windows. Cost is bounded by `maxCalls`: over that, windows are
 * kept at an even stride and `coverage` reports the share of the text — by
 * weight — the model was actually shown. Bad model JSON gets one repair retry,
 * then that window is skipped (counted, never silently).
 *
 * A run is also resilient. A call that fails for a transient reason is retried
 * with backoff; a call REJECTED FOR LENGTH is not retried but split in two and
 * both halves are read, so an optimistic budget costs an extra call and never a
 * passage; a call that keeps failing costs its own window and not the run; and
 * every window that lands is written to a checkpoint — so a cancelled or
 * crashed run resumes from where it stopped instead of starting over. The one
 * thing that DOES stop a run is three failing windows in a row: an expired key
 * should cost three slow calls, not a hundred.
 */

import {
  ContextLengthError,
  DEFAULT_INPUT_BUDGET,
  type ChatModel,
  type ChatRequest
} from '../rag/provider'
import { chunkMarkdown, weightOf, type Chunk } from '../rag/chunk'
import { coverageOf, planWindows } from './windows'
import { ConceptRegistry } from './registry'
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

export type DistillPhase = 'chunking' | 'extracting' | 'finalizing' | 'done'

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
 *  out an in-flight round trip.
 *
 *  Nothing in THIS phase embeds anything — reading is by document order, not by
 *  similarity — but the dependency stays in the interface for the themes phase,
 *  which embeds the emitted notes. */
export interface DistillEmbedder {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface DistillDeps {
  embedder: DistillEmbedder
  chat: ChatModel
}

/** Weight the registry block may take out of a prompt (`registry.ts`), capped
 *  at a quarter of a small budget so a local model with a 2k window is not
 *  spent entirely on a list of names. */
const REGISTRY_BUDGET = 4_000

/** Share of the prompt budget kept free for the model's own answer. The reply
 *  is JSON holding a verbatim quote per item, so it is a real fraction of the
 *  input, not a rounding error. */
const OUTPUT_RESERVE = 0.25

/** However tight the budget, a window is never planned smaller than this — a
 *  chunk that still does not fit becomes its own window, and a backend that
 *  rejects it is answered by the split path, not by planning zero-chunk calls. */
const MIN_WINDOW_WEIGHT = 500

/** Per-chunk prompt scaffolding the planner must pay for: the `[chunk 12 —
 *  Heading]` marker line and the blank line joining the blocks. Generous by a
 *  few characters, so "the plan fits the declared budget" holds exactly rather
 *  than approximately. */
const CHUNK_OVERHEAD = 24

/** How many times a rejected window may be halved before it is written off.
 *  Three halvings turn one window into at most eight, which is the point where
 *  "the budget is wrong" is a better explanation than "this window was big". */
const MAX_SPLIT_DEPTH = 3

/** Model calls one run may make, unless the user says otherwise. At the default
 *  window size that is a few hundred thousand words — most books, whole. */
const DEFAULT_MAX_CALLS = 120

export interface DistillOptions {
  signal?: AbortSignal
  onProgress?: (p: DistillProgress) => void
  /** Prompt budget in weight units. Default: what the chat model declares
   *  (`ChatModel.inputBudget`), else `DEFAULT_INPUT_BUDGET`. */
  inputBudget?: number
  /** Window size in weight units, overriding the value derived from the
   *  budget (`[distill] windowSize`). 0/absent = derived. */
  windowSize?: number
  /** Ceiling on model calls (`[distill] maxCalls`, default 120). Over it, the
   *  document is sampled at an even stride and coverage says by how much. */
  maxCalls?: number
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
  /** Model calls the plan needs — one per window (a lower bound: a window the
   *  model rejects for length is split, which costs extra calls). */
  calls: number
  /** Fraction (0..1) of the document's text, by weight, the model will be shown. */
  coverage: number
  /** Windows the whole document needs, before the call budget is applied. */
  totalWindows: number
  /** The call budget this estimate was made against (`[distill] maxCalls`). */
  maxCalls: number
}

/** The fixed weight of an extraction prompt with no chunks and no registry —
 *  the instructions, the schema and the user preamble. Measured once from the
 *  real prompt builder rather than estimated, so the window arithmetic below
 *  cannot drift away from what is actually sent. */
let fixedPromptWeight: number | null = null
function promptOverhead(): number {
  if (fixedPromptWeight === null) {
    const { system, user } = buildExtractionPrompt([])
    fixedPromptWeight = weightOf(system) + weightOf(user)
  }
  return fixedPromptWeight
}

/**
 * Pure: how a prompt budget is spent. The model declares what it will accept;
 * out of that come the fixed instructions, the concept registry and room for
 * the answer, and what is left is what the planner may fill with source text.
 */
export function windowBudgets(inputBudget: number): {
  windowWeight: number
  registryBudget: number
} {
  const reserve = Math.floor(inputBudget * OUTPUT_RESERVE)
  const registryBudget = Math.min(REGISTRY_BUDGET, reserve)
  return {
    windowWeight: Math.max(
      MIN_WINDOW_WEIGHT,
      inputBudget - promptOverhead() - registryBudget - reserve
    ),
    registryBudget
  }
}

/** The plan a run will follow, and the registry budget its calls will carry. */
function planFor(
  chunks: Chunk[],
  opts: DistillOptions
): ReturnType<typeof planWindows> & { registryBudget: number } {
  const budget = opts.inputBudget && opts.inputBudget > 0 ? opts.inputBudget : DEFAULT_INPUT_BUDGET
  const derived = windowBudgets(budget)
  const windowWeight =
    opts.windowSize && opts.windowSize > 0 ? opts.windowSize : derived.windowWeight
  return {
    ...planWindows(chunks, {
      windowWeight,
      maxCalls: opts.maxCalls ?? DEFAULT_MAX_CALLS,
      perChunkOverhead: CHUNK_OVERHEAD
    }),
    registryBudget: derived.registryBudget
  }
}

/**
 * Plan a run without running it: chunk the text and ask the same pure planner
 * the run uses. Cheap and deterministic, so the estimate the user sees is the
 * plan the run then follows.
 */
export function estimateDistill(text: string, opts: DistillOptions = {}): DistillEstimate {
  const chunks = chunkMarkdown(text)
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
  if (chunks.length === 0)
    return { chunks: 0, calls: 0, coverage: 1, totalWindows: 0, maxCalls }
  const plan = planFor(chunks, opts)
  return {
    chunks: chunks.length,
    calls: plan.windows.length,
    coverage: plan.coverage,
    totalWindows: plan.totalWindows,
    maxCalls
  }
}

export interface DistillResult {
  notes: EmittedNote[]
  stats: {
    chunks: number
    /** Windows read — one model call each, before any length-split. */
    windows: number
    /** Extraction calls actually attempted, including the ones a provider
     *  rejected for length before their halves were read. */
    calls: number
    /** How many times a rejected window was halved and read as two. */
    splits: number
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
    failedWindows: number
    /** Shape of the run's link graph (see shared DistillStats and link.ts). */
    edges: number
    ghostLinks: number
    mentions: number
    components: number
    /** Share (0..1) of the document's text, by weight, that was read. */
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

/** Extract one window, with a single repair retry on unparseable JSON. */
async function extractWindow(
  chat: ChatModel,
  chunks: { chunkId: number; heading: string; text: string }[],
  registry: string,
  signal?: AbortSignal
): Promise<{ items: ExtractedItem[]; failed: boolean }> {
  const { system, user } = buildExtractionPrompt(chunks, { registry })
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
 * before the first real call, not half-way through. The optional signal bounds
 * the wait.
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

/** What reading one window (possibly split into several calls) produced. */
interface WindowOutcome {
  items: ExtractedItem[]
  /** Calls that came back unusable — bad JSON, a hard failure, or a rejection
   *  that could not be split any further. */
  failed: number
  /** The last hard error, if one occurred. Only these count towards the
   *  three-strikes circuit breaker: bad JSON and a too-long prompt are this
   *  window's problem, a dead provider is the run's. */
  error?: unknown
}

/** Everything the extraction loop carries from window to window. */
interface ReadContext {
  chat: ChatModel
  chunks: Chunk[]
  prov: Map<number, ChunkProvenance>
  registry: ConceptRegistry
  registryBudget: number
  /** chunk id → the ids shown in the same call, for grounding's re-attribution. */
  windowOf: Map<number, number[]>
  retry?: RetryOptions
  signal?: AbortSignal
  calls: number
  splits: number
}

/** Titles this window contributed, for the next window's prompt. Grounded
 *  against the window's own chunks first: a title the model invented with no
 *  quote behind it must not be advertised to the rest of the run as an
 *  established concept. */
function registerTitles(ctx: ReadContext, items: ExtractedItem[], ids: number[]): void {
  if (items.length === 0) return
  const { notes } = groundItems(items, ctx.prov, { windowOf: () => ids })
  ctx.registry.add(notes.map((n) => n.title))
}

/**
 * Read one window, splitting it in half if the provider rejects it for length.
 * The split is the honest answer to an optimistic budget: the same text still
 * gets read, in two calls instead of one, and nothing is dropped. Bounded by
 * `MAX_SPLIT_DEPTH` — past that the window is written off, counted, and the
 * run carries on with the rest of the document.
 */
async function readWindow(ctx: ReadContext, ids: number[], depth: number): Promise<WindowOutcome> {
  throwIfAborted(ctx.signal)
  ctx.calls++
  for (const id of ids) ctx.windowOf.set(id, ids)
  const shown = ids.map((id) => ({
    chunkId: id,
    heading: ctx.chunks[id].heading,
    text: ctx.chunks[id].text
  }))
  try {
    const { items, failed } = await withRetry(
      () => extractWindow(ctx.chat, shown, ctx.registry.render(ctx.registryBudget), ctx.signal),
      { ...ctx.retry, signal: ctx.signal }
    )
    registerTitles(ctx, items, ids)
    return { items, failed: failed ? 1 : 0 }
  } catch (err) {
    throwIfAborted(ctx.signal)
    if (err instanceof DistillAborted) throw err
    if (err instanceof ContextLengthError) {
      if (depth >= MAX_SPLIT_DEPTH || ids.length < 2) return { items: [], failed: 1 }
      ctx.splits++
      const mid = Math.ceil(ids.length / 2)
      // In order, so the second half's prompt carries what the first half named.
      const a = await readWindow(ctx, ids.slice(0, mid), depth + 1)
      const b = await readWindow(ctx, ids.slice(mid), depth + 1)
      return {
        items: [...a.items, ...b.items],
        failed: a.failed + b.failed,
        error: b.error ?? a.error
      }
    }
    return { items: [], failed: 1, error: err }
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

  // 2. Plan the windows (pure). A resume starts from the plan the first attempt
  //    committed to — the windows are already decided, and re-deciding could
  //    only shift them under the results already recorded. A plan that no
  //    longer fits the text is ignored rather than trusted.
  const saved = opts.checkpoint?.load() ?? null
  const savedPlan =
    saved?.plan && saved.plan.every((w) => w.every((id) => id >= 0 && id < chunks.length))
      ? saved.plan
      : null
  // The model side declares how much prompt it accepts; an explicit option
  // (the estimate's, or a test's) wins over it.
  const planned = planFor(chunks, {
    ...opts,
    inputBudget: opts.inputBudget ?? deps.chat.inputBudget
  })
  let plan: number[][]
  let coverage: number
  if (savedPlan) {
    plan = savedPlan
    coverage = coverageOf(chunks, savedPlan.flat())
  } else {
    plan = planned.windows.map((w) => w.chunkIds)
    coverage = planned.coverage
    opts.checkpoint?.save({ type: 'plan', windows: plan })
  }

  // 3. Extract per window (injected chat), in document order. Each shown chunk
  //    remembers the call it was shown in, so grounding can look for a
  //    mislabelled quote in the other chunks of that same prompt.
  //
  //    A failed call costs its window, not the run: transient failures are
  //    retried with backoff, a rejection for length is split and read as two,
  //    and what is left is counted and skipped. Three hard failures in a row do
  //    stop the run — that is a provider that is not coming back, and the
  //    remaining windows would fail just as slowly.
  const ctx: ReadContext = {
    chat: deps.chat,
    chunks,
    prov,
    registry: new ConceptRegistry(),
    registryBudget: planned.registryBudget,
    windowOf: new Map<number, number[]>(),
    retry: opts.retry,
    signal: opts.signal,
    calls: 0,
    splits: 0
  }
  const extracted: ExtractedItem[] = []
  const maxConsecutive = opts.maxConsecutiveFailures ?? 3
  let failedWindows = 0
  let consecutiveErrors = 0
  report('extracting', 0, plan.length)
  for (let i = 0; i < plan.length; i++) {
    throwIfAborted(opts.signal)
    const ids = plan[i]
    const already = saved?.done.get(i)
    if (already) {
      // Recorded by an earlier attempt — replay it, don't pay for it twice.
      for (const id of ids) ctx.windowOf.set(id, ids)
      if (already.failed) failedWindows++
      registerTitles(ctx, already.items, ids)
      extracted.push(...already.items)
      report('extracting', i + 1, plan.length)
      continue
    }
    const outcome = await readWindow(ctx, ids, 0)
    failedWindows += outcome.failed
    if (outcome.error) {
      if (++consecutiveErrors >= maxConsecutive) throw outcome.error
    } else consecutiveErrors = 0
    // The checkpoint records the window as one unit whatever it took to read:
    // a resume replays what the window produced, not how many calls it cost.
    opts.checkpoint?.save(
      outcome.items.length === 0 && outcome.failed > 0
        ? { type: 'window', index: i, failed: true }
        : { type: 'window', index: i, items: outcome.items }
    )
    extracted.push(...outcome.items)
    report('extracting', i + 1, plan.length)
  }

  // 4–6. Ground → dedup → emit (all pure).
  report('finalizing', 0, 1)
  const {
    notes: grounded,
    dropped: droppedByReason,
    recovered
  } = groundItems(extracted, prov, {
    windowOf: (chunkId) => ctx.windowOf.get(chunkId) ?? [],
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

  return {
    notes: emitted.notes,
    stats: {
      chunks: chunks.length,
      windows: plan.length,
      calls: ctx.calls,
      splits: ctx.splits,
      extracted: extracted.length,
      grounded: grounded.length,
      dropped: droppedByReason.noEvidence + droppedByReason.notFound + droppedByReason.ambiguous,
      droppedByReason,
      recovered,
      merged,
      notes: emitted.notes.length,
      failedWindows,
      edges: emitted.edges,
      ghostLinks: emitted.ghostLinks,
      mentions: emitted.mentions,
      components: emitted.components,
      coverage
    }
  }
}
