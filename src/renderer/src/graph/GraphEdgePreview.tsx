import type { GraphNode } from '@shared/types'
import type { CSSProperties } from 'react'
import type { BoundaryPoint, IncidentEdge, Viewport } from './edgeNavigationGeometry'
import type { Point } from './layout'

const ARROWS = { top: '↑', right: '→', bottom: '↓', left: '←' }

export interface EdgeDestination {
  node: GraphNode
  edges: IncidentEdge[]
  boundary?: BoundaryPoint
}

function placement(anchor: Point, viewport: Viewport, boundary?: BoundaryPoint): CSSProperties {
  const margin = 8
  const { x, y } = boundary ?? anchor
  const side = boundary?.side
  const fromLeft = side === 'left' || (side !== 'right' && x <= viewport.width / 2)
  const fromTop = side === 'top' || (side !== 'bottom' && y <= viewport.height / 2)
  const hInset = side === 'left' || side === 'right' ? margin
    : Math.max(margin, (fromLeft ? x : viewport.width - x) + margin)
  const vInset = side === 'top' || side === 'bottom' ? margin
    : Math.max(margin, (fromTop ? y : viewport.height - y) - margin)
  return {
    [fromLeft ? 'left' : 'right']: hInset,
    [fromTop ? 'top' : 'bottom']: vInset,
    maxWidth: Math.max(0, Math.min(245, viewport.width - hInset - margin)),
    maxHeight: Math.max(0, viewport.height - vInset - margin)
  }
}

export function GraphEdgePreview({
  anchor,
  destinations,
  viewport,
  describe,
  follow,
  closeChoice,
  choiceRef,
  boundaryMarker = false
}: {
  anchor: Point
  destinations: EdgeDestination[]
  viewport: Viewport
  describe: (edge: IncidentEdge) => string
  follow?: (id: string) => void
  closeChoice?: () => void
  choiceRef?: React.Ref<HTMLDivElement>
  boundaryMarker?: boolean
}): React.JSX.Element {
  const boundary = boundaryMarker || destinations.length === 1 ? destinations[0].boundary : undefined
  return (
    <div
      className="graph-edge-preview"
      data-offscreen={boundary?.side}
      data-boundary-marker={boundaryMarker || undefined}
      ref={choiceRef}
      role={boundaryMarker ? undefined : 'group'}
      aria-hidden={boundaryMarker || undefined}
      aria-label={boundaryMarker ? undefined : destinations.length > 1 ? 'Choose a linked note' : 'Connection preview'}
      style={placement(anchor, viewport, boundary)}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Element && next.closest('.graph-edge-preview'))) closeChoice?.()
      }}
    >
      {destinations.map(({ node, edges, boundary }) => {
        const relationText = [...new Set(edges.map(describe))].join(' · ')
        const duplicate = destinations.some((other) => other.node.id !== node.id && other.node.label === node.label)
        const detail = duplicate ? node.path ?? node.id : undefined
        const name = detail ? `${node.label} (${detail})` : node.label
        const content = (
          <>
            <span className="graph-edge-destination-name">
              {boundary && <span aria-hidden="true">{ARROWS[boundary.side]} </span>}
              {node.label}
            </span>
            {detail && <span className="graph-edge-destination-relation">{detail}</span>}
            <span className="graph-edge-destination-relation">{relationText}</span>
          </>
        )
        if (boundaryMarker) return <div className="graph-edge-destination" key={node.id}>{content}</div>
        return (
          <button
            key={node.id}
            className="graph-edge-destination"
            data-edge-preview-target={node.id}
            type="button"
            aria-label={`Inspect ${name} on the map`}
            aria-description={relationText}
            title={node.path ?? undefined}
            onClick={() => follow?.(node.id)}
          >{content}</button>
        )
      })}
    </div>
  )
}
