import type { Point } from './layout'
import { community } from './structure'

/**
 * A community-region layout (a pragmatic, "min-cut-flavoured" engine): partition
 * the graph into communities (the same deterministic label-propagation used for
 * colour), give each community its own region on a ring, and ring each
 * community's notes around that region's centre. Weakly-connected groups end up
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
  // Keep a group's local radius small enough that adjacent regions don't collide.
  const maxLocal = k > 1 ? 0.8 * ringR * Math.sin(Math.PI / k) : Math.min(W, H) * 0.38

  ordered.forEach(([, ids], gi) => {
    const a0 = (2 * Math.PI * gi) / k - Math.PI / 2
    const gcx = k === 1 ? cx : cx + Math.cos(a0) * ringR
    const gcy = k === 1 ? cy : cy + Math.sin(a0) * ringR
    const m = ids.length
    if (m === 1) {
      pos.set(ids[0], { x: gcx, y: gcy })
      return
    }
    const localR = Math.min(maxLocal, Math.min(W, H) * 0.05 * Math.sqrt(m))
    ids.forEach((id, j) => {
      const a = (2 * Math.PI * j) / m - Math.PI / 2
      pos.set(id, { x: gcx + Math.cos(a) * localR, y: gcy + Math.sin(a) * localR })
    })
  })
  return pos
}
