import { useEffect, useMemo, useRef } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { indentOnInput } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { GFM } from '@lezer/markdown'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { useCodeMirror } from './useCodeMirror'
import { livePreview } from './livePreview'
import { sourceLinks } from './sourceLinks'
import { codeBlockFont } from './codeBlocks'
import { wikilinkComplete } from './wikilinkComplete'
import { WikilinkExtension } from '@shared/markdown/wikilink'
import { getEditorTheme } from './themes'

/**
 * The three markdown view modes, all rendered by CodeMirror:
 *  - `code`    — raw source with syntax highlighting (markers visible).
 *  - `live`    — Obsidian-style hybrid: markers hidden except under the cursor.
 *  - `reading` — fully styled, markers always hidden, read-only.
 */
export type ViewMode = 'code' | 'live' | 'reading'

interface Props {
  initialDoc: string
  noteNames: string[]
  /** Receives the editor's current text on every change; debounced internally. */
  onChange: (doc: string) => void
  /** Called when a wikilink pill is clicked, with the link target. */
  onOpenLink?: (target: string) => void
  /** Called when a markdown/URL link is clicked, with the URL. */
  onOpenUrl?: (url: string) => void
  /** True if a wikilink target resolves to a real note (else it's a "ghost"). */
  linkExists?: (target: string) => boolean
  /** Editor color theme name (e.g. "dark"); switches live. */
  theme: string
  /** Which of the three view modes to render; switches live. */
  mode: ViewMode
  /** Scroll to + select this character range once (a citation jump). */
  revealRange?: { from: number; to: number } | null
}

export function Editor({
  initialDoc,
  noteNames,
  onChange,
  onOpenLink,
  onOpenUrl,
  linkExists,
  theme,
  mode,
  revealRange
}: Props) {
  // Live note list for autocomplete without rebuilding the editor.
  const namesRef = useRef(noteNames)
  namesRef.current = noteNames

  // Report every change; the save policy (delay / ⌘S / switch) lives upstream.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const onOpenLinkRef = useRef(onOpenLink)
  onOpenLinkRef.current = onOpenLink

  const onOpenUrlRef = useRef(onOpenUrl)
  onOpenUrlRef.current = onOpenUrl

  const linkExistsRef = useRef(linkExists)
  linkExistsRef.current = linkExists

  // Everything that does NOT depend on the view mode. livePreview and the
  // read-only facets live in the mode compartment instead (see below).
  const extensions = useMemo(
    () => [
      history(),
      drawSelection(),
      indentOnInput(),
      // codeLanguages lazy-loads a grammar per fenced-block info string so
      // ```js / ```python / … get real language highlighting.
      markdown({ extensions: [GFM, WikilinkExtension], codeLanguages: languages }),
      codeBlockFont,
      autocompletion({ override: [wikilinkComplete(() => namesRef.current)] }),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, ...searchKeymap])
    ],
    []
  )

  // The mode extension is reconfigured in place (no remount) when `mode` flips.
  // Refs keep the click handlers stable, so this only rebuilds on a real change.
  const modeExtension = useMemo<Extension>(() => {
    const preview = (reveal: boolean): Extension =>
      livePreview(
        (target) => onOpenLinkRef.current?.(target),
        (url) => onOpenUrlRef.current?.(url),
        reveal,
        (target) => linkExistsRef.current?.(target) ?? true
      )
    switch (mode) {
      case 'code':
        // No live-preview widgets, so links are raw text — make them ⌘-clickable.
        return [
          highlightActiveLine(),
          sourceLinks(
            (target) => onOpenLinkRef.current?.(target),
            (url) => onOpenUrlRef.current?.(url)
          )
        ]
      case 'live':
        return [highlightActiveLine(), preview(true)]
      case 'reading':
        return [preview(false), EditorState.readOnly.of(true), EditorView.editable.of(false)]
    }
  }, [mode])

  const { containerRef, viewRef } = useCodeMirror({
    initialDoc,
    extensions,
    theme: getEditorTheme(theme),
    mode: modeExtension,
    onDocChange: (doc) => onChangeRef.current(doc)
  })

  // Jump to a cited span: select + centre it once (a Sources-panel click). Runs
  // after the view mounts because this effect is registered after useCodeMirror's.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !revealRange) return
    const len = view.state.doc.length
    const from = Math.max(0, Math.min(revealRange.from, len))
    const to = Math.max(from, Math.min(revealRange.to, len))
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    })
    view.focus()
  }, [revealRange, viewRef])

  return <div className={`cm-host cm-mode-${mode}`} ref={containerRef} />
}
