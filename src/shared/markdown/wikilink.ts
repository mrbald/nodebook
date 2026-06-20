import type { MarkdownConfig } from '@lezer/markdown'

const OPEN = 91 // '['
const CLOSE = 93 // ']'

/**
 * Teaches the markdown parser about `[[Target]]` so wikilinks become real
 * syntax-tree nodes (`Wikilink`). Shared between the editor (live-preview
 * decorations) and the main-process harvest module (link extraction) so both
 * see the document the same way. Runs before the standard `Link` parser so a
 * lone `[` still parses as a normal link.
 */
export const WikilinkExtension: MarkdownConfig = {
  defineNodes: [{ name: 'Wikilink' }],
  parseInline: [
    {
      name: 'Wikilink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1
        for (let p = pos + 2; p < cx.end - 1; p++) {
          const c = cx.char(p)
          if (c === OPEN) return -1 // bail on a nested '['
          if (c === CLOSE && cx.char(p + 1) === CLOSE) {
            if (p === pos + 2) return -1 // reject empty [[]]
            return cx.addElement(cx.elt('Wikilink', pos, p + 2))
          }
        }
        return -1
      }
    }
  ]
}
