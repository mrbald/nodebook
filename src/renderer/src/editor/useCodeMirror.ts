import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

interface Options {
  /** Read ONCE at mount. Switch files by remounting (React `key`), not by prop. */
  initialDoc: string
  extensions: Extension
  /**
   * Theme extension, swappable live. Pass a stable reference per theme (e.g.
   * `getEditorTheme(name)`) so it only reconfigures when the theme changes.
   */
  theme?: Extension
  /**
   * View-mode extension (Code / Live / Reading), swappable live. Holds the
   * live-preview variant plus the read-only facets for Reading mode. Pass a
   * stable reference per mode so it only reconfigures on an actual mode change.
   */
  mode?: Extension
  /** Called on every doc change with the editor's current text. Debounce upstream. */
  onDocChange?: (doc: string) => void
}

/**
 * Mounts CodeMirror 6 as an imperative island: the EditorView is created once
 * and owns its own state. React never drives the document reactively — it hands
 * the doc in at mount and lifts content out via the update listener. This is
 * the discipline that keeps the editor fast; do not add `initialDoc`/`extensions`
 * to the effect deps.
 *
 * The theme lives in a Compartment so it can be reconfigured live (on a settings
 * change) without recreating the view — an imperative dispatch, not a rebind.
 */
export function useCodeMirror({ initialDoc, extensions, theme, mode, onDocChange }: Options) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const modeCompartment = useRef(new Compartment())

  // Keep the latest callback without re-running the mount effect.
  const onChangeRef = useRef(onDocChange)
  onChangeRef.current = onDocChange

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) return

    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          extensions,
          themeCompartment.current.of(theme ?? []),
          modeCompartment.current.of(mode ?? []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
          })
        ]
      }),
      parent
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Intentionally empty: mount once, uncontrolled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live theme swap without remounting.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(theme ?? []) })
  }, [theme])

  // Live view-mode swap (Code / Live / Reading) without remounting.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: modeCompartment.current.reconfigure(mode ?? []) })
  }, [mode])

  return { containerRef, viewRef }
}
