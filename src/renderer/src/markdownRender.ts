import MarkdownIt from 'markdown-it'
import type { StateInline } from 'markdown-it/index.js'

function wikilink(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src
    const start = state.pos
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false
    const end = src.indexOf(']]', start + 2)
    if (end < 0) return false
    const inner = src.slice(start + 2, end)
    if (!inner || inner.includes('[')) return false
    if (!silent) {
      const target = inner.split('|')[0].split('#')[0].trim()
      const display = inner.includes('|') ? inner.split('|')[1].trim() : inner.split('#')[0].trim()
      const open = state.push('link_open', 'a', 1)
      open.attrSet('class', 'wikilink')
      open.attrSet('data-target', target)
      const txt = state.push('text', '', 0)
      txt.content = display
      state.push('link_close', 'a', -1)
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
