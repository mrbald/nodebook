import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * Keeps fenced/indented code blocks in a monospace font in every mode. The
 * editor body is proportional, and once `codeLanguages` nest-parses a fenced
 * block its inner tokens are keywords/strings/etc. (not the `monospace` tag),
 * so without this they'd render colored-but-proportional. A mark over the whole
 * `FencedCode`/`CodeBlock` range fixes that and composes with the syntax colors.
 */
const MONO = Decoration.mark({ class: 'cm-code-block' })

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
          b.add(n.from, n.to, MONO)
          return false
        }
        return undefined
      }
    })
  }
  return b.finish()
}

export const codeBlockFont: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)
