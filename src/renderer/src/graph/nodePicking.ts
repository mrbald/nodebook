import type { Point } from './layout'
import { MAP_HIT_RADIUS } from './mapPresentation'

interface Extent {
  width: number
  height: number
}

interface NodeTarget {
  id: string
  center: Point
  /** The actual routed card half-size, smaller than its padded hit area at overview zoom. */
  card?: { halfWidth: number; halfHeight: number }
}

/** Find the closest eligible node without letting a neighboring hit area cover its center. */
export function nodePicker(nodes: NodeTarget[], viewport: Extent): (point: Point) => string | undefined {
  const cellSize = 32
  const cell = (coordinate: number): number => Math.floor(coordinate / cellSize)
  const columns = cell(viewport.width) + 1
  const rows = cell(viewport.height) + 1
  const cells = new Map<number, NodeTarget[]>()
  for (const node of nodes) {
    const { center, card } = node
    const rx = Math.max(MAP_HIT_RADIUS, card?.halfWidth ?? 0)
    const ry = Math.max(MAP_HIT_RADIUS, card?.halfHeight ?? 0)
    const right = Math.min(columns - 1, cell(center.x + rx))
    const bottom = Math.min(rows - 1, cell(center.y + ry))
    for (let y = Math.max(0, cell(center.y - ry)); y <= bottom; y++) {
      for (let x = Math.max(0, cell(center.x - rx)); x <= right; x++) {
        const key = y * columns + x
        const neighbors = cells.get(key)
        if (neighbors) neighbors.push(node)
        else cells.set(key, [node])
      }
    }
  }

  return (point) => {
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) return
    const candidates = cells.get(cell(point.y) * columns + cell(point.x))
    let winner: string | undefined
    let best = Infinity
    let bestOnCard = false
    for (const { id, center, card } of candidates ?? []) {
      const dx = Math.abs(point.x - center.x)
      const dy = Math.abs(point.y - center.y)
      const squaredDistance = dx * dx + dy * dy
      const onCard = !!card && dx <= card.halfWidth && dy <= card.halfHeight
      const inHitArea = card
        ? dx <= Math.max(MAP_HIT_RADIUS, card.halfWidth) && dy <= Math.max(MAP_HIT_RADIUS, card.halfHeight)
        : squaredDistance <= MAP_HIT_RADIUS * MAP_HIT_RADIUS
      if (!inHitArea || (bestOnCard && !onCard)) continue
      if ((!bestOnCard && onCard) || squaredDistance <= best) {
        winner = id
        best = squaredDistance
        bestOnCard = onCard
      }
    }
    return winner
  }
}
