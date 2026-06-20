import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/**
 * Obsidian-style live preview in source mode, driven by the markdown syntax
 * tree (not regex). The raw markdown stays the one source of truth; we only
 * decorate. Because we walk the tree, emphasis/code markers inside fenced code
 * blocks, URLs, etc. are never mis-decorated.
 *
 * The defining behavior is reveal-on-cursor: when the selection touches a
 * decorated span we skip its decoration so the raw markdown shows and stays
 * editable in place.
 *
 * `computeSpans` is pure — state in, plain objects out — so it is unit-testable
 * in Node with no DOM. The view plugin maps spans to decorations and registers
 * only the *replacement* spans (pills, links, hidden markers) as atomic ranges;
 * styling marks must NOT be atomic, or the cursor couldn't move through them.
 */

export type OpenLink = (target: string) => void
export type OpenUrl = (url: string) => void

export type SpanKind = 'pill' | 'link' | 'hide' | 'bold' | 'italic' | 'code' | 'codeblock' | 'heading'

export interface DecoSpan {
  from: number
  to: number
  kind: SpanKind
  /** Wikilink target ('pill') or external URL ('link'). */
  target?: string
  /** Display text for a 'link'. */
  label?: string
  /** Heading level 1-6 ('heading'). */
  level?: number
}

const INNER_KIND: Record<string, SpanKind> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  InlineCode: 'code'
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/** Hide the leading/trailing marker children, style the content between them. */
function collectWrapped(
  state: EditorState,
  node: SyntaxNode,
  out: DecoSpan[],
  reveal: boolean
): void {
  if (reveal && selectionTouches(state, node.from, node.to)) return
  const marks: Array<[number, number]> = []
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name.endsWith('Mark')) marks.push([c.from, c.to])
  }
  if (marks.length === 0) return
  for (const [f, t] of marks) out.push({ from: f, to: t, kind: 'hide' })
  const innerFrom = marks[0][1]
  const innerTo = marks[marks.length - 1][0]
  if (innerTo > innerFrom) out.push({ from: innerFrom, to: innerTo, kind: INNER_KIND[node.name] })
}

/** Extract display text + URL from a Link / Autolink / bare URL node. */
function linkInfo(state: EditorState, node: SyntaxNode): { label: string; url: string } | null {
  if (node.name === 'Link') {
    const urlNode = node.getChild('URL')
    if (!urlNode) return null // reference-style link, leave raw
    const url = state.doc.sliceString(urlNode.from, urlNode.to)
    const marks: SyntaxNode[] = []
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'LinkMark') marks.push(c)
    }
    const label = marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : url
    return { label: label || url, url }
  }
  // Autolink (<url>) or GFM bare URL.
  const text = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, '')
  return { label: text, url: text }
}

/**
 * Pure: given an editor state and the ranges to scan, return the decoration
 * spans, sorted by position with overlaps dropped (e.g. nested emphasis).
 */
export function computeSpans(
  state: EditorState,
  ranges: ReadonlyArray<{ from: number; to: number }>,
  reveal = true
): DecoSpan[] {
  const out: DecoSpan[] = []
  const tree = syntaxTree(state)

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        const name = ref.name

        if (name === 'Wikilink') {
          if (reveal && selectionTouches(state, ref.from, ref.to)) return false
          out.push({
            from: ref.from,
            to: ref.to,
            kind: 'pill',
            target: state.doc.sliceString(ref.from + 2, ref.to - 2).trim()
          })
          return false
        }

        if (name === 'Link' || name === 'Autolink' || name === 'URL') {
          if (reveal && selectionTouches(state, ref.from, ref.to)) return false
          const info = linkInfo(state, ref.node)
          if (info) out.push({ from: ref.from, to: ref.to, kind: 'link', target: info.url, label: info.label })
          return false
        }

        if (name === 'FencedCode' || name === 'CodeBlock') {
          // Always monospace (not reveal-gated) so code blocks read as code.
          out.push({ from: ref.from, to: ref.to, kind: 'codeblock' })
          return false
        }

        if (name in INNER_KIND) {
          collectWrapped(state, ref.node, out, reveal)
          return false
        }

        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          const level = Number(heading[1])
          // Reading mode (reveal=false) hides the `#` marker too — "style only,
          // no formatting symbols". Live mode keeps it styled-but-visible so the
          // source stays honest while editing.
          const mark = ref.node.getChild('HeaderMark')
          if (!reveal && mark) {
            const ws = /^\s+/.exec(state.doc.sliceString(mark.to, ref.to))
            const contentFrom = mark.to + (ws ? ws[0].length : 0)
            if (contentFrom < ref.to) {
              out.push({ from: ref.from, to: contentFrom, kind: 'hide' })
              out.push({ from: contentFrom, to: ref.to, kind: 'heading', level })
            } else {
              out.push({ from: ref.from, to: ref.to, kind: 'heading', level })
            }
          } else {
            out.push({ from: ref.from, to: ref.to, kind: 'heading', level })
          }
        }

        return undefined
      }
    })
  }

  out.sort((a, b) => a.from - b.from || a.to - b.to)

  const kept: DecoSpan[] = []
  let lastTo = -1
  for (const s of out) {
    if (s.from < lastTo) continue // drop overlaps instead of risking a RangeSet throw
    kept.push(s)
    lastTo = s.to
  }
  return kept
}

