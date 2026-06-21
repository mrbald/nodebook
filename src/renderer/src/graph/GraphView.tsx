import { useEffect, useMemo, useState } from 'react'
import type { GraphData, GraphEdge } from '@shared/types'
import { forceLayout } from './layout'

const W = 800
const H = 600
const PALETTE = ['#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66']

/** Map each typed relation to a stable colour; `links_to` stays neutral. */
function relationColors(edges: GraphEdge[]): Map<string, string> {
  const m = new Map<string, string>([['links_to', 'var(--muted)']])
  const typed = [...new Set(edges.map((e) => e.relation))].filter((r) => r !== 'links_to').sort()
  typed.forEach((r, i) => m.set(r, PALETTE[i % PALETTE.length]))
  return m
}

/**
 * The local knowledge map — a force-directed, read-only view of the index slice
 * around the focus note. Click a real node to recenter/open it; ghosts (linked
 * but uncreated) are dimmed. "Manage, don't draw": layout is automatic, edges are
 * harvested triples, nothing here writes back.
 */
export function GraphView({
  focusPath,
  focusName,
  onOpen,
  onClose,
  reloadKey
}: {
  focusPath: string | null
  focusName: string
  onOpen: (path: string) => void
  onClose: () => void
  reloadKey?: number
}): React.JSX.Element {
  const [data, setData] = useState<GraphData | null>(null)

  useEffect(() => {
    let alive = true
    void window.nodebook.graph(focusPath, { depth: 1 }).then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [focusPath, reloadKey])

  const layout = useMemo(
    () => (data ? forceLayout(data.nodes, data.edges, { width: W, height: H }) : null),
    [data]
  )
  const colors = useMemo(() => (data ? relationColors(data.edges) : new Map()), [data])

  return (
    <div className="graph-view">
      <div className="graph-header">
        <span className="graph-title">⊹ Map — {focusName}</span>
        {colors.size > 1 && (
          <span className="graph-legend">
            {[...colors.entries()].map(([rel, c]) => (
              <span key={rel} className="graph-legend-item">
                <span className="graph-legend-dot" style={{ background: c }} />
                {rel}
              </span>
            ))}
          </span>
        )}
        <button className="graph-close" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      {data && layout && data.nodes.length > 0 ? (
        <svg className="graph-canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          {data.edges.map((e, i) => {
            const a = layout.get(e.source)
            const b = layout.get(e.target)
            if (!a || !b) return null
            return (
              <line
                key={i}
                className="graph-edge"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={colors.get(e.relation) ?? 'var(--muted)'}
              />
            )
          })}
          {data.nodes.map((node) => {
            const p = layout.get(node.id)
            if (!p) return null
            const r = 6 + Math.min(node.degree, 8) * 1.5
            const cls = `graph-node${node.focus ? ' is-focus' : ''}${node.ghost ? ' is-ghost' : ''}`
            return (
              <g
                key={node.id}
                className={cls}
                transform={`translate(${p.x},${p.y})`}
                onClick={() => node.path && onOpen(node.path)}
              >
                <circle r={r} />
                <text y={r + 13}>{node.label}</text>
              </g>
            )
          })}
        </svg>
      ) : (
        <div className="graph-empty">
          {data ? 'No links yet — add a [[link]] or a key:: value to this note.' : 'Loading…'}
        </div>
      )}
    </div>
  )
}
