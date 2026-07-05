/**
 * Renderer-side embedder. Wraps the embedding Web Worker behind a small async
 * interface; main owns the vector store, so all this does is turn text into
 * vectors. A deterministic in-process stub (no model download) is used when the
 * e2e sets `window.__NODEBOOK_FAKE_EMBED__`, keeping CI fast and offline.
 */
/** `'query'` gets a search-query prefix on models that need one (e.g. bge, nomic-
 *  embed — asymmetric retrieval models trained with different query/document
 *  wording); `'document'` (the default) is the plain/indexing side. See
 *  `rolePrefix` below — the prefix is applied in the worker (which owns the
 *  actual model), keyed by the same table. */
export type EmbedRole = 'query' | 'document'

export interface Embedder {
  readonly dims: number
  embed(texts: string[], role?: EmbedRole): Promise<Float32Array[]>
  dispose(): void
}

/**
 * Pure: the text prefix to prepend for `role`, given a model id — asymmetric
 * retrieval models are trained with different query/document wording, so
 * feeding the raw text both ways works but retrieves noticeably worse. Keyed
 * by a substring of the model id so it survives the `Xenova/…` mirror prefix.
 * MiniLM and anything unrecognized: no prefix (symmetric model). Lives here
 * (not embed.worker.ts) so it's a plain, unit-testable pure function; the
 * worker imports it and applies it right before the actual embed call, since
 * it's the side that owns the loaded model. Exported for unit tests.
 */
export function rolePrefix(model: string, role: EmbedRole): string {
  // bge-m3 (the multilingual bge) is trained WITHOUT instruction prefixes —
  // it must not inherit the English bge- branch below.
  if (model.includes('bge-m3')) return ''
  if (model.includes('bge-')) {
    return role === 'query' ? 'Represent this sentence for searching relevant passages: ' : ''
  }
  if (model.includes('nomic-embed')) {
    return role === 'query' ? 'search_query: ' : 'search_document: '
  }
  // The e5 family (multilingual-e5-*, e5-*-v2, …) prefixes BOTH roles. The
  // boundary check keeps ids like "…base5-…" from false-matching. -instruct
  // variants want an "Instruct: {task}\nQuery:" template we don't emit; they
  // run unprefixed (degraded, not broken).
  if (/(^|[^a-z0-9])e5-/i.test(model) && !model.includes('-instruct')) {
    return role === 'query' ? 'query: ' : 'passage: '
  }
  return ''
}

/**
 * Pure: the WASM thread count to run the ONNX session with. An explicit user
 * setting (> 0) wins; auto (0) = about half the cores, capped at 4 — q8 matmul
 * in WASM is memory-bandwidth-bound (gains flatten past ~4 threads), and
 * embedding is a background job that must not starve the UI while the user
 * types. Threads need SharedArrayBuffer (main exposes it via a Chromium flag,
 * see src/main/index.ts); without it the answer is always 1 — same behavior as
 * before threading. An explicit count is required even with SAB present: ort's
 * own auto path is gated on crossOriginIsolated, which is never true under
 * file://. Lives here (not embed.worker.ts) so it's plain and unit-testable;
 * the worker feeds in its real environment. Exported for unit tests.
 */
export function wasmThreads(setting: number, cores: number, sabAvailable: boolean): number {
  if (!sabAvailable) return 1
  if (setting > 0) return Math.floor(setting)
  return Math.min(4, Math.ceil((cores || 4) / 2))
}

/** Model-download progress: a 0..1 fraction, or null while no size is known. */
export type ProgressFn = (fraction: number | null) => void

/**
 * Pure: combine the in-flight per-file download progress into one 0..1 fraction
 * (byte-weighted), or null when no totals are known yet. Several model files
 * (tokenizer, config, onnx weights) download at once, so we sum bytes rather
 * than average percentages. Exported for unit tests.
 */
export function aggregateProgress(files: { loaded: number; total: number }[]): number | null {
  let loaded = 0
  let total = 0
  for (const f of files) {
    loaded += f.loaded
    total += f.total
  }
  if (total <= 0) return null
  return Math.min(1, loaded / total)
}

/** Rejection message for work cut off by `disposeEmbedder()`. Callers treat it
 *  as "superseded — a newer embedder owns this now", never as a failure. */
export const EMBEDDER_DISPOSED = 'embedder disposed'

