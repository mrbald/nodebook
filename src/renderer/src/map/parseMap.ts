/**
 * Parses a `.map.md` curated map into a containment tree plus explicit edges.
 *
 * Format (the map convention):
 *   # Optional Title
 *   - [[Root]]
 *     - [[Child]]
 *       - plain label
 *   ## Edges
 *   - [[A]] relation [[B]]
 *
 * Indentation = containment (any consistent width; tabs count as two spaces).
 * The `## Edges` section holds triples, one per bullet: `[[source]] rel [[target]]`.
 *
 * Pure and DOM-free — golden-file tested. Line-based on purpose: an outline's
 * structure *is* its indentation, so a stack over indent widths is the right
 * tool, not the markdown AST.
 */

export interface MapNode {
  /** Display text with `[[ ]]` markers stripped. */
  label: string
  /** First wikilink target on the line, if any — what a click opens. */
  target?: string
  children: MapNode[]
}

export interface MapEdge {
  source: string
  relation: string
  target: string
}

export interface ParsedMap {
  title: string | null
  nodes: MapNode[]
  edges: MapEdge[]
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const EDGE = /^\s*[-*+]\s+\[\[([^\]]+?)\]\]\s+(.+?)\s+\[\[([^\]]+?)\]\]\s*$/
const WIKILINK_G = /\[\[([^\]]+?)\]\]/g
const WIKILINK = /\[\[([^\]]+?)\]\]/

/** The open destination: `Target|Alias` / `Target#Heading` → `Target`. */
function cleanTarget(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim()
}

/** The shown text: alias if present (`Target|Alias` → `Alias`), else the page. */
function displayText(inner: string): string {
  const alias = inner.split('|')[1]
  return (alias ?? inner.split('#')[0]).trim()
}

function stripWikilinks(s: string): string {
  return s.replace(WIKILINK_G, (_m, inner) => displayText(inner))
}

function firstTarget(s: string): string | undefined {
  const m = WIKILINK.exec(s)
  return m ? cleanTarget(m[1]) : undefined
}

export function parseMap(content: string): ParsedMap {
  let title: string | null = null
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []

  // Stack of open ancestors by indent width; deeper indent = child.
  const stack: Array<{ indent: number; node: MapNode }> = []
  let inEdges = false

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\t/g, '  ') // tabs → two spaces
    if (line.trim() === '') continue

    const heading = HEADING.exec(line)
    if (heading) {
      const text = heading[2].trim()
      if (title === null && heading[1].length === 1) title = stripWikilinks(text)
      inEdges = /^edges$/i.test(text)
      stack.length = 0 // a new section resets the outline scope
      continue
    }

    if (inEdges) {
      const e = EDGE.exec(line)
      if (e) {
        edges.push({
          source: cleanTarget(e[1]),
          relation: e[2].trim(),
          target: cleanTarget(e[3])
        })
      }
      continue
    }

    const bullet = BULLET.exec(line)
    if (!bullet) continue
    const indent = bullet[1].length
    const text = bullet[2].trim()
    const node: MapNode = {
      label: stripWikilinks(text),
      target: firstTarget(text),
      children: []
    }

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (stack.length === 0) nodes.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ indent, node })
  }

  return { title, nodes, edges }
}
