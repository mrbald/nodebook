import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphData, GraphEdge, TalkNeighbor } from '@shared/types'
import { forceLayout } from './layout'
import { pageRank, community } from './structure'

const W = 800
const H = 600
const RELATED = '~related'
const PALETTE = ['#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66']
const COMMUNITY = ['#7aa2f7', '#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66', '#9ece6a']
const communityColor = (c: number): string => COMMUNITY[c % COMMUNITY.length]

/** Colour each relation; `links_to` neutral, the AI "related" overlay accent-green. */
function relationColors(edges: GraphEdge[]): Map<string, string> {
  const m = new Map<string, string>([['links_to', 'var(--muted)'], [RELATED, '#9ece6a']])
  const typed = [...new Set(edges.map((e) => e.relation))]
    .filter((r) => r !== 'links_to' && r !== RELATED)
    .sort()
  typed.forEach((r, i) => m.set(r, PALETTE[i % PALETTE.length]))
  return m
}

/** Overlay the focus note's semantic neighbours as nodes + dashed "related" edges
 *  (only where they aren't already link-connected — "related but not linked"). */
function mergeRelated(base: GraphData, related: TalkNeighbor[], focusName: string): GraphData {
  if (related.length === 0) return base
  const ids = new Set(base.nodes.map((n) => n.id))
  const nodes = [...base.nodes]
  const edges = [...base.edges]
  const linked = new Set(
    base.edges
      .filter((e) => e.source === focusName || e.target === focusName)
      .map((e) => (e.source === focusName ? e.target : e.source))
  )
  for (const nb of related) {
    if (nb.name === focusName) continue
    if (!ids.has(nb.name)) {
      ids.add(nb.name)
      nodes.push({ id: nb.name, label: nb.name, path: nb.path, ghost: false, degree: 0, focus: false })
    }
    if (!linked.has(nb.name)) edges.push({ source: focusName, target: nb.name, relation: RELATED })
  }
  return { nodes, edges }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const relLabel = (rel: string): string => (rel === RELATED ? '✨ related' : rel)

/**
 * The knowledge map — a force-directed, read-only view of an index slice. Local
 * (depth-`d` around the focus note) or global. Curate the *view* (filter link
 * types by clicking the legend; right-click to hide a noisy node) — never the
 * geometry. With talk-to-docs on, an opt-in **✨ Related** overlay adds dashed
 * edges to similar-but-unlinked notes. Pan with a drag, zoom with the wheel.
 */
export function GraphView({
  focusPath,
  focusName,
  talkReady,
  onOpen,
  onClose,
  reloadKey
}: {
  focusPath: string | null
  focusName: string
  talkReady: boolean
  onOpen: (path: string) => void
  onClose: () => void
  reloadKey?: number
}): React.JSX.Element {
  const [base, setBase] = useState<GraphData | null>(null)
  const [related, setRelated] = useState<TalkNeighbor[]>([])
  const [depth, setDepth] = useState(1)
  const [global, setGlobal] = useState(false)
  const [showRelated, setShowRelated] = useState(true)
  const [hiddenRels, setHiddenRels] = useState<Set<string>>(new Set())
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set())
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const svgRef = useRef<SVGSVGElement>(null)
  const pan = useRef<{ ox: number; oy: number; sx: number; sy: number; moved: boolean } | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    let alive = true
    void window.nodebook.graph(global ? null : focusPath, { depth }).then((d) => {
      if (alive) setBase(d)
    })
    return () => {
      alive = false
    }
  }, [focusPath, depth, global, reloadKey])

  useEffect(() => {
    if (!talkReady || !showRelated || global || !focusPath) {
      setRelated([])
      return
    }
    let alive = true
    void window.nodebook.talkNeighbors(focusPath, 5).then((n) => {
      if (alive) setRelated(n)
    })
    return () => {
      alive = false
    }
  }, [focusPath, talkReady, showRelated, global, reloadKey])

  // New graph → reset pan/zoom and the node-specific hides (relation filter persists).
  useEffect(() => {
    setView({ x: 0, y: 0, k: 1 })
    setHiddenNodes(new Set())
  }, [focusPath, global, depth])

  const data = useMemo(
    () => (base ? mergeRelated(base, related, focusName) : null),
    [base, related, focusName]
  )
  // The curated view: drop hidden nodes and filtered relations.
  const visible = useMemo(() => {
    if (!data) return null
    const nodes = data.nodes.filter((n) => !hiddenNodes.has(n.id))
    const ids = new Set(nodes.map((n) => n.id))
    const edges = data.edges.filter(
      (e) => !hiddenRels.has(e.relation) && ids.has(e.source) && ids.has(e.target)
    )
    return { nodes, edges }
  }, [data, hiddenRels, hiddenNodes])

  const layout = useMemo(
    () => (visible ? forceLayout(visible.nodes, visible.edges, { width: W, height: H }) : null),
    [visible]
  )
  const colors = useMemo(() => (data ? relationColors(data.edges) : new Map()), [data])
  const pr = useMemo(() => (visible ? pageRank(visible.nodes, visible.edges) : new Map()), [visible])
  const comm = useMemo(
    () => (visible ? community(visible.nodes, visible.edges) : new Map()),
    [visible]
  )
  const maxPr = useMemo(() => Math.max(1e-9, ...[...pr.values()]), [pr])
  const radius = (id: string): number => 7 + Math.sqrt((pr.get(id) ?? 0) / maxPr) * 14
  const filtered = hiddenRels.size + hiddenNodes.size

  const unitsPerPx = (): number => W / (svgRef.current?.clientWidth || W)

  const onWheel = (e: React.WheelEvent): void => {
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const m = svg.getScreenCTM()
    if (!m) return
    const p = pt.matrixTransform(m.inverse())
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

  const toggleRel = (rel: string): void =>
    setHiddenRels((s) => {
      const next = new Set(s)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })

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
          {talkReady && !global && (
            <button
              className={`graph-ctl${showRelated ? ' is-on' : ''}`}
              title="Show semantically-related (but unlinked) notes"
              onClick={() => setShowRelated((s) => !s)}
            >
              ✨ Related
            </button>
          )}
          {filtered > 0 && (
            <button
              className="graph-ctl"
              title="Show everything again"
              onClick={() => {
                setHiddenRels(new Set())
                setHiddenNodes(new Set())
              }}
            >
              reset ({filtered})
            </button>
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
          <span className="graph-legend" title="Click a link type to show/hide it">
            {[...colors.entries()].map(([rel, c]) => (
              <button
                key={rel}
                className={`graph-legend-item${hiddenRels.has(rel) ? ' is-off' : ''}`}
                onClick={() => toggleRel(rel)}
              >
                <span className="graph-legend-dot" style={{ background: c }} />
                {relLabel(rel)}
              </button>
            ))}
          </span>
        )}
        <button className="graph-close" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      {visible && layout && visible.nodes.length > 0 ? (
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
            {visible.edges.map((e, i) => {
              const a = layout.get(e.source)
              const b = layout.get(e.target)
              if (!a || !b) return null
              return (
                <line
                  key={i}
                  className={`graph-edge${e.relation === RELATED ? ' graph-edge-related' : ''}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={colors.get(e.relation) ?? 'var(--muted)'}
                />
              )
            })}
            {visible.nodes.map((node) => {
              const p = layout.get(node.id)
              if (!p) return null
              const r = radius(node.id)
              const cls = `graph-node${node.focus ? ' is-focus' : ''}${node.ghost ? ' is-ghost' : ''}`
              return (
                <g
                  key={node.id}
                  className={cls}
                  transform={`translate(${p.x},${p.y})`}
                  onClick={() => {
                    if (!movedRef.current && node.path) onOpen(node.path)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!node.focus) setHiddenNodes((s) => new Set(s).add(node.id))
                  }}
                >
                  <circle
                    r={r}
                    style={node.ghost ? undefined : { fill: communityColor(comm.get(node.id) ?? 0) }}
                  />
                  <text y={r + 13}>{node.label}</text>
                </g>
              )
            })}
          </g>
        </svg>
      ) : (
        <div className="graph-empty">
          {data ? 'Nothing to show — clear the filters, or add a [[link]] to this note.' : 'Loading…'}
        </div>
      )}
    </div>
  )
}