export function isDisposedError(err: unknown): boolean {
  return err instanceof Error && err.message === EMBEDDER_DISPOSED
}

export interface EmbedderOptions {
  /** The `[talk.embed] threads` setting; 0/undefined = auto (see `wasmThreads`). */
  threads?: number
  /** Called with download progress while the model is first fetched. */
  onProgress?: ProgressFn
}

let pending: Promise<Embedder> | null = null

/** Get (or lazily create) the singleton embedder for `model`. Note the
 *  singleton is first-model-wins: a different `model` on a later call returns
 *  the existing embedder until `disposeEmbedder()` is called. */
export function getEmbedder(model: string, opts: EmbedderOptions = {}): Promise<Embedder> {
  if (!pending) {
    const p = create(model, opts)
    pending = p
    // A failed load (bad model id, offline) must not be cached forever —
    // clear the slot so the UI's Retry actually retries.
    p.catch(() => {
      if (pending === p) pending = null
    })
  }
  return pending
}

export function disposeEmbedder(): void {
  // The rejection case is already handled where the load was awaited; without
  // the no-op handler here, disposing a failed load would surface the same
  // error again as an unhandled rejection.
  void pending?.then(
    (e) => e.dispose(),
    () => {}
  )
  pending = null
}

function create(model: string, opts: EmbedderOptions): Promise<Embedder> {
  if ((window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__) {
    return Promise.resolve(fakeEmbedder())
  }
  return workerEmbedder(model, opts)
}

function workerEmbedder(model: string, { threads, onProgress }: EmbedderOptions): Promise<Embedder> {
  const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  const waiters = new Map<number, (vs: Float32Array[]) => void>()
  const rejecters = new Map<number, (e: Error) => void>()
  // Track each downloading file's byte progress so we can report one fraction.
  const fileProgress = new Map<string, { loaded: number; total: number }>()

  return new Promise<Embedder>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent): void => {
      const m = e.data
      if (m.type === 'progress') {
        fileProgress.set(m.file, { loaded: m.loaded, total: m.total })
        onProgress?.(aggregateProgress([...fileProgress.values()]))
      } else if (m.type === 'ready') {
        onProgress?.(1) // download complete (or served from cache)
        // Disposal must settle every in-flight and future embed(): a terminated
        // worker never answers, and an unsettled promise would leave the caller
        // (e.g. useTalk's drain loop) hanging forever.
        let disposed = false
        resolve({
          dims: m.dims,
          embed: (texts, role = 'document') =>
            disposed
              ? Promise.reject(new Error(EMBEDDER_DISPOSED))
              : new Promise<Float32Array[]>((res, rej) => {
                  const id = ++seq
                  waiters.set(id, res)
                  rejecters.set(id, rej)
                  worker.postMessage({ type: 'embed', id, texts, role })
                }),
          dispose: () => {
            disposed = true
            for (const rej of rejecters.values()) rej(new Error(EMBEDDER_DISPOSED))
            waiters.clear()
            rejecters.clear()
            worker.terminate()
          }
        })
      } else if (m.type === 'embedded') {
        waiters.get(m.id)?.(m.vectors)
        waiters.delete(m.id)
        rejecters.delete(m.id)
      } else if (m.type === 'error') {
        const rej = rejecters.get(m.id)
        if (rej) {
          rej(new Error(m.message))
          waiters.delete(m.id)
          rejecters.delete(m.id)
        } else {
          // Init failed (bad model id, network) — the worker has nothing left
          // to do; terminating stops any partial download it still holds.
          worker.terminate()
          reject(new Error(m.message))
        }
      }
    }
    worker.onerror = (e): void => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ type: 'init', model, threads: threads ?? 0 })
  })
}

/** Deterministic hashed bag-of-words embedding — used only in tests. */
function fakeEmbedder(dims = 384): Embedder {
  const one = (text: string): Float32Array => {
    const v = new Float32Array(dims)
    for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0
      v[Math.abs(h) % dims] += 1
    }
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dims; i++) v[i] /= norm
    return v
  }
  // `role` is accepted per the `Embedder` interface (for wire compatibility
  // with the e2e stub `window.__NODEBOOK_FAKE_EMBED__`, an extra ignored
  // argument) but doesn't affect the deterministic hash — tests don't need
  // query/document asymmetry, so it's simply omitted from the signature here.
  return {
    dims,
    embed: (texts) => Promise.resolve(texts.map(one)),
    dispose: () => {}
  }
}
