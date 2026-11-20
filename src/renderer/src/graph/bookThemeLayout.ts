import type { BookOverview } from '@shared/types'
import { forceLayout, type Point } from './layout'

export interface Size {
  width: number
  height: number
}

type Label = Size & Point

const MARGIN = 16
const GAP = 14

function projection(values: number[]): (value: number) => number {
  const min = Math.min(...values)
  const span = Math.max(...values) - min
  return (value) => span > 0 ? (value - min) / span : 0.5
}

function fitLabels(
  anchors: Map<string, Point>,
  sizes: Map<string, Size>,
  width: number,
  height: number
): Map<string, Label> | null {
  const placed = new Map<string, Label>()
  const xRatio = projection([...anchors.values()].map((point) => point.x))
  const yRatio = projection([...anchors.values()].map((point) => point.y))
  const labels = [...sizes].sort(([, a], [, b]) => b.height - a.height || b.width - a.width)
  for (const [id, size] of labels) {
    const anchor = anchors.get(id)!
    const maxX = width - MARGIN - size.width
    const maxY = height - MARGIN - size.height
    const x = MARGIN + xRatio(anchor.x) * (maxX - MARGIN)
    const y = MARGIN + yRatio(anchor.y) * (maxY - MARGIN)
    const columns = [x, MARGIN, maxX]
    const rows = [y, MARGIN, maxY]
    const blockers = [...placed.values()]
    for (const other of blockers) {
      columns.push(other.x - GAP - size.width, other.x + other.width + GAP)
      rows.push(other.y - GAP - size.height, other.y + other.height + GAP)
    }
    let best: Label | undefined
    let distance = Infinity
    // The closest free position is at the preferred point, a boundary, or on
    // the edge of a label that blocks it. Try those coordinates in both axes.
    for (const px of columns) {
      if (px < MARGIN || px > maxX) continue
      for (const py of rows) {
        if (py < MARGIN || py > maxY) continue
        const delta = (px - x) ** 2 + (py - y) ** 2
        if (delta >= distance) continue
        const collides = blockers.some((other) =>
          px < other.x + other.width + GAP && px + size.width + GAP > other.x &&
          py < other.y + other.height + GAP && py + size.height + GAP > other.y
        )
        if (collides) continue
        best = { ...size, x: px, y: py }
        distance = delta
      }
    }
    if (!best) return null
    placed.set(id, best)
  }
  return placed
}

export function bookThemeAnchors(overview: BookOverview): Map<string, Point> {
  return forceLayout(overview.themes, overview.links.filter((link) => link.strong))
}

export function bookThemeLayout(
  anchors: Map<string, Point>,
  sizes: Map<string, Size>,
  viewport: Size
): { width: number; height: number; labels: Map<string, Label> } {
  const width = Math.max(viewport.width, ...[...sizes.values()].map((size) => size.width + 2 * MARGIN))
  const free = fitLabels(anchors, sizes, width, viewport.height)
  if (free) return { width, height: viewport.height, labels: free }

  // On compact panes the unconstrained placement can strand gaps between
  // labels. Pack rows in Force's north-to-south order and keep west-to-east
  // order within each row. Add vertical room only when the titles need it.
  const compactGap = 8
  const widest = Math.max(1, ...[...sizes.values()].map((size) => size.width))
  const columns = Math.max(1, Math.floor((width - 2 * MARGIN + compactGap) / (widest + compactGap)))
  const slot = (width - 2 * MARGIN + compactGap) / columns
  const ordered = [...sizes.keys()].sort((a, b) => anchors.get(a)!.y - anchors.get(b)!.y)
  const labels = new Map<string, Label>()
  let top = MARGIN
  for (let i = 0; i < ordered.length; i += columns) {
    const row = ordered.slice(i, i + columns).sort((a, b) => anchors.get(a)!.x - anchors.get(b)!.x)
    const rowHeight = Math.max(...row.map((id) => sizes.get(id)!.height))
    row.forEach((id, column) => {
      const size = sizes.get(id)!
      const x = MARGIN + column * slot + (slot - compactGap - size.width) / 2
      labels.set(id, { ...size, x, y: top + (rowHeight - size.height) / 2 })
    })
    top += rowHeight + compactGap
  }
  const used = top - compactGap + MARGIN
  const height = Math.max(viewport.height, used)
  for (const label of labels.values()) label.y += (height - used) / 2
  return { width, height, labels }
}
