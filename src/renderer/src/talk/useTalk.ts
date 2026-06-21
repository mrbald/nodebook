import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchHit, TalkStatus } from '@shared/types'
import { getEmbedder, disposeEmbedder, type Embedder } from './embedder'

export type TalkPhase = 'off' | 'loading-model' | 'indexing' | 'ready' | 'error'

export interface UseTalk {
  status: TalkStatus | null
  phase: TalkPhase
  /** During indexing: how many chunks are embedded out of the total. */
  progress: { done: number; total: number } | null
  /** Semantic retrieval is live (model loaded + enabled). */
  ready: boolean
  enable: () => Promise<void>
  disable: () => Promise<void>
  /** Embed the query and run hybrid search; falls back to keyword if not ready. */
  searchSemantic: (query: string) => Promise<SearchHit[]>
  /** Call after a vault is (re)opened to resume indexing for the new vault. */
  onVaultOpened: () => void
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
  const embedderRef = useRef<Embedder | null>(null)
  const drainingRef = useRef(false)

  const ensureEmbedder = useCallback(async (): Promise<Embedder> => {
    if (embedderRef.current) return embedderRef.current
    setPhase('loading-model')
    const settings = await window.nodebook.readSettings()
    const e = await getEmbedder(settings.talk.embed.model)
    embedderRef.current = e
    return e
  }, [])

  // Pull pending chunks, embed them in batches, store the vectors — until dry.
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return
    drainingRef.current = true
    try {
      const e = await ensureEmbedder()
      let st = await window.nodebook.talkStatus()
      if (st.pending > 0) setPhase('indexing')
      while (st.pending > 0) {
        const batch = await window.nodebook.talkPending(32)
        if (batch.length === 0) break
        const vectors = await e.embed(batch.map((c) => c.text))
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
      console.error('[talk] indexing failed', err)
      setPhase('error')
    } finally {
      drainingRef.current = false
    }
  }, [ensureEmbedder])

  const enable = useCallback(async (): Promise<void> => {
    const e = await ensureEmbedder()
    setStatus(await window.nodebook.talkEnable(e.dims))
    await drain()
  }, [ensureEmbedder, drain])

  const disable = useCallback(async (): Promise<void> => {
    const st = await window.nodebook.talkDisable()
    disposeEmbedder()
    embedderRef.current = null
    setStatus(st)
    setProgress(null)
    setPhase('off')
  }, [])

  const searchSemantic = useCallback(async (query: string): Promise<SearchHit[]> => {
    const e = embedderRef.current
    if (!e) return window.nodebook.search(query)
    const [vec] = await e.embed([query])
    return window.nodebook.talkSearch(query, Array.from(vec))
  }, [])

  const resume = useCallback(async (): Promise<void> => {
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
    ready: phase === 'ready' && !!status?.enabled,
    enable,
    disable,
    searchSemantic,
    onVaultOpened
  }
}
