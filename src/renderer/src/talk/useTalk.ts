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
  refreshCanAsk: () => Promise<void>
  /** Ask a grounded question; answer tokens arrive via `onToken`. */
  ask: (question: string, onToken: (t: string) => void, signal: AbortSignal) => Promise<AskResult>
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
  const embedderRef = useRef<{ embedder: Embedder; model: string } | null>(null)
  const sessionRef = useRef<{ embedder: Embedder; generation: string; vaultId: string } | null>(null)
  const drainingRef = useRef(false)
  // A drain requested while one is already running (e.g. a talk:dirty poke
  // landing mid-loop, or an embedder swap) must not be lost — the running
  // drain may be about to exit on a stale error. Queue exactly one re-run.
  const drainQueuedRef = useRef(false)
  // Bumped whenever the embedder is disposed (settings swap, disable). An
  // ensureEmbedder that awaited across a bump must not publish its now-stale
  // embedder — nor let its caller register the stale dims with main.
  const embedEpochRef = useRef(0)

  const ensureEmbedder = useCallback(async () => {
    if (embedderRef.current) return embedderRef.current
    const epoch = embedEpochRef.current
    setPhase('loading-model')
    setModelProgress(null)
    const settings = await window.nodebook.readSettings()
    if (epoch !== embedEpochRef.current) throw new Error(EMBEDDER_DISPOSED)
    const e = await getEmbedder(settings.talk.embed.model, {
      threads: settings.talk.embed.threads,
      onProgress: (f) => setModelProgress(f)
    })
    if (epoch !== embedEpochRef.current) throw new Error(EMBEDDER_DISPOSED) // superseded
    embedderRef.current = { embedder: e, model: settings.talk.embed.model }
    setModelProgress(null)
    return embedderRef.current
  }, [])

  // Keep the selected model and store generation together for the whole drain.
  const drain = useCallback(async (): Promise<void> => {
    const session = sessionRef.current
    if (!session) return
    if (drainingRef.current) {
      drainQueuedRef.current = true
      return
    }
    const current = (st: TalkStatus): boolean =>
      sessionRef.current === session && st.generation === session.generation
    drainingRef.current = true
    try {
      let st = await window.nodebook.talkStatus()
      if (!current(st)) return
      if (st.pending > 0) setPhase('indexing')
      while (st.pending > 0) {
        const batch = await window.nodebook.talkPending(session.generation, 32)
        if (batch.length === 0 || sessionRef.current !== session) return
        const vectors = await session.embedder.embed(batch.map((c) => c.text))
        if (sessionRef.current !== session) return
        st = await window.nodebook.talkPutEmbeddings(
          session.generation,
          batch.map((c, i) => ({ id: c.id, vector: Array.from(vectors[i]) }))
        )
        if (!current(st)) return
        setStatus(st)
        setProgress({ done: st.total - st.pending, total: st.total })
      }
      setProgress(null)
      setPhase('ready')
      setStatus(st)
    } catch (err) {
      if (sessionRef.current === session && !isDisposedError(err)) {
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
  }, [])

  const enable = useCallback(async (): Promise<void> => {
    const epoch = embedEpochRef.current
    try {
      const { vaultId } = await window.nodebook.talkStatus()
      if (!vaultId || epoch !== embedEpochRef.current) return
      const { embedder, model } = await ensureEmbedder()
      if (epoch !== embedEpochRef.current) return
      const st = await window.nodebook.talkEnable(vaultId, model, embedder.dims)
      if (epoch !== embedEpochRef.current || st.vaultId !== vaultId || !st.ready || !st.generation)
        return
      sessionRef.current = { embedder, generation: st.generation, vaultId }
      setStatus(st)
      await drain()
    } catch (err) {
      if (epoch !== embedEpochRef.current || isDisposedError(err)) return
      console.error('[talk] enable failed', err)
      setPhase('error')
    }
  }, [ensureEmbedder, drain])

  const disable = useCallback(async (): Promise<void> => {
    embedEpochRef.current++
    disposeEmbedder()
    embedderRef.current = null
    sessionRef.current = null
    setStatus(await window.nodebook.talkDisable())
    setProgress(null)
    setPhase('off')
  }, [])

  // A threads-only change reloads the worker but retains the existing vector
  // space. Main decides whether to rebuild from the model it registered.
  const onEmbedConfigChanged = useCallback(
    async (): Promise<void> => {
      const epoch = ++embedEpochRef.current
      disposeEmbedder()
      embedderRef.current = null
      sessionRef.current = null
      const st = await window.nodebook.talkStatus()
      if (st.enabled && epoch === embedEpochRef.current) await enable()
    },
    [enable]
  )

  const searchSemantic = useCallback(async (query: string): Promise<SearchHit[]> => {
    const session = sessionRef.current
    if (!session) return window.nodebook.search(query)
    try {
      const [vec] = await session.embedder.embed([query], 'query')
      if (sessionRef.current === session)
        return window.nodebook.talkSearch(query, session.generation, Array.from(vec))
    } catch (err) {
      if (!isDisposedError(err)) console.error('[talk] query embedding failed', err)
    }
    return window.nodebook.search(query)
  }, [])

  const ask = useCallback(
    async (question: string, onToken: (t: string) => void, signal: AbortSignal): Promise<AskResult> => {
      const { vaultId, generation } = await window.nodebook.talkStatus()
      if (!vaultId) throw new Error('Open a vault first.')
      signal.throwIfAborted()
      const session = sessionRef.current
      let vector: number[] = []
      if (session && session.vaultId === vaultId && session.generation === generation) {
        try {
          const [v] = await session.embedder.embed([question], 'query')
          if (sessionRef.current === session) vector = Array.from(v)
        } catch (err) {
          if (!isDisposedError(err)) console.error('[talk] question embedding failed', err)
        }
      }
      signal.throwIfAborted()
      const id = crypto.randomUUID()
      const cancel = (): void => window.nodebook.cancelAsk(id)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        return await window.nodebook.ask({ id, vaultId, question, generation, vector }, onToken)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    []
  )

  const refreshCanAsk = useCallback(async (): Promise<void> => {
    setCanAsk(await window.nodebook.canAsk())
  }, [])

  const resume = useCallback(async (): Promise<void> => {
    void refreshCanAsk()
    const st = await window.nodebook.talkStatus()
    setStatus(st)
    if (st.enabled) await enable()
    else setPhase('off')
  }, [enable, refreshCanAsk])

  const onVaultOpened = useCallback((): void => {
    embedEpochRef.current++
    sessionRef.current = null
    setPhase('off')
    void resume()
  }, [resume])

  // On mount: resume if the feature was left enabled; subscribe to re-embed pokes.
  useEffect(() => {
    void resume()
    const off = window.nodebook.onTalkDirty(() => {
      if (sessionRef.current) void drain()
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
    refreshCanAsk,
    ask,
    onVaultOpened,
    onEmbedConfigChanged
  }
}
