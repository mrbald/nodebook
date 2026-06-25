import type { Point } from './layout'
import { minCutBisect } from './structure'

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Recursive minimum-cut bisection layout ("blocks"): repeatedly split a region
 * into two parts, partitioning its notes so the FEWEST links cross the divide
 * (Kernighan–Lin balanced min-cut — see `minCutBisect` in structure.ts), and
 * recurse into each part **along the region's longer side** so tightly-linked
 * clusters tile the canvas as nested rectangular blocks. Each node lands at the
 * centre of its own leaf cell. Pure + deterministic (the bisection is
 * deterministic and placement is purely geometric), so it is golden-testable and
 * draws the same graph the same way every time.
 */
export function blocksLayout(
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

  const recurse = (ids: string[], r: Rect): void => {
    if (ids.length === 0) return
    if (ids.length === 1) {
      pos.set(ids[0], { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })
      return
    }
    const [a, b] = minCutBisect(ids, edges)
    const frac = a.length / ids.length // split the canvas in proportion to counts
    if (r.x1 - r.x0 >= r.y1 - r.y0) {
      // Wider than tall → vertical cut (left / right).
      const mid = r.x0 + (r.x1 - r.x0) * frac
      recurse(a, { x0: r.x0, y0: r.y0, x1: mid, y1: r.y1 })
      recurse(b, { x0: mid, y0: r.y0, x1: r.x1, y1: r.y1 })
    } else {
      // Taller than wide → horizontal cut (top / bottom).
      const mid = r.y0 + (r.y1 - r.y0) * frac
      recurse(a, { x0: r.x0, y0: r.y0, x1: r.x1, y1: mid })
      recurse(b, { x0: r.x0, y0: mid, x1: r.x1, y1: r.y1 })
    }
  }

  recurse(
    nodes.map((d) => d.id),
    { x0: 0, y0: 0, x1: W, y1: H }
  )
  return pos
}
