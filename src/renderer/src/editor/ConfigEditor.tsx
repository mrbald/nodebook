import { useMemo, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { StreamLanguage, indentOnInput } from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { searchKeymap } from '@codemirror/search'
import { useCodeMirror } from './useCodeMirror'
import { getEditorTheme } from './themes'

interface Props {
  initialDoc: string
  /** Receives the editor's current text on every change; save policy is upstream. */
  onChange: (content: string) => void
  /** Editor color theme name (e.g. "dark"); switches live. */
  theme: string
}

/**
 * A plain code editor for the settings TOML — the same CodeMirror island as the
 * note editor (via `useCodeMirror`), but with TOML highlighting and line numbers
 * instead of the markdown live-preview extensions. No wikilinks, no decorations.
 */
export function ConfigEditor({ initialDoc, onChange, theme }: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const extensions = useMemo(
    () => [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      StreamLanguage.define(toml),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap])
    ],
    []
  )

  const { containerRef } = useCodeMirror({
    initialDoc,
    extensions,
    theme: getEditorTheme(theme),
    onDocChange: (doc) => onChangeRef.current(doc)
  })

  return <div className="cm-host" ref={containerRef} />
}
