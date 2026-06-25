/**
 * A small Fruchterman–Reingold force-directed layout — pure and deterministic
 * (nodes seed on a circle by index; no RNG), so it is golden-testable and renders
 * the same graph the same way every time. O(n²) repulsion is fine for the local
 * maps this MVP shows; a Barnes-Hut/WebGL upgrade is noted in the roadmap for the
 * global view. Edges pull connected nodes together; everything repels; a weak pull
 * to centre keeps the drawing on screen.
 */
export interface Point {
  x: number
  y: number
}

export function forceLayout(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  opts: {
    width?: number
    height?: number
    iterations?: number
    /** Initial positions to start from (stability: unchanged nodes barely move). */
    seed?: Map<string, Point>
    /** Nodes that must not move — anchors the layout (pinned landmarks). */
    fixed?: Set<string>
  } = {}
): Map<string, Point> {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const iterations = opts.iterations ?? 300
  const seed = opts.seed
  const fixed = opts.fixed ?? new Set<string>()
  const n = nodes.length
  const cx = W / 2
  const cy = H / 2

  const pos = new Map<string, Point>()
  if (n === 0) return pos
  if (n === 1) {
    const s = seed?.get(nodes[0].id)
    pos.set(nodes[0].id, s ? { x: s.x, y: s.y } : { x: cx, y: cy })
    return pos
  }
  const radius = Math.min(W, H) * 0.3
  nodes.forEach((node, i) => {
    const s = seed?.get(node.id)
    if (s) pos.set(node.id, { x: s.x, y: s.y })
    else {
      const a = (2 * Math.PI * i) / n
      pos.set(node.id, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
    }
  })

  const ids = nodes.map((node) => node.id)
  const present = new Set(ids)
  const links = edges.filter((e) => present.has(e.source) && present.has(e.target))
  const k = Math.sqrt((W * H) / n) // ideal edge length
  let temp = Math.min(W, H) * 0.1

  for (let it = 0; it < iterations; it++) {
    const disp = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]))

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(ids[i]) as Point
        const b = pos.get(ids[j]) as Point
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dist = Math.hypot(dx, dy) || 0.01
        const force = (k * k) / dist
        const ux = dx / dist
        const uy = dy / dist
        const da = disp.get(ids[i]) as Point
        const db = disp.get(ids[j]) as Point
        da.x += ux * force
        da.y += uy * force
        db.x -= ux * force
        db.y -= uy * force
      }
    }

    // Attraction along edges.
    for (const e of links) {
      const a = pos.get(e.source) as Point
      const b = pos.get(e.target) as Point
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist * dist) / k
      const ux = dx / dist
      const uy = dy / dist
      const da = disp.get(e.source) as Point
      const db = disp.get(e.target) as Point
      da.x -= ux * force
      da.y -= uy * force
      db.x += ux * force
      db.y += uy * force
    }

    // Apply, bounded by the cooling temperature, with a weak pull to centre.
    // Fixed nodes are anchors — they exert force on others but never move.
    for (const id of ids) {
      if (fixed.has(id)) continue
      const d = disp.get(id) as Point
      const p = pos.get(id) as Point
      const len = Math.hypot(d.x, d.y) || 0.01
      p.x += (d.x / len) * Math.min(len, temp)
      p.y += (d.y / len) * Math.min(len, temp)
      p.x += (cx - p.x) * 0.01
      p.y += (cy - p.y) * 0.01
    }
    temp *= 0.97
  }
  return pos
}
