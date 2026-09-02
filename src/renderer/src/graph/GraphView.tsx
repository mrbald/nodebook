import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphData, GraphEdge, GraphNode, TalkNeighbor } from '@shared/types'
import { forceLayout, type Point } from './layout'
import { dagreLayout } from './dagreLayout'
import { radialLayout } from './radialLayout'
import { groupsLayout } from './groupsLayout'
import { blocksLayout } from './blocksLayout'
import { StatusSelect } from '../StatusSelect'
import { pageRank, community } from './structure'

const W = 800
const H = 600
const RELATED = '~related'
/** Synthetic overlay relation joining two notes that share a name (main/graph.ts). */
const SAME_NAME = 'same_name'
const PALETTE = ['#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66']
const COMMUNITY = ['#7aa2f7', '#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66', '#9ece6a']
const FOLDER = ['#7aa2f7', '#e0a050', '#7ec699', '#bb9af7', '#e06c75', '#56b6c2', '#d19a66', '#9ece6a']
const communityColor = (c: number): string => COMMUNITY[c % COMMUNITY.length]

type ColorMode = 'links' | 'folder' | 'meaning'

/** Top-level vault folder of a note (or '(root)'), for the folder colour mode. */
function folderOf(path: string | null, root: string | null): string {
  if (!path) return '(other)'
  let rel = root && path.startsWith(root) ? path.slice(root.length) : path
  rel = rel.replace(/^[/\\]+/, '')
  const segs = rel.split(/[/\\]/)
  return segs.length > 1 ? segs[0] : '(root)'
}

function relationColors(edges: GraphEdge[]): Map<string, string> {
  const present = new Set(edges.map((e) => e.relation))
  const m = new Map<string, string>()
  if (present.has('links_to')) m.set('links_to', 'var(--muted)')
  if (present.has(RELATED)) m.set(RELATED, '#9ece6a')
  ;[...present]
    .filter((r) => r !== 'links_to' && r !== RELATED)
    .sort()
    .forEach((r, i) => m.set(r, PALETTE[i % PALETTE.length]))
  return m
}

/** Add the ✨ related overlay. Neighbours arrive as paths, which ARE node ids. */
function mergeRelated(
  base: GraphData,
  related: TalkNeighbor[],
  focusId: string | null
): GraphData {
  if (related.length === 0 || !focusId) return base
  const ids = new Set(base.nodes.map((n) => n.id))
  const nodes = [...base.nodes]
  const edges = [...base.edges]
  const linked = new Set(
    base.edges
      .filter((e) => e.source === focusId || e.target === focusId)
      .map((e) => (e.source === focusId ? e.target : e.source))
  )
  for (const nb of related) {
    if (nb.path === focusId) continue
    if (!ids.has(nb.path)) {
      ids.add(nb.path)
      nodes.push({ id: nb.path, label: nb.name, path: nb.path, ghost: false, degree: 0, focus: false })
    }
    if (!linked.has(nb.path)) edges.push({ source: focusId, target: nb.path, relation: RELATED })
  }
  return { ...base, nodes, edges }
}

/** Union a main slice with expanded nodes' neighbourhoods (per-node "expand").
 *  The main slice's focus flag wins; edges are de-duped. */
function mergeGraphs(main: GraphData, extras: GraphData[]): GraphData {
  const nodes = new Map<string, GraphNode>()
  for (const n of main.nodes) nodes.set(n.id, n)
  for (const g of extras) {
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, focus: false })
  }
  const seen = new Set<string>()
  const edges: GraphEdge[] = []
  for (const g of [main, ...extras]) {
    for (const e of g.edges) {
      const key = `${e.source} ${e.relation} ${e.target}`
      if (!seen.has(key)) {
        seen.add(key)
        edges.push(e)
      }
    }
  }
  return { ...main, nodes: [...nodes.values()], edges }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const relLabel = (rel: string): string =>
  rel === RELATED ? '✨ related' : rel === SAME_NAME ? 'same name' : rel

