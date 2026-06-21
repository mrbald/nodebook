import { useEffect, useMemo, useRef, useState } from 'react'
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

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * The knowledge map — a force-directed, read-only view of an index slice. Local
 * (depth-`d` around the focus note) or global (the whole vault, capped). Pan with
 * a drag, zoom with the wheel; click a real node to recenter/open it. "Manage,
 * don't draw": layout is automatic, edges are harvested triples, nothing writes
 * back.
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
  const [depth, setDepth] = useState(1)
  const [global, setGlobal] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const svgRef = useRef<SVGSVGElement>(null)
  const pan = useRef<{ ox: number; oy: number; sx: number; sy: number; moved: boolean } | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    let alive = true
    void window.nodebook.graph(global ? null : focusPath, { depth }).then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [focusPath, depth, global, reloadKey])

  // Reset pan/zoom when the *graph* changes (not on a mere save-triggered reload).
  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [focusPath, global, depth])

  const layout = useMemo(
    () => (data ? forceLayout(data.nodes, data.edges, { width: W, height: H }) : null),
    [data]
  )
  const colors = useMemo(() => (data ? relationColors(data.edges) : new Map()), [data])

  // Screen → viewBox scale (the svg fits viewBox W×H into its client box).
  const unitsPerPx = (): number => W / (svgRef.current?.clientWidth || W)

  const onWheel = (e: React.WheelEvent): void => {
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const m = svg.getScreenCTM()
    if (!m) return
    const p = pt.matrixTransform(m.inverse()) // pointer in viewBox coords
    setView((v) => {
      const k = clamp(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.25, 6)
      const r = k / v.k
      return { k, x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r }
    })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    pan.current = { ox: view.x, oy: view.y, sx: e.clientX, sy: e.clientY, moved: false }
    movedRef.current = false
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = pan.current
    if (!g) return
    const dx = e.clientX - g.sx
    const dy = e.clientY - g.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      g.moved = true
      movedRef.current = true
    }
    const s = unitsPerPx()
    setView((v) => ({ ...v, x: g.ox + dx * s, y: g.oy + dy * s }))
  }
  const onPointerUp = (): void => {
    pan.current = null
  }

  return (
    <div className="graph-view">
      <div className="graph-header">
        <span className="graph-title">⊹ Map — {global ? 'whole vault' : focusName}</span>
        <div className="graph-controls">
          <button className="graph-ctl" onClick={() => setGlobal((g) => !g)}>
            {global ? 'Local' : 'Global'}
          </button>
          {!global && (
            <span className="graph-depth">
              <button
                className="graph-ctl"
                disabled={depth <= 1}
                onClick={() => setDepth((d) => Math.max(1, d - 1))}
              >
                −
              </button>
              depth {depth}
              <button
                className="graph-ctl"
                disabled={depth >= 3}
                onClick={() => setDepth((d) => Math.min(3, d + 1))}
              >
                +
              </button>
            </span>
          )}
          <button
            className="graph-ctl"
            title="Reset zoom"
            onClick={() => setView({ x: 0, y: 0, k: 1 })}
          >
            ⟲
          </button>
        </div>
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
        <svg
          ref={svgRef}
          className="graph-canvas"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
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
                  onClick={() => {
                    if (!movedRef.current && node.path) onOpen(node.path)
                  }}
                >
                  <circle r={r} />
                  <text y={r + 13}>{node.label}</text>
                </g>
              )
            })}
          </g>
        </svg>
      ) : (
        <div className="graph-empty">
          {data ? 'No links yet — add a [[link]] or a key:: value to this note.' : 'Loading…'}
        </div>
      )}
    </div>
  )
}
