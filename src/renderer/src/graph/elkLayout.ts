import type { Point } from './layout'

/**
 * Layered layout via ELK (the Eclipse Layout Kernel) — a second hierarchical
 * layout beside dagre's `tree`. Both rank nodes into layers; ELK's crossing
 * minimisation and edge routing untangle a dense map more often, which is why
 * it is offered as its own mode rather than replacing tree: sometimes one
 * reads better, sometimes the other, and the switch is a click.
 *
 * ELK is asynchronous (it is GWT-compiled Java and returns a Promise), so the
 * view computes this in an effect rather than a memo. Deterministic for a given
 * input, so it is golden-testable and stable. Output is centred and shrunk to
 * fit the W×H viewport, exactly like `dagreLayout`.
 */
export async function elkLayout(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  opts: { width?: number; height?: number } = {}
): Promise<Map<string, Point>> {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const pos = new Map<string, Point>()
  const n = nodes.length
  if (n === 0) return pos
  if (n === 1) {
    pos.set(nodes[0].id, { x: W / 2, y: H / 2 })
    return pos
  }

  const present = new Set(nodes.map((x) => x.id))
  const seen = new Set<string>()
  const elkEdges: { id: string; sources: string[]; targets: string[] }[] = []
  for (const e of edges) {
    if (e.source === e.target || !present.has(e.source) || !present.has(e.target)) continue
    const key = `${e.source} ${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    elkEdges.push({ id: `e${elkEdges.length}`, sources: [e.source], targets: [e.target] })
  }
  // Loaded on first use, not at startup: the bundled kernel is ~1.4 MB and most
  // sessions never pick this layout. Vite splits it into its own chunk.
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
  const graph = await new ELK().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '45',
      'elk.layered.spacing.nodeNodeBetweenLayers': '65',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]'
    },
    children: nodes.map((node) => ({ id: node.id, width: 34, height: 34 })),
    edges: elkEdges
  })

  const centres = new Map<string, Point>()
  for (const c of graph.children ?? []) {
    if (typeof c.x !== 'number' || typeof c.y !== 'number') continue
    centres.set(c.id, { x: c.x + (c.width ?? 34) / 2, y: c.y + (c.height ?? 34) / 2 })
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const v of centres.values()) {
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
    const v = centres.get(node.id)
    if (v) pos.set(node.id, { x: W / 2 + (v.x - cx) * scale, y: H / 2 + (v.y - cy) * scale })
  }
  return pos
}
