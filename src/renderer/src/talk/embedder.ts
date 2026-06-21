/**
 * Renderer-side embedder. Wraps the embedding Web Worker behind a small async
 * interface; main owns the vector store, so all this does is turn text into
 * vectors. A deterministic in-process stub (no model download) is used when the
 * e2e sets `window.__NODEBOOK_FAKE_EMBED__`, keeping CI fast and offline.
 */
export interface Embedder {
  readonly dims: number
  embed(texts: string[]): Promise<Float32Array[]>
  dispose(): void
}

let pending: Promise<Embedder> | null = null

/** Get (or lazily create) the singleton embedder for `model`. */
export function getEmbedder(model: string): Promise<Embedder> {
  if (!pending) pending = create(model)
  return pending
}

export function disposeEmbedder(): void {
  void pending?.then((e) => e.dispose())
  pending = null
}

function create(model: string): Promise<Embedder> {
  if ((window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__) {
    return Promise.resolve(fakeEmbedder())
  }
  return workerEmbedder(model)
}

function workerEmbedder(model: string): Promise<Embedder> {
  const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  const waiters = new Map<number, (vs: Float32Array[]) => void>()
  const rejecters = new Map<number, (e: Error) => void>()

  return new Promise<Embedder>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent): void => {
      const m = e.data
      if (m.type === 'ready') {
        resolve({
          dims: m.dims,
          embed: (texts) =>
            new Promise<Float32Array[]>((res, rej) => {
              const id = ++seq
              waiters.set(id, res)
              rejecters.set(id, rej)
              worker.postMessage({ type: 'embed', id, texts })
            }),
          dispose: () => worker.terminate()
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
        } else reject(new Error(m.message))
      }
    }
    worker.onerror = (e): void => reject(new Error(e.message))
    worker.postMessage({ type: 'init', model })
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
  return { dims, embed: (texts) => Promise.resolve(texts.map(one)), dispose: () => {} }
}
