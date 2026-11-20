import type { ElkLayout, NodeSize } from './elkLayout'
import type { Point } from './layout'

// Reserve some vertical room for broad maps after the camera fits their width.
// Keep small maps and already well-proportioned layouts at their natural spacing.
function addedHeight(count: number, width: number, height: number, viewport: NodeSize): number {
  if (count < 24 || height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 0
  const target = width * 0.56 * Math.min(1, viewport.height / viewport.width)
  return Math.min(5 * height, Math.max(0, target - height))
}

export function spaceTreeRanks(positions: Map<string, Point>, viewport: NodeSize): Map<string, Point> {
  const points = [...positions.values()]
  const left = Math.min(...points.map(({ x }) => x))
  const right = Math.max(...points.map(({ x }) => x))
  const top = Math.min(...points.map(({ y }) => y))
  const bottom = Math.max(...points.map(({ y }) => y))
  const height = bottom - top
  const extra = addedHeight(points.length, right - left, height, viewport)
  if (!extra) return positions

  const centre = (top + bottom) / 2
  const scale = 1 + extra / height
  return new Map([...positions].map(([id, { x, y }]) => [id, { x, y: centre + (y - centre) * scale }]))
}

export function spaceRoutedLayers(
  layout: ElkLayout, sizes: ReadonlyMap<string, NodeSize>, viewport: NodeSize
): ElkLayout {
  if (layout.centres.size < 24) return layout
  let left = Infinity
  let right = -Infinity
  const bands: { top: number; bottom: number }[] = []
  for (const [id, { x, y }] of layout.centres) {
    const size = sizes.get(id)!
    const rx = size.width * layout.scale / 2
    const ry = size.height * layout.scale / 2
    left = Math.min(left, x - rx)
    right = Math.max(right, x + rx)
    bands.push({ top: y - ry, bottom: y + ry })
  }
  bands.sort((a, b) => a.top - b.top)
  let bottom = bands[0].bottom
  const gaps: { top: number; height: number }[] = []
  for (const band of bands.slice(1)) {
    if (band.top > bottom) gaps.push({ top: bottom, height: band.top - bottom })
    bottom = Math.max(bottom, band.bottom)
  }

  const height = bottom - bands[0].top
  const extra = addedHeight(layout.centres.size, right - left, height, viewport)
  const freeHeight = gaps.reduce((sum, gap) => sum + gap.height, 0)
  if (!extra || !freeHeight) return layout
  const growth = Math.min(extra / freeHeight, 11)

  // Only stretch ranges unoccupied by cards. Using the same monotone Y map
  // for route points keeps every attachment on its card and every turn orthogonal.
  const expand = ({ x, y }: Point): Point => {
    let offset = -freeHeight * growth / 2
    for (const gap of gaps) {
      if (y <= gap.top) break
      offset += Math.min(gap.height, y - gap.top) * growth
    }
    return { x, y: y + offset }
  }
  return {
    scale: layout.scale,
    centres: new Map([...layout.centres].map(([id, point]) => [id, expand(point)])),
    routes: new Map([...layout.routes].map(([key, sections]) => [key, sections.map((points) => points.map(expand))]))
  }
}
