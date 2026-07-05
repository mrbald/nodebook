import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskResult, SearchHit, TalkStatus } from '@shared/types'
import {
  getEmbedder,
  disposeEmbedder,
  isDisposedError,
  EMBEDDER_DISPOSED,
  type Embedder
} from './embedder'

export type TalkPhase = 'off' | 'loading-model' | 'indexing' | 'ready' | 'error'

export interface UseTalk {
  status: TalkStatus | null
  phase: TalkPhase
  /** During indexing: how many chunks are embedded out of the total. */
  progress: { done: number; total: number } | null
  /** During model download: a 0..1 fraction, or null when size is unknown. */
  modelProgress: number | null
  /** Semantic retrieval is live (model loaded + enabled). */
  ready: boolean
  enable: () => Promise<void>
  disable: () => Promise<void>
  /** Embed the query and run hybrid search; falls back to keyword if not ready. */
  searchSemantic: (query: string) => Promise<SearchHit[]>
  /** An "Ask" chat provider is configured (provider ≠ none). */
  canAsk: boolean
  /** Ask a grounded question; answer tokens arrive via `onToken`. */
  ask: (question: string, onToken: (t: string) => void) => Promise<AskResult>
  /** Call after a vault is (re)opened to resume indexing for the new vault. */
  onVaultOpened: () => void
  /** Call when `[talk.embed]` settings changed while the app runs. Reloads the
   *  embedder; a model change (vs. threads-only) also rebuilds the index —
   *  vectors from two models never mix. No-op beyond disposal when disabled. */
  onEmbedConfigChanged: (modelChanged: boolean) => Promise<void>
}

/**
 * Orchestrates "talk to docs" from the renderer: loads the embedder (WASM),
 * drains the main process's pending-chunk queue into embeddings, and routes
 * search through the vector store. All embedding is local; main owns storage.
 */
