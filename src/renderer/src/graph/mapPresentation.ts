import type { Point } from './layout'

export interface MapView extends Point {
  k: number
}

export const MAP_LABEL_FONT = 12
export const MAP_LABEL_LINE = 16
export const MAP_HIT_RADIUS = 11

export function mapGlyphRadius(relativeRank: number, theme: boolean): number {
  const dot = 2.2 + Math.sqrt(relativeRank) * 2.94
  return theme ? Math.max(4, dot + 0.5) : dot
}

export function fitMapView(
  points: Iterable<Point>, width: number, height: number, maxScale = Infinity
): MapView {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const { x, y } of points) {
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  if (left === Infinity) return { x: 0, y: 0, k: 1 }
  const margin = Math.min(34, width / 4, height / 4)
  const span = Math.max(right - left, bottom - top)
  const k = span === 0 ? Math.min(1, maxScale) : Math.min(
    maxScale,
    (width - 2 * margin) / Math.max(1, right - left),
    (height - 2 * margin) / Math.max(1, bottom - top)
  )
  return { x: width / 2 - (left + right) * k / 2, y: height / 2 - (top + bottom) * k / 2, k }
}

interface Rect extends Point {
  width: number
  height: number
}

export interface MapTitle {
  id: string
  title: string
  width: number
}

export interface MapMarker extends Point {
  halfWidth: number
  halfHeight: number
}

interface PlacedTitle extends Rect {
  id: string
  lines: string[]
  active: boolean
}

// Only near neighbours can collide. The grid is rebuilt in screen space so
// placing labels during pan and zoom doesn't compare every title to every node.
class LabelGrid {
  private cells = new Map<number, Rect[]>()
  private readonly columns: number
  private readonly size = 40

  constructor(width: number) {
    this.columns = Math.ceil(width / this.size) + 2
  }

  private *keys(rect: Rect): Iterable<number> {
    for (let y = Math.floor(rect.y / this.size); y <= Math.floor((rect.y + rect.height) / this.size); y++) {
      for (let x = Math.floor(rect.x / this.size); x <= Math.floor((rect.x + rect.width) / this.size); x++) {
        yield y * this.columns + x
      }
    }
  }

  add(rect: Rect): void {
    for (const key of this.keys(rect)) {
      const cell = this.cells.get(key)
      if (cell) cell.push(rect)
      else this.cells.set(key, [rect])
    }
  }

  overlaps(rect: Rect): boolean {
    for (const key of this.keys(rect)) {
      if (this.cells.get(key)?.some((other) =>
        other.x < rect.x + rect.width && other.x + other.width > rect.x &&
        other.y < rect.y + rect.height && other.y + other.height > rect.y
      )) return true
    }
    return false
  }
}

function wrapTitle(title: string, max: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of title.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (measure(next) <= max) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = ''
    for (const char of word) {
      if (line && measure(line + char) > max) {
        lines.push(line)
        line = ''
      }
      line += char
    }
  }
  if (line) lines.push(line)
  return lines
}

/** `titles` is ordered by map focus, theme and centrality. Interactive titles go first. */
export function placeMapTitles(
  titles: MapTitle[],
  active: Set<string>,
  position: (id: string) => MapMarker | undefined,
  width: number,
  height: number,
  zoom: number,
  measure: (text: string) => number
): PlacedTitle[] {
  const markers = new LabelGrid(width)
  const labels = new LabelGrid(width)
  const screen = titles.flatMap((title) => {
    const p = position(title.id)
    if (!p || p.x < 0 || p.x > width || p.y < 0 || p.y > height) return []
    const rx = p.halfWidth + 1.5 // Includes the drawn outline.
    const ry = p.halfHeight + 1.5
    markers.add({ x: p.x - rx, y: p.y - ry, width: 2 * rx, height: 2 * ry })
    return [{ ...title, p, spot: `${p.x},${p.y}` }]
  })
  const byId = new Map(screen.map((title) => [title.id, title]))
  const placed: PlacedTitle[] = []
  const padding = 6
  const maxWidth = width - padding * 2
  const add = ({ id, title, width: titleWidth, p }: typeof screen[number], emphasize: boolean): boolean => {
    if (maxWidth <= padding * 2 || (!emphasize && titleWidth > Math.min(maxWidth - padding * 2, 240 * Math.max(1, zoom)))) return false
    const wrap = titleWidth + padding * 2 > maxWidth
    const lines = wrap ? wrapTitle(title, maxWidth - padding * 2, measure) : [title]
    const w = (wrap ? Math.max(...lines.map(measure)) : titleWidth) + padding * 2
    const h = lines.length * MAP_LABEL_LINE + 2
    const gapX = p.halfWidth + 3
    const gapY = p.halfHeight + 3
    const centred = Math.max(padding, Math.min(p.x - w / 2, width - padding - w))
    const options = [
      { x: centred, y: p.y + gapY },
      { x: centred, y: p.y - gapY - h },
      { x: p.x + gapX, y: p.y - h / 2 },
      { x: p.x - gapX - w, y: p.y - h / 2 }
    ]
    let chosen: Rect | undefined
    for (const { x, y } of options) {
      if (x < padding || x + w > width - padding || y < 2 || y + h > height - 2) continue
      const rect = { x, y, width: w, height: h }
      if (labels.overlaps(rect)) continue
      if (!markers.overlaps(rect)) {
        chosen = rect
        break
      }
      if (emphasize) chosen ??= rect
    }
    if (!chosen) return false
    labels.add(chosen)
    placed.push({ ...chosen, id, lines, active: emphasize })
    return true
  }
  const claimed = new Set<string>()
  for (const id of active) {
    const title = byId.get(id)
    if (title) {
      add(title, true)
      claimed.add(title.spot)
    }
  }
  const overviewBudget = Math.min(15, width * height / 38_000)
  const budget = titles.length <= 12 ? titles.length : Math.max(1, Math.floor(overviewBudget * zoom ** 2))
  for (const title of screen) {
    if (placed.length >= budget) break
    if (!claimed.has(title.spot) && add(title, false)) claimed.add(title.spot)
  }
  return placed
}