type Gesture =
  | { kind: 'pan'; ox: number; oy: number; sx: number; sy: number }
  | { kind: 'node'; node: GraphNode; ox: number; oy: number; sx: number; sy: number }

/**
 * The knowledge map — a force-directed, read-only view of an index slice. Drag a
 * node to arrange it, drag the background to pan, wheel to zoom, click a node to
 * open it. Colour the dots by cluster (links), by folder, or by meaning. Curate
 * the *view* (filter via the legend; right-click to hide a node) — never the notes.
 * With talk-to-docs on, an opt-in **✨ Related** overlay adds dashed edges to
 * similar-but-unlinked notes.
 */
export function GraphView({
  focusPath,
  focusName,
  vaultRoot,
  talkReady,
  onOpen,
  onOpenInEditor,
  onClose,
  reloadKey,
  statusSlot,
  loadGraph = window.nodebook.graph,
  emptyMessage,
  defaultShowSources = false
}: {
  focusPath: string | null
  focusName: string
  vaultRoot: string | null
  talkReady: boolean
  /** Recenter the map on a note (double-click / "Focus here") — keeps the map open. */
  onOpen: (path: string) => void
  /** Leave the map and open a note in the editor ("Open ↗"). */
  onOpenInEditor: (path: string) => void
  onClose: () => void
  reloadKey?: number
  /** Global status controls (theme, telemetry) rendered in the toolbar, so they
   *  persist across the editor and the map. */
  statusSlot?: React.ReactNode
  /** Where the base graph comes from. Defaults to the vault index; a distill run
   *  passes its own loader so this same view renders a staged run's map. */
  loadGraph?: (
    focus: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ) => Promise<GraphData>
  /** Shown when the graph has nothing to draw. The default speaks about the
   *  vault map (filters/links); a distill run passes its own explanation. */
  emptyMessage?: string
  /** Initial 📕 Source state. The vault map hides source-document hubs (they
   *  swallow the picture); distill views start with the book shown — it is the
   *  run's anchor, and a fresh run's notes may have no other edges yet. */
  defaultShowSources?: boolean
}): React.JSX.Element {
  const [base, setBase] = useState<GraphData | null>(null)
  const [related, setRelated] = useState<TalkNeighbor[]>([])
  const [semEdges, setSemEdges] = useState<{ source: string; target: string }[]>([])
  const [depth, setDepth] = useState(1)
  const [global, setGlobal] = useState(false)
  const [cap, setCap] = useState(200) // global-view node cap; "show more" raises it
  const [expanded, setExpanded] = useState<Set<string>>(new Set()) // per-node "expand": paths
  const [showRelated, setShowRelated] = useState(true)
  // Session-only; the default depends on the view (see defaultShowSources).
  const [showSources, setShowSources] = useState(defaultShowSources)
  const [colorMode, setColorMode] = useState<ColorMode>('links')
  const [layoutMode, setLayoutMode] = useState<'force' | 'tree' | 'radial' | 'groups' | 'blocks'>('force')
  const [hiddenRels, setHiddenRels] = useState<Set<string>>(new Set())
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set())
  const [hiddenFolders, setHiddenFolders] = useState<Set<string>>(new Set())
  const [dragged, setDragged] = useState<Map<string, Point>>(new Map())
  const [pinned, setPinned] = useState<Map<string, Point>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Relation-typing: which outbound target is being named, and the typed-in name.
  const [typingTarget, setTypingTarget] = useState<string | null>(null)
  const [relInput, setRelInput] = useState('')
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const svgRef = useRef<SVGSVGElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const movedRef = useRef(false)
  // Last computed force layout — seeds the next one so unchanged nodes barely move.
  const layoutRef = useRef<Map<string, Point>>(new Map())
  // Manual double-click detection (more reliable than onDoubleClick alongside
  // pointer-capture dragging): same node clicked twice within the threshold.
  const lastClick = useRef<{ id: string; t: number }>({ id: '', t: 0 })

  useEffect(() => {
    let alive = true
    void (async () => {
      const main = await loadGraph(global ? null : focusPath, { depth, cap, showSources })
      const extras =
        expanded.size > 0
          ? await Promise.all([...expanded].map((p) => loadGraph(p, { depth: 1, showSources })))
          : []
      if (alive) setBase(extras.length ? mergeGraphs(main, extras) : main)
    })()
    return () => {
      alive = false
    }
  }, [focusPath, depth, global, cap, expanded, reloadKey, loadGraph, showSources])

  // Leaving/entering the global view resets the cap to its default.
  useEffect(() => setCap(200), [global, focusPath])

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

  useEffect(() => {
    setView({ x: 0, y: 0, k: 1 })
    setHiddenNodes(new Set())
    setDragged(new Map())
    setSelectedId(null)
    setExpanded(new Set())
  }, [focusPath, global, depth])

  // A new layout invalidates hand-placed positions.
  useEffect(() => setDragged(new Map()), [layoutMode])

  // Selecting a different node closes any open relation-typing input.
  useEffect(() => {
    setTypingTarget(null)
    setRelInput('')
  }, [selectedId])

  const data = useMemo(
    () => (base ? mergeRelated(base, related, focusPath) : null),
    [base, related, focusPath]
  )

  // Colour-by-meaning: fetch a semantic kNN graph for the current notes.
  useEffect(() => {
    if (colorMode !== 'meaning' || !talkReady || !data) {
      setSemEdges([])
      return
    }
    const paths = data.nodes.map((n) => n.path).filter((p): p is string => !!p)
    let alive = true
    void window.nodebook.talkSemanticEdges(paths, 4).then((e) => {
      if (alive) setSemEdges(e)
    })
    return () => {
      alive = false
    }
  }, [colorMode, talkReady, data])

  const visible = useMemo(() => {
    if (!data) return null
    const nodes = data.nodes.filter(
      (n) => !hiddenNodes.has(n.id) && !hiddenFolders.has(folderOf(n.path, vaultRoot))
    )
    const ids = new Set(nodes.map((n) => n.id))
    const edges = data.edges.filter(
      (e) => !hiddenRels.has(e.relation) && ids.has(e.source) && ids.has(e.target)
    )
    return { nodes, edges }
  }, [data, hiddenRels, hiddenNodes, hiddenFolders, vaultRoot])

  const layout = useMemo(() => {
    if (!visible) return null
    const o = { width: W, height: H }
    if (layoutMode === 'tree') return dagreLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'radial') return radialLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'groups') return groupsLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'blocks') return blocksLayout(visible.nodes, visible.edges, o)
    // Force: seed from the previous layout (+ pinned anchors) so adding/removing a
    // node nudges rather than reshuffles; pinned nodes are fixed.
    const seed = new Map(layoutRef.current)
    for (const [id, p] of pinned) seed.set(id, p)
    return forceLayout(visible.nodes, visible.edges, {
      ...o,
      seed,
      fixed: new Set(pinned.keys())
    })
  }, [visible, layoutMode, pinned])

  // Remember the force layout to seed the next relayout; a new graph or a new
  // layout algorithm starts fresh (depth changes keep the seed for stability).
  useEffect(() => {
    if (layout) layoutRef.current = layout
  }, [layout])
  useEffect(() => {
    layoutRef.current = new Map()
  }, [focusPath, global, layoutMode])
  const colors = useMemo(() => (data ? relationColors(data.edges) : new Map()), [data])
  const pr = useMemo(() => (visible ? pageRank(visible.nodes, visible.edges) : new Map()), [visible])
  const comm = useMemo(
    () => (visible ? community(visible.nodes, visible.edges) : new Map()),
    [visible]
  )
  const meaningCluster = useMemo(
    () =>
      visible && colorMode === 'meaning'
        ? community(visible.nodes, semEdges)
        : new Map<string, number>(),
    [visible, semEdges, colorMode]
  )
  const folderColors = useMemo(() => {
    const m = new Map<string, string>()
    if (!visible) return m
    ;[...new Set(visible.nodes.map((n) => folderOf(n.path, vaultRoot)))]
      .sort()
      .forEach((f, i) => m.set(f, FOLDER[i % FOLDER.length]))
    return m
  }, [visible, vaultRoot])

  const maxPr = useMemo(() => Math.max(1e-9, ...[...pr.values()]), [pr])
  const radius = (id: string): number => 7 + Math.sqrt((pr.get(id) ?? 0) / maxPr) * 14
  const posOf = (id: string): Point | undefined =>
    pinned.get(id) ?? dragged.get(id) ?? layout?.get(id)
  const nodeFill = (node: GraphNode): string | undefined => {
    if (node.ghost) return undefined
    // Overlay view: every note carries a `source`, so colour by provenance — your
    // notes (muted) vs the run (blue) — with a name shared across the two sides
    // (pink) calling out the clash a merge would have to settle.
    if (node.source)
      return node.sameName ? '#e06c75' : node.source === 'run' ? '#7aa2f7' : 'var(--muted)'
    if (colorMode === 'folder') return folderColors.get(folderOf(node.path, vaultRoot))
    if (colorMode === 'meaning') return communityColor(meaningCluster.get(node.id) ?? 0)
    return communityColor(comm.get(node.id) ?? 0)
  }
  const filtered = hiddenRels.size + hiddenNodes.size + hiddenFolders.size
  const modes: ColorMode[] = talkReady ? ['links', 'folder', 'meaning'] : ['links', 'folder']

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
  const onBgPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    gesture.current = { kind: 'pan', ox: view.x, oy: view.y, sx: e.clientX, sy: e.clientY }
    movedRef.current = false
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const onNodePointerDown = (e: React.PointerEvent, node: GraphNode): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const p = posOf(node.id)
    if (!p) return
    gesture.current = { kind: 'node', node, ox: p.x, oy: p.y, sx: e.clientX, sy: e.clientY }
    movedRef.current = false
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.sx
    const dy = e.clientY - g.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true
    if (g.kind === 'pan') {
      const s = unitsPerPx()
      setView((v) => ({ ...v, x: g.ox + dx * s, y: g.oy + dy * s }))
    } else {
      const s = unitsPerPx() / view.k
      setDragged((m) => new Map(m).set(g.node.id, { x: g.ox + dx * s, y: g.oy + dy * s }))
    }
  }
  const onPointerUp = (): void => {
    const g = gesture.current
    gesture.current = null
    // A plain click on the background deselects.
    if (g?.kind === 'pan' && !movedRef.current) {
      setSelectedId(null)
      return
    }
    if (g?.kind !== 'node' || movedRef.current) return
    // A plain click selects (fills the inspector, view unchanged); a second click
    // on the same node within the threshold refocuses the map on it. Navigation
    // is the secondary gesture — never a single click.
    const now = performance.now()
    const isDouble = lastClick.current.id === g.node.id && now - lastClick.current.t < 350
    if (isDouble && g.node.path) {
      onOpen(g.node.path)
      setSelectedId(null)
      lastClick.current = { id: '', t: 0 }
    } else {
      setSelectedId(g.node.id)
      lastClick.current = { id: g.node.id, t: now }
    }
  }

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  // Expand a node: merge in its own depth-1 neighbourhood without growing the
  // whole map; collapse drops it again.
  const toggleExpand = (path: string): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Pin a node at its current spot so it anchors the layout; unpin to release it.
  const togglePin = (id: string): void => {
    setPinned((m) => {
      const next = new Map(m)
      if (next.has(id)) next.delete(id)
      else {
        const p = posOf(id)
        if (p) next.set(id, { x: p.x, y: p.y })
      }
      return next
    })
  }

  const byFolder = colorMode === 'folder'
  const legend: [string, string][] = byFolder ? [...folderColors.entries()] : [...colors.entries()]
  const hidden = byFolder ? hiddenFolders : hiddenRels
  const setHidden = byFolder ? setHiddenFolders : setHiddenRels

  // Inspector stats.
  const nodeCount = visible?.nodes.length ?? 0
  const edgeCount = visible?.edges.length ?? 0
  const clusterCount = byFolder
    ? folderColors.size
    : new Set([...(colorMode === 'meaning' ? meaningCluster : comm).values()]).size

  // Node ids are paths, but everything the user reads or writes is the note
  // *name* — so edge endpoints are shown, and links are written, through this.
  const labelOf = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n.label])), [data])
  const nameOf = (id: string): string => labelOf.get(id) ?? id

  // The selected node's details (its edges in the current slice) for the inspector.
  const selectedNode = selectedId ? (data?.nodes.find((n) => n.id === selectedId) ?? null) : null
  const selOut = selectedNode && data ? data.edges.filter((e) => e.source === selectedNode.id) : []
  const selIn = selectedNode && data ? data.edges.filter((e) => e.target === selectedNode.id) : []

  // Relation-typing: existing relation names for autocomplete; a valid field key.
  const knownRelations = useMemo(
    () => [
      ...new Set(
        (data?.edges ?? [])
          .map((e) => e.relation)
          .filter((r) => r !== 'links_to' && r !== RELATED && r !== SAME_NAME)
      )
    ],
    [data]
  )
  const validRel = (r: string): boolean => /^[A-Za-z][\w -]*$/.test(r.trim())
  const submitRelation = (target: string): void => {
    const rel = relInput.trim()
    if (!validRel(rel) || !selectedNode?.path) return
    void window.nodebook.typeRelation(selectedNode.path, rel, nameOf(target)).catch(() => {})
    setTypingTarget(null)
    setRelInput('')
  }

  return (
    <div className="graph-view">
      <div className="graph-main">
        {visible && layout && visible.nodes.length > 0 ? (
          <svg
            ref={svgRef}
            className="graph-canvas"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            onWheel={onWheel}
            onPointerDown={onBgPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {visible.edges.map((e, i) => {
                const a = posOf(e.source)
                const b = posOf(e.target)
                if (!a || !b) return null
                return (
                  <line
                    key={i}
                    className={`graph-edge${e.relation === RELATED ? ' graph-edge-related' : ''}${e.relation === SAME_NAME ? ' graph-edge-samename' : ''}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={colors.get(e.relation) ?? 'var(--muted)'}
                  />
                )
              })}
              {visible.nodes.map((node) => {
                const p = posOf(node.id)
                if (!p) return null
                const r = radius(node.id)
                const cls = `graph-node${node.focus ? ' is-focus' : ''}${node.ghost ? ' is-ghost' : ''}${node.id === selectedId ? ' is-selected' : ''}${pinned.has(node.id) ? ' is-pinned' : ''}`
                const fill = nodeFill(node)
                return (
                  <g
                    key={node.id}
                    className={cls}
                    transform={`translate(${p.x},${p.y})`}
                    onPointerDown={(ev) => onNodePointerDown(ev, node)}
                    onContextMenu={(ev) => {
                      ev.preventDefault()
                      if (!node.focus) setHiddenNodes((s) => new Set(s).add(node.id))
                    }}
                  >
                    <circle r={r} style={fill ? { fill } : undefined} />
                    <text y={r + 13}>{node.label}</text>
                  </g>
                )
              })}
            </g>
          </svg>
        ) : (
          <div className="graph-empty">
            {data
              ? (emptyMessage ??
                'Nothing to show — clear the filters, or add a [[link]] to this note.')
              : 'Loading…'}
          </div>
        )}

        <div className="graph-toolbar">
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
            <StatusSelect
              kind="colour"
              prefix="colour: "
              title="Colour the dots by…"
              value={colorMode}
              options={modes.map((m) => ({ value: m, label: m }))}
              onChange={(v) => setColorMode(v as ColorMode)}
            />
            <StatusSelect
              kind="layout"
              prefix="layout: "
              title="Layout: organic web (force), hierarchical tree (dagre), focus-centric radial, community groups, or min-cut blocks"
              value={layoutMode}
              options={[
                { value: 'force', label: 'force' },
                { value: 'tree', label: 'tree' },
                { value: 'radial', label: 'radial' },
                { value: 'groups', label: 'groups' },
                { value: 'blocks', label: 'blocks' }
              ]}
              onChange={(v) => setLayoutMode(v as 'force' | 'tree' | 'radial' | 'groups' | 'blocks')}
            />
            {talkReady && !global && (
              <button
                className={`graph-ctl${showRelated ? ' is-on' : ''}`}
                title="Show semantically-related (but unlinked) notes"
                onClick={() => setShowRelated((s) => !s)}
              >
                ✨ Related
              </button>
            )}
            {(showSources || (base?.hiddenSources ?? 0) > 0) && (
              <button
                className={`graph-ctl${showSources ? ' is-on' : ''}`}
                title="Show the source document — notes distilled from a document all link back to it; it's hidden so it doesn't swallow the map."
                onClick={() => setShowSources((s) => !s)}
              >
                📕 Source
              </button>
            )}
            {filtered > 0 && (
              <button
                className="graph-ctl"
                title="Show everything again"
                onClick={() => {
                  setHiddenRels(new Set())
                  setHiddenNodes(new Set())
                  setHiddenFolders(new Set())
                }}
              >
                show all ({filtered})
              </button>
            )}
            <button
              className="graph-ctl"
              title="Reset the view — zoom, pan, and any nodes you've dragged or pinned"
              onClick={() => {
                setView({ x: 0, y: 0, k: 1 })
                setDragged(new Map())
                setPinned(new Map())
              }}
            >
              ⟲ reset view
            </button>
          </div>
          <span className="graph-toolbar-right">
            {statusSlot}
            <button className="graph-close" onClick={onClose}>
              ✕ Close
            </button>
          </span>
        </div>
      </div>

      <aside className="graph-inspector">
        {selectedNode ? (
          <>
            <div className="graph-insp-title">
              {selectedNode.ghost ? '◌ ' : '● '}
              {selectedNode.label}
            </div>
            <div className="graph-insp-stat">
              {selectedNode.ghost
                ? 'Referenced, not yet created'
                : `${selOut.length} out · ${selIn.length} in`}
            </div>
            {selectedNode.aliases && selectedNode.aliases.length > 0 && (
              <div className="graph-insp-aliases" title="Notes you confirmed are the same thing">
                also known as {selectedNode.aliases.join(', ')}
              </div>
            )}
            <div className="graph-insp-actions">
              {selectedNode.path && (
                <>
                  <button
                    className="graph-ctl"
                    title="Recenter the map on this note"
                    onClick={() => {
                      onOpen(selectedNode.path!)
                      setSelectedId(null)
                    }}
                  >
                    Focus here
                  </button>
                  <button
                    className="graph-ctl"
                    title="Open this note in the editor"
                    onClick={() => onOpenInEditor(selectedNode.path!)}
                  >
                    Open ↗
                  </button>
                </>
              )}
              {!selectedNode.focus && selectedNode.path && (
                <button
                  className={`graph-ctl${expanded.has(selectedNode.path) ? ' is-on' : ''}`}
                  title="Pull in this note's own links, without changing the rest of the map"
                  onClick={() => toggleExpand(selectedNode.path!)}
                >
                  {expanded.has(selectedNode.path) ? 'Collapse' : 'Expand'}
                </button>
              )}
              <button
                className={`graph-ctl${pinned.has(selectedNode.id) ? ' is-on' : ''}`}
                title="Pin this note in place so it anchors the layout"
                onClick={() => togglePin(selectedNode.id)}
              >
                {pinned.has(selectedNode.id) ? 'Unpin' : 'Pin'}
              </button>
              <button className="graph-ctl" onClick={() => setSelectedId(null)}>
                Deselect
              </button>
            </div>
            {selOut.length > 0 && (
              <div className="graph-insp-section">
                <div className="graph-insp-label">Links out</div>
                {selOut.map((e, i) => {
                  const typeable = e.relation === 'links_to' && !!selectedNode.path
                  return (
                    <div key={`o${i}`} className="graph-insp-edge">
                      <span className="graph-insp-rel">{relLabel(e.relation)}</span>
                      <span className="graph-insp-target">{nameOf(e.target)}</span>
                      {typeable && typingTarget !== e.target && (
                        <button
                          className="graph-insp-name"
                          title="Name this link — writes a key:: value to the note"
                          onClick={() => {
                            setTypingTarget(e.target)
                            setRelInput('')
                          }}
                        >
                          + name
                        </button>
                      )}
                      {typeable && typingTarget === e.target && (
                        <form
                          className="graph-insp-nameform"
                          onSubmit={(ev) => {
                            ev.preventDefault()
                            submitRelation(e.target)
                          }}
                        >
                          <input
                            list="graph-relations"
                            className="graph-insp-input"
                            autoFocus
                            placeholder="relation…"
                            value={relInput}
                            onChange={(ev) => setRelInput(ev.target.value)}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Escape') setTypingTarget(null)
                            }}
                          />
                          <button
                            type="submit"
                            className="graph-insp-name"
                            disabled={!validRel(relInput)}
                          >
                            ✓
                          </button>
                        </form>
                      )}
                    </div>
                  )
                })}
                {knownRelations.length > 0 && (
                  <datalist id="graph-relations">
                    {knownRelations.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                )}
              </div>
            )}
            {selIn.length > 0 && (
              <div className="graph-insp-section">
                <div className="graph-insp-label">Links in</div>
                {selIn.map((e, i) => (
                  <div key={`i${i}`} className="graph-insp-edge">
                    <span className="graph-insp-rel">{relLabel(e.relation)}</span>
                    {nameOf(e.source)}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="graph-insp-title">⊹ {global ? 'Whole vault' : focusName}</div>
            <div className="graph-insp-stat">
              {nodeCount} {nodeCount === 1 ? 'note' : 'notes'} · {edgeCount}{' '}
              {edgeCount === 1 ? 'link' : 'links'}
              {clusterCount > 1 ? ` · ${clusterCount} clusters` : ''}
            </div>
            {base?.total !== undefined && base.total > base.nodes.length && (
              <div className="graph-insp-more">
                showing the {base.nodes.length} most-connected of {base.total}
                <button className="graph-ctl" onClick={() => setCap((c) => c + 200)}>
                  show more
                </button>
              </div>
            )}
            {(base?.ambiguousTargets ?? 0) > 0 && (
              <div className="graph-insp-note" title="Two notes share a name, so the map had to pick one — it prefers a note in the same folder as the link.">
                {base!.ambiguousTargets} {base!.ambiguousTargets === 1 ? 'link' : 'links'} could
                point to more than one note
              </div>
            )}
            {legend.length > 1 && (
              <div className="graph-insp-section">
                <div className="graph-insp-label">
                  {byFolder ? 'Folders' : 'Link types'} — click to show / hide
                </div>
                <div className="graph-legend">
                  {legend.map(([key, c]) => (
                    <button
                      key={key}
                      className={`graph-legend-item${hidden.has(key) ? ' is-off' : ''}`}
                      onClick={() => setHidden((s) => toggle(s, key))}
                    >
                      <span className="graph-legend-dot" style={{ background: c }} />
                      {byFolder ? key : relLabel(key)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="graph-insp-hint">
              Click a note to inspect · double-click to focus · right-click to hide.
            </p>
          </>
        )}
      </aside>
    </div>
  )
}