export function useTalk(): UseTalk {
  const [status, setStatus] = useState<TalkStatus | null>(null)
  const [phase, setPhase] = useState<TalkPhase>('off')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const [canAsk, setCanAsk] = useState(false)
  const embedderRef = useRef<Embedder | null>(null)
  const drainingRef = useRef(false)
  // A drain requested while one is already running (e.g. a talk:dirty poke
  // landing mid-loop, or an embedder swap) must not be lost — the running
  // drain may be about to exit on a stale error. Queue exactly one re-run.
  const drainQueuedRef = useRef(false)
  // Bumped whenever the embedder is disposed (settings swap, disable). An
  // ensureEmbedder that awaited across a bump must not publish its now-stale
  // embedder — nor let its caller register the stale dims with main.
  const embedEpochRef = useRef(0)

  const ensureEmbedder = useCallback(async (): Promise<Embedder> => {
    if (embedderRef.current) return embedderRef.current
    const epoch = embedEpochRef.current
    setPhase('loading-model')
    setModelProgress(null)
    const settings = await window.nodebook.readSettings()
    const e = await getEmbedder(settings.talk.embed.model, {
      threads: settings.talk.embed.threads,
      onProgress: (f) => setModelProgress(f)
    })
    if (epoch !== embedEpochRef.current) throw new Error(EMBEDDER_DISPOSED) // superseded
    embedderRef.current = e
    setModelProgress(null)
    return e
  }, [])

  // Pull pending chunks, embed them in batches, store the vectors — until dry.
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) {
      drainQueuedRef.current = true
      return
    }
    drainingRef.current = true
    try {
      const e = await ensureEmbedder()
      let st = await window.nodebook.talkStatus()
      if (st.pending > 0) setPhase('indexing')
      while (st.pending > 0) {
        const batch = await window.nodebook.talkPending(32)
        if (batch.length === 0) break
        const vectors = await e.embed(batch.map((c) => c.text))
        // A settings change may have swapped the embedder mid-batch; these
        // vectors are from the old model's space — drop them, the swap's own
        // enable/drain path re-embeds with the new embedder.
        if (embedderRef.current !== e) return
        st = await window.nodebook.talkPutEmbeddings(
          batch.map((c, i) => ({ id: c.id, vector: Array.from(vectors[i]) }))
        )
        setStatus(st)
        setProgress({ done: st.total - st.pending, total: st.total })
      }
      setProgress(null)
      setPhase('ready')
      setStatus(st)
    } catch (err) {
      // A disposal is a swap in progress, not a failure — the swap's own
      // enable/drain path finishes the indexing; don't flash the error state.
      if (!isDisposedError(err)) {
        console.error('[talk] indexing failed', err)
        setPhase('error')
      }
    } finally {
      drainingRef.current = false
      if (drainQueuedRef.current) {
        drainQueuedRef.current = false
        void drain()
      }
    }
  }, [ensureEmbedder])

  const enable = useCallback(async (): Promise<void> => {
    try {
      const e = await ensureEmbedder()
      setStatus(await window.nodebook.talkEnable(e.dims))
      await drain()
    } catch (err) {
      if (isDisposedError(err)) return // superseded by a newer swap/enable
      // e.g. the model download failed (offline, bad model id) — land on the
      // error state so the panel offers Retry instead of sticking on
      // "loading-model" forever.
      console.error('[talk] enable failed', err)
      setPhase('error')
    }
  }, [ensureEmbedder, drain])

  const disable = useCallback(async (): Promise<void> => {
    const st = await window.nodebook.talkDisable()
    embedEpochRef.current++
    disposeEmbedder()
    embedderRef.current = null
    setStatus(st)
    setProgress(null)
    setPhase('off')
  }, [])

  // A live [talk.embed] settings change. The embedder singleton is
  // first-model-wins, so it must be dropped either way; when the MODEL changed
  // and the feature is on, re-running enable() rebuilds the whole index (the
  // store resets chunks+vectors on the model-id change — see
  // VectorStore.setDims) and re-embeds in the new model's space. A
  // threads-only change just reloads the worker: the vectors stay valid.
  // Never enables a disabled feature: the new settings are picked up lazily
  // by the next enable (or distill embed request).
  const onEmbedConfigChanged = useCallback(
    async (modelChanged: boolean): Promise<void> => {
      embedEpochRef.current++
      disposeEmbedder()
      embedderRef.current = null
      try {
        const st = await window.nodebook.talkStatus()
        if (!st.enabled) return
        if (modelChanged) await enable()
        else {
          // Threads-only: same model, same vectors — reload the worker, then
          // drain to restore the phase and pick up anything the interrupted
          // drain left pending.
          await ensureEmbedder()
          await drain()
        }
      } catch (err) {
        if (isDisposedError(err)) return // an even newer swap took over
        // e.g. a half-typed model id that 404s on the Hub — surface the error
        // state; the next settings save retries.
        console.error('[talk] embed config change failed', err)
        setPhase('error')
      }
    },
    [enable, ensureEmbedder, drain]
  )

  const searchSemantic = useCallback(async (query: string): Promise<SearchHit[]> => {
    const e = embedderRef.current
    if (!e) return window.nodebook.search(query)
    const [vec] = await e.embed([query], 'query')
    return window.nodebook.talkSearch(query, Array.from(vec))
  }, [])

  const ask = useCallback(
    async (question: string, onToken: (t: string) => void): Promise<AskResult> => {
      const e = embedderRef.current
      let vec: number[] = []
      if (e) {
        const [v] = await e.embed([question], 'query')
        vec = Array.from(v)
      }
      return window.nodebook.ask(question, vec, onToken)
    },
    []
  )

  const resume = useCallback(async (): Promise<void> => {
    setCanAsk(await window.nodebook.canAsk())
    const st = await window.nodebook.talkStatus()
    setStatus(st)
    if (st.enabled) await enable()
    else setPhase('off')
  }, [enable])

  const onVaultOpened = useCallback((): void => {
    void resume()
  }, [resume])

  // On mount: resume if the feature was left enabled; subscribe to re-embed pokes.
  useEffect(() => {
    void resume()
    const off = window.nodebook.onTalkDirty(() => {
      if (embedderRef.current) void drain()
    })
    return off
    // resume/drain are stable enough; we want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    status,
    phase,
    progress,
    modelProgress,
    ready: phase === 'ready' && !!status?.enabled,
    enable,
    disable,
    searchSemantic,
    canAsk,
    ask,
    onVaultOpened,
    onEmbedConfigChanged
  }
}
