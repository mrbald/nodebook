import MarkdownIt from 'markdown-it'
// markdown-it 15 exports the instance as a TYPE named like the default export
// (a callable), so the type is imported under its own name.
import type { MarkdownIt as MarkdownItInstance, StateInline } from 'markdown-it'
import type { Citation } from '@shared/types'

interface AnswerContext {
  passages: Map<string, Citation>
  cited: Set<string>
}

function wikilink(md: MarkdownItInstance): void {
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src
    const start = state.pos
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false
    const end = src.indexOf(']]', start + 2)
    if (end < 0) return false
    const inner = src.slice(start + 2, end)
    if (!inner || inner.includes('[')) return false
    if (!silent) {
      const answer = (state.env as { answer?: AnswerContext } | undefined)?.answer
      const target = answer ? inner.trim() : inner.split('|')[0].split('#')[0].trim()
      const display = inner.includes('|') ? inner.split('|')[1].trim() : inner.split('#')[0].trim()
      const citation = answer?.passages.get(target)
      if (!answer || citation) {
        const open = state.push('link_open', 'a', 1)
        open.attrSet('class', citation ? 'wikilink ask-citation' : 'wikilink')
        open.attrSet('data-target', target)
        if (citation) {
          open.attrSet('href', '#')
          answer?.cited.add(target)
        }
      }
      const txt = state.push('text', '', 0)
      txt.content = citation?.title ?? display
      if (!answer || citation) state.push('link_close', 'a', -1)
    }
    state.pos = end + 2
    return true
  })
}

// `html: false` blocks raw-HTML injection, so the rendered string is safe to
// drop into the DOM. On-screen reading is done by CodeMirror's Reading mode;
// this fully-rendered HTML is used only for Print / Export-PDF, where CM can't
// help (it virtualizes off-screen lines and would print only what's visible).
const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
md.use(wikilink)

export function renderMarkdown(content: string): string {
  return md.render(content)
}

export function renderAskMarkdown(content: string, citations: Citation[]): {
  html: string
  cited: Set<string>
} {
  const answer: AnswerContext = {
    passages: new Map(citations.map((c) => [c.id, c])),
    cited: new Set()
  }
  const html = md.render(content, { answer })
  return { html, cited: answer.cited }
}
