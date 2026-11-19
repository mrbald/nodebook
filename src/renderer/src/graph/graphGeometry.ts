import type { GraphEdge } from '@shared/types'
import type { NodeSize } from './elkLayout'
import { edgeKey } from './elkLayout'
import type { Point } from './layout'

export const LABEL_FONT_SIZE = 14
export const LABEL_LINE_HEIGHT = 16

export interface NodeLabel extends NodeSize {
  lines: string[]
}

export function measureNodeLabel(ctx: CanvasRenderingContext2D, title: string): NodeLabel {
  const max = 152
  const characters = Array.from(title)
  const widthOf = (text: string): number => ctx.measureText(text).width
  const lines: string[] = []
  for (let offset = 0; offset < characters.length && lines.length < 2; ) {
    const lastLine = lines.length === 1
    let end = offset
    let space = offset
    while (end < characters.length) {
      const next = end + 1
      const suffix = lastLine && next < characters.length ? '…' : ''
      if (widthOf(characters.slice(offset, next).join('') + suffix) > max) break
      if (/\s/.test(characters[end])) space = end
      end = next
    }
    if (end < characters.length && space > offset) end = space
    if (end === offset) end++
    lines.push(characters.slice(offset, end).join('').trimEnd() +
      (lastLine && end < characters.length ? '…' : ''))
    offset = end
    while (offset < characters.length && /\s/.test(characters[offset])) offset++
  }
  return {
    lines,
    width: Math.max(44, Math.ceil(Math.max(0, ...lines.map(widthOf))) + 36),
    height: Math.max(30, lines.length * LABEL_LINE_HEIGHT + 14)
  }
}

export function sectionPath(sections: Point[][]): string {
  return sections.map((points) =>
    points.map(({ x, y }, i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  ).join(' ')
}

/** Keep typed and reciprocal links separate when manual placement replaces automatic routes. */
export function edgeLanes(edges: GraphEdge[]): Map<string, number> {
  const pairs = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const key = JSON.stringify([edge.source, edge.target].sort())
    const group = pairs.get(key) ?? []
    group.push(edge)
    pairs.set(key, group)
  }
  const lanes = new Map<string, number>()
  for (const group of pairs.values()) {
    group.forEach((edge, i) => {
      const sign = edge.source <= edge.target ? 1 : -1
      lanes.set(edgeKey(edge), sign * (i - (group.length - 1) / 2))
    })
  }
  return lanes
}

function boxPort(centre: Point, toward: Point, size: NodeSize, scale: number): Point {
  const dx = toward.x - centre.x
  const dy = toward.y - centre.y
  const distance = Math.max(Math.abs(dx) / size.width, Math.abs(dy) / size.height)
  if (distance === 0) return centre
  const fraction = scale / (2 * distance)
  return { x: centre.x + dx * fraction, y: centre.y + dy * fraction }
}

/** A temporary connector between the actual node borders after dragging or pinning. */
export function manualEdgePath(
  a: Point, b: Point, from: NodeSize, to: NodeSize, scale: number, lane: number
): string {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const distance = Math.hypot(dx, dy)
  if (distance < 0.001) {
    const start = { x: a.x + from.width * scale / 2, y: a.y + from.height * scale / 4 }
    const end = { x: b.x + to.width * scale / 2, y: b.y - to.height * scale / 4 }
    const bendX = Math.max(start.x, end.x) + Math.max(8, 16 + lane * 5) * scale
    return `M${start.x} ${start.y} C${bendX} ${start.y} ${bendX} ${end.y} ${end.x} ${end.y}`
  }
  const offset = lane * 14 * scale / distance
  const middle = { x: (a.x + b.x) / 2 - dy * offset, y: (a.y + b.y) / 2 + dx * offset }
  const start = boxPort(a, middle, from, scale)
  const end = boxPort(b, middle, to, scale)
  return `M${start.x} ${start.y} Q${middle.x} ${middle.y} ${end.x} ${end.y}`
}
