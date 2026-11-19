import { useCallback, useRef, useState } from 'react'

interface Options {
  /** Identifies the current document; switching it resets dirty tracking. */
  docKey: string | null
  initialDoc: string | null
  persist: (content: string, expected: string | null) => Promise<boolean>
  /** Autosave after this many ms of no typing. 0 = off. */
  autosaveDelayMs: number
}

interface Draft {
  key: string | null
  content: string | null
  saved: string | null
  pending: Promise<boolean> | null
  timer: ReturnType<typeof setTimeout> | null
}

function makeDraft(key: string | null, content: string | null): Draft {
  return { key, content, saved: content, pending: null, timer: null }
}

function clearTimer(draft: Draft): void {
  if (draft.timer !== null) clearTimeout(draft.timer)
  draft.timer = null
}

/** Tracks the live text without re-rendering the uncontrolled editor on each edit. */
export function useDirtyDoc({ docKey, initialDoc, persist, autosaveDelayMs }: Options) {
  const [dirty, setDirty] = useState(false)
  const current = useRef(makeDraft(docKey, initialDoc))
  const options = useRef({ persist, autosaveDelayMs })
  options.current = { persist, autosaveDelayMs }

  // Use a fresh draft object even when returning to a previously opened key.
  // A pending save can only update the draft it started with.
  if (current.current.key !== docKey) {
    clearTimer(current.current)
    current.current = makeDraft(docKey, initialDoc)
    setDirty(false)
  }

  const saveNow = useCallback((): Promise<boolean> => {
    const draft = current.current
    clearTimer(draft)
    if (draft.pending) return draft.pending
    if (draft.content == null || draft.content === draft.saved) return Promise.resolve(true)
    const persistDraft = options.current.persist
    draft.pending = (async () => {
      // Carry edits made during a write forward before letting a waiting
      // navigation leave. Concurrent Save/Close calls wait on the same write.
      while (current.current === draft && draft.content != null && draft.content !== draft.saved) {
        const content = draft.content
        if (!(await persistDraft(content, draft.saved))) return false
        draft.saved = content
        if (current.current === draft) setDirty(draft.content !== content)
      }
      return current.current === draft
    })().finally(() => {
      draft.pending = null
    })
    return draft.pending
  }, [])

  const onChange = useCallback(
    (content: string) => {
      const draft = current.current
      draft.content = content
      setDirty(content !== draft.saved)
      clearTimer(draft)
      const delay = options.current.autosaveDelayMs
      if (delay > 0 && !draft.pending && content !== draft.saved) {
        draft.timer = setTimeout(() => void saveNow(), delay)
      }
    },
    [saveNow]
  )

  const pauseAutosave = useCallback(() => {
    const draft = current.current
    clearTimer(draft)
    return draft.pending
  }, [])
  const discard = useCallback(() => {
    const draft = current.current
    clearTimer(draft)
    draft.content = draft.saved
    setDirty(false)
  }, [])
  const getContent = useCallback(() => current.current.content, [])
  const hasChanges = useCallback(() => {
    const draft = current.current
    return draft.pending !== null || draft.content !== draft.saved
  }, [])

  return { dirty, onChange, saveNow, getContent, hasChanges, pauseAutosave, discard }
}
