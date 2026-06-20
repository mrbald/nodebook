import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/**
 * Makes links in *Code mode* live without rendering them as widgets: the raw
 * `[[wikilink]]`, `[text](url)`, `<url>` and bare URLs get a hover-underline and
 * follow on ⌘/Ctrl-click (a plain click just places the cursor, so editing the
 * source is unaffected). Live/Reading modes already turn links into clickable
 * widgets, so this is wired only into Code mode.
 *
 * The link target is baked into the decoration's DOM as a `data-` attribute, so
 * the click handler reads it straight off the clicked element — no coordinate
 * hit-testing, which is both simpler and reliable.
 */

type OpenLink = (target: string) => void
type OpenUrl = (url: string) => void

/** Resolve what a link node points at: a wikilink target, or an external URL. */
function resolveLink(
  state: EditorState,
  node: SyntaxNode
): { kind: 'wiki'; target: string } | { kind: 'url'; url: string } | null {
  if (node.name === 'Wikilink') {
    return { kind: 'wiki', target: state.doc.sliceString(node.from + 2, node.to - 2).trim() }
  }
  if (node.name === 'Link') {
    const url = node.getChild('URL')
    return url ? { kind: 'url', url: state.doc.sliceString(url.from, url.to) } : null
  }
  if (node.name === 'URL' || node.name === 'Autolink') {
    const raw = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, '')
    return { kind: 'url', url: raw }
  }
  return null
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        if (n.name === 'Wikilink' || n.name === 'Link' || n.name === 'URL' || n.name === 'Autolink') {
          const link = resolveLink(view.state, n.node)
          if (link) {
            const attributes: Record<string, string> =
              link.kind === 'wiki' ? { 'data-wikilink': link.target } : { 'data-url': link.url }
            b.add(n.from, n.to, Decoration.mark({ class: 'cm-source-link', attributes }))
          }
          return false // don't descend (a URL inside a Link would overlap)
        }
        return undefined
      }
    })
  }
  return b.finish()
}

export function sourceLinks(onOpenLink: OpenLink, onOpenUrl: OpenUrl): Extension {
  const plugin = ViewPlugin.fromClass(
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

  // Affordance honesty: links underline + show the pointer ONLY while ⌘/Ctrl is
  // held (VS Code model), since that's the gesture that actually follows them.
  const affordance = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        window.addEventListener('keydown', this.sync)
        window.addEventListener('keyup', this.sync)
        window.addEventListener('blur', this.clear)
      }
      sync = (e: KeyboardEvent): void => {
        this.view.dom.classList.toggle('cm-mod-held', e.metaKey || e.ctrlKey)
      }
      clear = (): void => this.view.dom.classList.remove('cm-mod-held')
      destroy(): void {
        window.removeEventListener('keydown', this.sync)
        window.removeEventListener('keyup', this.sync)
        window.removeEventListener('blur', this.clear)
      }
    }
  )

  const click = EditorView.domEventHandlers({
    mousedown: (e) => {
      if (!(e.metaKey || e.ctrlKey)) return false
      const el = (e.target as HTMLElement | null)?.closest?.('.cm-source-link') as HTMLElement | null
      if (!el) return false
      const wiki = el.getAttribute('data-wikilink')
      if (wiki != null) {
        e.preventDefault()
        onOpenLink(wiki)
        return true
      }
      const url = el.getAttribute('data-url')
      if (url && /^https?:/i.test(url)) {
        e.preventDefault()
        onOpenUrl(url)
        return true
      }
      return false
    }
  })

  return [plugin, click, affordance]
}
