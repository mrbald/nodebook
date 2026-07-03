import { useCallback, useRef, useState } from 'react'

interface Options {
  /** Identifies the current document; switching it resets dirty tracking. */
  docKey: string | null
  /** The document's on-disk content (the saved baseline). */
  initialDoc: string | null
  /** Persist content to disk. May return a promise; a rejection (e.g. a
   *  disk conflict) keeps the buffer dirty instead of pretending it saved. */
  persist: (content: string, force?: boolean) => void | Promise<void>
  /** Autosave after this many ms of no typing. 0 = off. */
  autosaveDelayMs: number
  /** Whether this doc should flush on switch / window close. */
  autosaveOnSwitch: boolean
}

/**
 * Tracks unsaved state for one editor buffer and applies the user's save policy
 * (optional delay autosave; ⌘S / switch / close handled by the caller).
 *
 * The live content lives in a ref, and `dirty` only flips when crossing the
 * clean⇄dirty boundary — so typing does NOT re-render React. That keeps the
 * editor an uncontrolled imperative island (we never feed content back in).
 */
export function useDirtyDoc({
  docKey,
  initialDoc,
  persist,
  autosaveDelayMs,
  autosaveOnSwitch
}: Options) {
  const [dirty, setDirty] = useState(false)
  const contentRef = useRef<string | null>(initialDoc)
  const savedRef = useRef<string | null>(initialDoc)
  const persistRef = useRef(persist)
  persistRef.current = persist
  const cfg = useRef({ autosaveDelayMs, autosaveOnSwitch })
  cfg.current = { autosaveDelayMs, autosaveOnSwitch }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevKey = useRef<string | null>(docKey)

  // Reset the baseline SYNCHRONOUSLY when the document changes (file switch), so
  // getContent() is never stale mid-switch — reading it in a useEffect would run
  // after render and the editor would briefly show the previous file's content.
  if (prevKey.current !== docKey) {
    prevKey.current = docKey
    contentRef.current = initialDoc
    savedRef.current = initialDoc
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setDirty(false) // React's "adjust state on prop change" pattern
  }

  const saveNow = useCallback((force = false) => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const c = contentRef.current
    if (c == null || c === savedRef.current) return
    // Update the baseline only when the save actually lands: a rejected save
    // (disk conflict) must leave the buffer dirty, or the user's text would
    // show as saved while the disk still holds someone else's bytes. The key
    // guard drops a settle that arrives after a file switch already reset us.
    const key = prevKey.current
    Promise.resolve(persistRef.current(c, force)).then(
      () => {
        if (prevKey.current !== key) return
        savedRef.current = c
        setDirty(contentRef.current !== c)
      },
      () => {
        if (prevKey.current !== key) return
        savedRef.current = null // on-disk state unknown — anything is dirty now
        setDirty(true)
      }
    )
  }, [])

  const onChange = useCallback(
    (content: string) => {
      contentRef.current = content
      setDirty(content !== savedRef.current)
      if (cfg.current.autosaveDelayMs > 0) {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(saveNow, cfg.current.autosaveDelayMs)
      }
    },
    [saveNow]
  )

  const getContent = useCallback(() => contentRef.current, [])
  const onSwitchEnabled = useCallback(() => cfg.current.autosaveOnSwitch, [])

  return { dirty, onChange, saveNow, getContent, onSwitchEnabled }
}
