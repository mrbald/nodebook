import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { computeSpans } from './livePreview'
import { WikilinkExtension } from '@shared/markdown/wikilink'

function spansFor(doc: string, cursor = 0, reveal = true) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ extensions: [GFM, WikilinkExtension] })]
  })
  // Force a full parse so syntaxTree() is complete outside a live view.
  ensureSyntaxTree(state, doc.length, 5000)
  return computeSpans(state, [{ from: 0, to: doc.length }], reveal)
}

describe('computeSpans', () => {
  it('turns a wikilink into a pill carrying its target', () => {
    const spans = spansFor('see [[Graph Model]] ok', 0)
    const pill = spans.find((s) => s.kind === 'pill')
    expect(pill).toBeTruthy()
    expect(pill!.target).toBe('Graph Model')
  })

  it('hides bold markers and styles the inner content when the cursor is away', () => {
    const spans = spansFor('a **bold** b', 0)
    expect(spans.filter((s) => s.kind === 'hide')).toHaveLength(2)
    expect(spans.some((s) => s.kind === 'bold')).toBe(true)
  })

  it('reveals raw markdown (no spans) when the cursor is inside the span', () => {
    const doc = 'a **bold** b'
    const spans = spansFor(doc, doc.indexOf('bold') + 1)
    expect(spans).toHaveLength(0)
  })

  it('does not treat `**` inside inline code as emphasis', () => {
    const spans = spansFor('x `**no**` y', 0)
    expect(spans.some((s) => s.kind === 'code')).toBe(true)
    expect(spans.some((s) => s.kind === 'bold')).toBe(false)
  })

  it('styles headings with their level, regardless of cursor', () => {
    const spans = spansFor('# Title', 0)
    const heading = spans.find((s) => s.kind === 'heading')
    expect(heading?.level).toBe(1)
  })

  it('keeps the heading `#` visible in Live mode (reveal=true)', () => {
    // No hide span over the marker; the heading style spans the whole line.
    const spans = spansFor('# Title', 0, true)
    expect(spans.some((s) => s.kind === 'hide')).toBe(false)
    const heading = spans.find((s) => s.kind === 'heading')
    expect(heading?.from).toBe(0) // includes the `# `
  })

  it('hides the heading `#` marker in Reading mode (reveal=false)', () => {
    const spans = spansFor('# Title', 0, false)
    const hide = spans.find((s) => s.kind === 'hide')
    expect(hide).toBeTruthy()
    expect(hide!.from).toBe(0)
    expect(hide!.to).toBe(2) // `# ` (hash + space) is replaced away
    const heading = spans.find((s) => s.kind === 'heading')
    expect(heading?.from).toBe(2) // styling starts at the content
  })

  it('reading mode hides emphasis/wikilink markers without needing the cursor away', () => {
    const spans = spansFor('a **bold** [[X]]', 5, false) // cursor inside, but no reveal
    expect(spans.some((s) => s.kind === 'bold')).toBe(true)
    expect(spans.some((s) => s.kind === 'pill')).toBe(true)
  })

  it('turns a markdown link into a clickable link span (label + url)', () => {
    const spans = spansFor('see [docs](https://example.com) end', 0)
    const link = spans.find((s) => s.kind === 'link')
    expect(link?.label).toBe('docs')
    expect(link?.target).toBe('https://example.com')
  })

  it('marks fenced code blocks for monospace and never as emphasis', () => {
    const doc = '```\n**not bold** text\n```'
    const spans = spansFor(doc)
    expect(spans.some((s) => s.kind === 'codeblock')).toBe(true)
    expect(spans.some((s) => s.kind === 'bold')).toBe(false)
  })

  it('Live mode keeps the ``` fences visible (no hide spans)', () => {
    const spans = spansFor('```js\nconst x = 1\n```', 0, true)
    expect(spans.some((s) => s.kind === 'hide')).toBe(false)
    expect(spans.some((s) => s.kind === 'codeblock')).toBe(true)
  })

  it('Reading mode collapses the ``` fence lines and styles the body', () => {
    const doc = '```js\nconst x = 1\n```'
    const spans = spansFor(doc, 0, false)
    const fences = spans.filter((s) => s.kind === 'fenceline')
    expect(fences.length).toBe(2) // opening + closing fence lines (line decorations)
    expect(fences[0].from).toBe(0) // opening line start
    expect(fences[0].from).toBe(fences[0].to) // zero-width line decoration
    expect(spans.some((s) => s.kind === 'codeblock')).toBe(true) // body styled
    // No line-break-spanning replace (that would crash CM6).
    expect(spans.some((s) => s.kind === 'hide')).toBe(false)
  })
})