// --- span -> decoration mapping (the only DOM-aware part) ------------------

class WikilinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly onOpen?: OpenLink
  ) {
    super()
  }
  eq(other: WikilinkWidget): boolean {
    return other.target === this.target
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-wikilink'
    el.textContent = this.target
    el.dataset.target = this.target
    if (this.onOpen) {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.onOpen?.(this.target)
      })
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly url: string,
    readonly onOpenUrl?: OpenUrl
  ) {
    super()
  }
  eq(other: LinkWidget): boolean {
    return other.label === this.label && other.url === this.url
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-md-link'
    el.textContent = this.label
    el.title = this.url
    if (this.onOpenUrl) {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.onOpenUrl?.(this.url)
      })
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

const HIDE = Decoration.replace({})
const MARK_BOLD = Decoration.mark({ class: 'cm-md-bold' })
const MARK_ITALIC = Decoration.mark({ class: 'cm-md-italic' })
const MARK_CODE = Decoration.mark({ class: 'cm-md-code' })
const MARK_CODEBLOCK = Decoration.mark({ class: 'cm-code-block' })
const headingMarks: Record<number, Decoration> = {}
function headingMark(level: number): Decoration {
  return (headingMarks[level] ??= Decoration.mark({ class: `cm-md-h${level}` }))
}

function spanToDecoration(s: DecoSpan, onOpen?: OpenLink, onOpenUrl?: OpenUrl): Decoration {
  switch (s.kind) {
    case 'pill':
      return Decoration.replace({ widget: new WikilinkWidget(s.target ?? '', onOpen) })
    case 'link':
      return Decoration.replace({ widget: new LinkWidget(s.label ?? '', s.target ?? '', onOpenUrl) })
    case 'hide':
      return HIDE
    case 'bold':
      return MARK_BOLD
    case 'italic':
      return MARK_ITALIC
    case 'code':
      return MARK_CODE
    case 'codeblock':
      return MARK_CODEBLOCK
    case 'heading':
      return headingMark(s.level ?? 1)
  }
}

const ATOMIC: ReadonlySet<SpanKind> = new Set<SpanKind>(['pill', 'link', 'hide'])

interface Built {
  decorations: DecorationSet
  atomic: DecorationSet
}

function build(view: EditorView, onOpen?: OpenLink, onOpenUrl?: OpenUrl, reveal = true): Built {
  const spans = computeSpans(view.state, view.visibleRanges, reveal)
  const decoBuilder = new RangeSetBuilder<Decoration>()
  const atomicBuilder = new RangeSetBuilder<Decoration>()
  for (const s of spans) {
    const deco = spanToDecoration(s, onOpen, onOpenUrl)
    decoBuilder.add(s.from, s.to, deco)
    if (ATOMIC.has(s.kind)) atomicBuilder.add(s.from, s.to, deco)
  }
  return { decorations: decoBuilder.finish(), atomic: atomicBuilder.finish() }
}

/**
 * @param reveal  when true (Live mode) the span under the selection is left raw
 *   so you edit the source in place; when false (Reading mode) markers stay
 *   hidden regardless of the cursor.
 */
export function livePreview(onOpen?: OpenLink, onOpenUrl?: OpenUrl, reveal = true): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      atomic: DecorationSet
      constructor(view: EditorView) {
        const built = build(view, onOpen, onOpenUrl, reveal)
        this.decorations = built.decorations
        this.atomic = built.atomic
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || (reveal && u.selectionSet)) {
          const built = build(u.view, onOpen, onOpenUrl, reveal)
          this.decorations = built.decorations
          this.atomic = built.atomic
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
    }
  )
}
