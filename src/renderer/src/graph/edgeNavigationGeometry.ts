import type { GraphEdge } from '@shared/types'
import type { MapView } from './mapPresentation'
import type { Point } from './layout'

type Segment = [Point, Point]

export type EdgeGeometry =
  | { line: Segment }
  | { path: string; sections: Point[][]; automatic: true }
  | { path: string; points: [Point, Point, Point] | [Point, Point, Point, Point] }

export interface DrawnEdge {
  edge: GraphEdge
  key: string
  geometry: EdgeGeometry
}

export interface Viewport {
  width: number
  height: number
  scale: number
  x: number
  y: number
}

export function project(point: Point, view: MapView, viewport: Viewport): Point {
  return {
    x: viewport.x + viewport.scale * (view.x + point.x * view.k),
    y: viewport.y + viewport.scale * (view.y + point.y * view.k)
  }
}

export function nearestPoint(p: Point, [a, b]: Segment): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return a
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return { x: a.x + dx * t, y: a.y + dy * t }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function adjacentSegments(points: Point[]): Segment[] {
  return points.slice(1).map((b, i) => [points[i], b])
}

/** Subdivide the painted Bézier in screen coordinates, to within half a CSS pixel. */
function subdivide(points: Point[], segments: Segment[]): void {
  const chord: Segment = [points[0], points[points.length - 1]]
  if (points.every((p) => distance(p, nearestPoint(p, chord)) <= 0.5)) {
    segments.push(chord)
    return
  }
  const left = [chord[0]]
  const right = [chord[1]]
  let level = points
  while (level.length > 1) {
    level = level.slice(1).map((b, i) => ({ x: (b.x + level[i].x) / 2, y: (b.y + level[i].y) / 2 }))
    left.push(level[0])
    right.unshift(level[level.length - 1])
  }
  subdivide(left, segments)
  subdivide(right, segments)
}

function clip([a, b]: Segment, { width, height }: Viewport): Segment | null {
  let from = 0
  let to = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  for (const [slope, room] of [[-dx, a.x], [dx, width - a.x], [-dy, a.y], [dy, height - a.y]]) {
    if (slope < 0) from = Math.max(from, room / slope)
    else if (slope > 0) to = Math.min(to, room / slope)
    else if (room < 0) return null
    if (from > to) return null
  }
  return [
    { x: a.x + dx * from, y: a.y + dy * from },
    { x: a.x + dx * to, y: a.y + dy * to }
  ]
}

export interface IncidentEdge extends DrawnEdge {
  destination: string
  segments: Segment[]
}

export function projectIncidentEdges(
  edges: DrawnEdge[], selectedId: string, view: MapView, viewport: Viewport
): IncidentEdge[] {
  const toScreen = (p: Point): Point => project(p, view, viewport)
  return edges.flatMap((drawn) => {
    const { source, target } = drawn.edge
    if (source === target || (source !== selectedId && target !== selectedId)) return []
    const { geometry } = drawn
    let segments: Segment[] = []
    if ('line' in geometry) segments = adjacentSegments(geometry.line.map(toScreen))
    else if ('sections' in geometry) {
      segments = geometry.sections.flatMap((section) => adjacentSegments(section.map(toScreen)))
    } else {
      subdivide(geometry.points.map(toScreen), segments)
    }
    const clipped = segments.flatMap((segment) => {
      const visible = clip(segment, viewport)
      return visible ? [visible] : []
    })
    return [{ ...drawn, segments: clipped, destination: source === selectedId ? target : source }]
  })
}

export function hitEdges(edges: IncidentEdge[], pointer: Point): IncidentEdge[] {
  const tolerance = 7
  return edges.filter(({ segments }) => segments.some(([a, b]) =>
    pointer.x >= Math.min(a.x, b.x) - tolerance && pointer.x <= Math.max(a.x, b.x) + tolerance &&
    pointer.y >= Math.min(a.y, b.y) - tolerance && pointer.y <= Math.max(a.y, b.y) + tolerance &&
    distance(pointer, nearestPoint(pointer, [a, b])) <= tolerance
  ))
}

export interface NodeFootprint {
  center: Point
  halfWidth: number
  halfHeight: number
}

export function isClipped(node: NodeFootprint, viewport: Viewport): boolean {
  const { center, halfWidth, halfHeight } = node
  return center.x - halfWidth < 0 || center.x + halfWidth > viewport.width ||
    center.y - halfHeight < 0 || center.y + halfHeight > viewport.height
}

export function revealShift(node: NodeFootprint, viewport: Viewport): Point {
  const inset = 12
  const adjust = (p: number, radius: number, extent: number): number => {
    if (p - radius >= 0 && p + radius <= extent) return 0
    // If the whole card cannot fit, show its leading edge and the start of its title.
    if (radius * 2 > extent) return radius - p
    const margin = radius + Math.min(inset, extent / 2 - radius)
    return Math.max(margin, Math.min(extent - margin, p)) - p
  }
  return {
    x: adjust(node.center.x, node.halfWidth, viewport.width) / viewport.scale,
    y: adjust(node.center.y, node.halfHeight, viewport.height) / viewport.scale
  }
}

export interface BoundaryPoint extends Point {
  side: 'left' | 'right' | 'top' | 'bottom'
}

/** Use the last visible point toward the destination, including the leads of routed edges. */
export function boundaryPoint(edge: IncidentEdge, node: NodeFootprint, viewport: Viewport): BoundaryPoint {
  const incoming = edge.destination === edge.edge.source
  const segment = incoming ? edge.segments[0] : edge.segments[edge.segments.length - 1]
  const end = segment?.[incoming ? 0 : 1] ?? node.center
  const { width, height } = viewport
  const x = Math.max(0, Math.min(width, end.x))
  const y = Math.max(0, Math.min(height, end.y))
  const { center, halfWidth, halfHeight } = node
  const sides = [
    { side: 'left', distance: x, x: 0, y, overflow: halfWidth - center.x },
    { side: 'right', distance: width - x, x: width, y, overflow: center.x + halfWidth - width },
    { side: 'top', distance: y, x, y: 0, overflow: halfHeight - center.y },
    { side: 'bottom', distance: height - y, x, y: height, overflow: center.y + halfHeight - height }
  ] as const
  const clippedSides = sides.filter(({ overflow }) => overflow > 0)
  return (clippedSides.length ? clippedSides : sides).reduce((closest, side) => side.distance < closest.distance ? side : closest)
}
