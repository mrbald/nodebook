import { basename } from 'path'
import { parser as markdownParser } from '@lezer/markdown'
import { WikilinkExtension } from '../../shared/markdown/wikilink'

/**
 * The harvest parser — a pure function that turns one markdown file into the
 * rows the index needs. Uses the same `@lezer/markdown` parser (plus our
 * `WikilinkExtension`) the editor uses, so the index sees exactly what you see.
 *
 * Pure and DOM-free → golden-file tested in Node. No SQLite, no fs here; the
 * indexer owns persistence.
 */

const parser = markdownParser.configure([WikilinkExtension])

export interface Triple {
  subject: string
  relation: string
  object: string
}

export interface Harvested {
  /** First H1, falling back to the file's base name. */
  title: string
  /** Full-text payload for FTS (raw content for now — FTS5 tokenizes it). */
  text: string
  triples: Triple[]
}

/** A line-level Dataview-style typed field: `key:: value` (also under `>` quotes). */
const FIELD_RE = /^[ \t>]*([A-Za-z][\w -]*?)\s*::\s*(\S.*?)\s*$/
const WIKILINK_ONLY = /^\[\[(.+)\]\]$/

/** `[[Target|Alias]]` / `[[Target#Heading]]` → `Target`. */
function cleanTarget(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim()
}

export function harvest(path: string, content: string): Harvested {
  const noteName = basename(path).replace(/\.md$/i, '')
  const tree = parser.parse(content)

  let title = ''
  const triples: Triple[] = []
  const codeRanges: Array<[number, number]> = []

  tree.iterate({
    enter: (node) => {
      if (!title && node.name === 'ATXHeading1') {
        let start = node.from
        const mark = node.node.firstChild
        if (mark && mark.name === 'HeaderMark') start = mark.to
        title = content.slice(start, node.to).trim()
      }
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        codeRanges.push([node.from, node.to])
      }
      // Wikilinks only exist as nodes outside code spans/blocks (inline parsing
      // doesn't run there), so this never picks up `[[...]]` inside a fence.
      if (node.name === 'Wikilink') {
        const target = cleanTarget(content.slice(node.from + 2, node.to - 2))
        if (target) triples.push({ subject: noteName, relation: 'links_to', object: target })
      }
      return undefined
    }
  })

  // Typed fields: our own line pass, skipping any line inside a code block.
  let offset = 0
  for (const line of content.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1 // account for the consumed '\n'
    if (codeRanges.some(([f, t]) => lineStart < t && lineEnd > f)) continue
    const m = FIELD_RE.exec(line)
    if (!m) continue
    const relation = m[1].trim()
    let object = m[2].trim()
    const asLink = WIKILINK_ONLY.exec(object)
    if (asLink) object = cleanTarget(asLink[1])
    if (object) triples.push({ subject: noteName, relation, object })
  }

  return { title: title || noteName, text: content, triples }
}
