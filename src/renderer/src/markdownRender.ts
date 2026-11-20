import { parseFigurePath } from '@shared/figures'
import { figureUrl } from '@shared/figureUrl'
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

// A linked picture opens the local figure viewer. Suppress the enclosing
// hyperlink as well as its keyboard target when rendering that picture alone.
md.core.ruler.after('inline', 'managed-figure-links', (state) => {
  if (!state.env?.figureScope) return
  for (const block of state.tokens) {
    const children = block.children ?? []
    for (let i = 1; i + 1 < children.length; i++) {
      const image = children[i]
      if (image.type !== 'image' || children[i - 1].type !== 'link_open' || children[i + 1].type !== 'link_close') continue
      if (parseFigurePath(String(image.attrGet('src') ?? ''))) {
        children[i - 1].hidden = true
        children[i + 1].hidden = true
      }
    }
  }
})

const renderImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const scope = env?.figureScope as { path: string; runId?: string; print?: boolean } | undefined
  const src = String(token.attrGet('src') ?? '')
  // Author Markdown uses relative links. Only the current reader supplies
  // the scoped application URL used to display them.
  if (/^nodebook-figure:/i.test(src)) return md.utils.escapeHtml(token.content)
  const figure = parseFigurePath(src)
  if (scope && figure) {
    token.attrSet('src', figureUrl(scope.path, figure.id, scope.runId))
    if (!scope.print) {
      const counts = env?.figureCounts as Map<string, number>
      const occurrence = counts.get(figure.id) ?? 0
      counts.set(figure.id, occurrence + 1)
      token.attrSet('data-figure-id', figure.id)
      token.attrSet('data-occurrence', String(occurrence))
      token.attrSet('role', 'button')
      token.attrSet('tabindex', '0')
      token.attrSet('loading', 'lazy')
    }
  }
  return renderImage(tokens, index, options, env, self)
}

export function renderMarkdown(content: string, figureScope?: { path: string; runId?: string; print?: boolean }): string {
  return md.render(content, { figureScope, figureCounts: new Map<string, number>() })
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
