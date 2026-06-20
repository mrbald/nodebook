import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { highlightTree } from '@lezer/highlight'
import { WikilinkExtension } from '@shared/markdown/wikilink'
import { getTheme } from './themes'

// Resolve highlightTree's generated class names back to their colors by reading
// the HighlightStyle's injected CSS rules.
function classColors(): Record<string, string> {
  const rules = getTheme('dark').highlight.module?.getRules() ?? ''
  const map: Record<string, string> = {}
  rules.replace(/\.(\S+?)\s*\{[^}]*?color:\s*([^;}]+)/g, (_m, cls: string, col: string) => {
    map[cls.trim()] = col.trim().toLowerCase()
    return _m
  })
  return map
}

/** [text, colors] for every highlighted range in `doc`. */
function highlightsFor(doc: string): Array<[string, string[]]> {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM, WikilinkExtension] })]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  const cc = classColors()
  const out: Array<[string, string[]]> = []
  highlightTree(syntaxTree(state), getTheme('dark').highlight, (from, to, classes) => {
    out.push([doc.slice(from, to), classes.split(' ').map((c) => cc[c]).filter(Boolean)])
  })
  return out
}

// Colors that read as "error/alert" — must never land on ordinary prose.
const ALARM = new Set(['#ff5370', '#f7768e'])

describe('markdown HighlightStyle — prose stays clean', () => {
  it('never colors inline <html>, task markers, or list text red/alarm', () => {
    const doc = [
      'Prose with an <html> tag and a generic Array<T>.',
      '',
      '- a list item with plain words',
      '- [ ] a todo',
      '- [x] done'
    ].join('\n')
    const alarmed = highlightsFor(doc).filter(([, cols]) => cols.some((c) => ALARM.has(c)))
    expect(alarmed).toEqual([]) // nothing in prose/lists/tasks is alerted
  })

  it('still colors the markdown structure (heading, link)', () => {
    const hl = highlightsFor('# Title\n\nA [link](https://example.com).')
    const heading = hl.find(([txt]) => txt.includes('Title'))
    expect(heading?.[1]).toContain('#7aa2f7') // theme heading color
    const link = hl.find(([txt]) => txt === 'link')
    expect(link?.[1]).toContain('#7aa2f7') // accent
  })
})
