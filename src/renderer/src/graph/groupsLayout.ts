import type { Point } from './layout'
import { community } from './structure'

/**
 * A community-region layout (a pragmatic, "min-cut-flavoured" engine): partition
 * the graph into communities (the same deterministic label-propagation used for
 * colour), and give each community its own region on a ring. Weakly-connected groups end up
 * in separate areas — the structure you can't see in a force hairball. Pure and
 * deterministic (community ids + sorted node ids + index-based angles), so it is
 * golden-testable.
 */
export function groupsLayout(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  opts: { width?: number; height?: number } = {}
): Map<string, Point> {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const cx = W / 2
  const cy = H / 2
  const pos = new Map<string, Point>()
  const n = nodes.length
  if (n === 0) return pos
  if (n === 1) {
    pos.set(nodes[0].id, { x: cx, y: cy })
    return pos
  }

  const comm = community(nodes, edges)
  // Group node ids by community (ids sorted so placement is deterministic).
  const groups = new Map<number, string[]>()
  for (const id of nodes.map((d) => d.id).sort()) {
    const c = comm.get(id) ?? 0
    const g = groups.get(c)
    if (g) g.push(id)
    else groups.set(c, [id])
  }
  // Larger groups first; ties broken by community id — stable, no RNG.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
  const k = ordered.length

  const ringR = Math.min(W, H) * 0.32
  // Allocate more of the circumference to groups that need a larger area.
  // Each disk fits within its own angular sector, even for unequal neighbours.
  const totalWeight = ordered.reduce((sum, [, ids]) => sum + Math.sqrt(ids.length), 0)
  const firstSector = 2 * Math.PI * Math.sqrt(ordered[0][1].length) / totalWeight
  let angle = -Math.PI / 2 - firstSector / 2
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  ordered.forEach(([, ids]) => {
    const sector = 2 * Math.PI * Math.sqrt(ids.length) / totalWeight
    const a0 = angle + sector / 2
    angle += sector
    const gcx = k === 1 ? cx : cx + Math.cos(a0) * ringR
    const gcy = k === 1 ? cy : cy + Math.sin(a0) * ringR
    const m = ids.length
    if (m === 1) {
      pos.set(ids[0], { x: gcx, y: gcy })
      return
    }
    const maxLocal = k === 1 ? Math.min(W, H) * 0.38 : 0.8 * ringR * Math.sin(Math.min(Math.PI, sector) / 2)
    const localR = Math.min(maxLocal, Math.min(W, H) * 0.05 * Math.sqrt(m))
    ids.forEach((id, j) => {
      // A few notes read well as a ring. Use the interior of a larger group
      // so every additional member doesn't squeeze two neighbours together.
      const a = (m <= 8 ? 2 * Math.PI * j / m : j * goldenAngle) - Math.PI / 2
      const r = m <= 8 ? localR : localR * Math.sqrt((j + 0.5) / m)
      pos.set(id, { x: gcx + Math.cos(a) * r, y: gcy + Math.sin(a) * r })
    })
  })
  return pos
}
