import * as dagre from '@dagrejs/dagre'
import type { Point } from './layout'

/**
 * Hierarchical ("tree") layout via dagre — a layered, top-down arrangement that
 * reads well as a mind map when the graph has direction/hierarchy. dagre is a
 * layout-only library (no rendering): it returns node centres, which our SVG
 * island draws. Deterministic (no RNG), so it's golden-testable and stable.
 * Output is centred and shrunk to fit the W×H viewport (pan/zoom does the rest).
 */
export function dagreLayout(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  opts: { width?: number; height?: number } = {}
): Map<string, Point> {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const pos = new Map<string, Point>()
  const n = nodes.length
  if (n === 0) return pos
  if (n === 1) {
    pos.set(nodes[0].id, { x: W / 2, y: H / 2 })
    return pos
  }

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 45, ranksep: 65, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  const present = new Set(nodes.map((x) => x.id))
  for (const node of nodes) g.setNode(node.id, { width: 34, height: 34 })
  for (const e of edges) {
    if (e.source !== e.target && present.has(e.source) && present.has(e.target)) {
      g.setEdge(e.source, e.target)
    }
  }
  dagre.layout(g)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const v = g.node(node.id) as { x: number; y: number } | undefined
    if (!v) continue
    minX = Math.min(minX, v.x)
    minY = Math.min(minY, v.y)
    maxX = Math.max(maxX, v.x)
    maxY = Math.max(maxY, v.y)
  }
  const bw = maxX - minX || 1
  const bh = maxY - minY || 1
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const scale = Math.min(1, (W - 80) / bw, (H - 80) / bh) // shrink to fit, never enlarge

  for (const node of nodes) {
    const v = g.node(node.id) as { x: number; y: number } | undefined
    if (v) pos.set(node.id, { x: W / 2 + (v.x - cx) * scale, y: H / 2 + (v.y - cy) * scale })
  }
  return pos
}
