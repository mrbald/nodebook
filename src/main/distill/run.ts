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
import { emitNotes, type EmittedNote } from './emit'

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
 *  embedder satisfies this via the main↔renderer bridge; tests pass a stub). */
export interface DistillEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>
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
}

export interface DistillResult {
  notes: EmittedNote[]
  stats: {
    chunks: number
    clusters: number
    extracted: number
    grounded: number
    dropped: number
    merged: number
    notes: number
    failedClusters: number
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

  // 2. Embed (injected), batched.
  const embedBatch = opts.embedBatch ?? 32
  const points: Point[] = []
  report('embedding', 0, chunks.length)
  for (let i = 0; i < chunks.length; i += embedBatch) {
    throwIfAborted(opts.signal)
    const slice = chunks.slice(i, i + embedBatch)
    const vecs = await deps.embedder.embed(slice.map(embedText))
    if (vecs.length !== slice.length) throw new Error('embedder returned the wrong number of vectors')
    slice.forEach((_, j) => points.push({ id: i + j, vec: vecs[j] }))
    report('embedding', Math.min(i + embedBatch, chunks.length), chunks.length)
  }

  // 3. Cluster (pure). The ceiling bounds the extraction-call budget.
  throwIfAborted(opts.signal)
  const k = chooseK(chunks.length, {
    perCluster: opts.perCluster,
    min: opts.minClusters,
    max: opts.maxClusters
  })
  const clusters = kmeans(points, k, { repCount: opts.repsPerCluster })
  report('clustering', clusters.length, clusters.length)

  // 4. Extract per cluster (injected chat), with repair retry.
  const extracted: ExtractedItem[] = []
  let failedClusters = 0
  report('extracting', 0, clusters.length)
  for (let i = 0; i < clusters.length; i++) {
    throwIfAborted(opts.signal)
    const cc = clusters[i].representativeIds.map((id) => ({
      chunkId: id,
      heading: chunks[id].heading,
      text: chunks[id].text
    }))
    const { items, failed } = await extractCluster(deps.chat, cc, opts.signal)
    if (failed) failedClusters++
    extracted.push(...items)
    report('extracting', i + 1, clusters.length)
  }

  // 5–7. Ground → dedup → emit (all pure).
  report('finalizing', 0, 1)
  const { notes: grounded, droppedTitles } = groundItems(extracted, prov)
  const { notes: deduped, merged } = dedup(grounded)
  const emitted = emitNotes(deduped)
  report('done', 1, 1)

  return {
    notes: emitted,
    stats: {
      chunks: chunks.length,
      clusters: clusters.length,
      extracted: extracted.length,
      grounded: grounded.length,
      dropped: droppedTitles.length,
      merged,
      notes: emitted.length,
      failedClusters
    }
  }
}
