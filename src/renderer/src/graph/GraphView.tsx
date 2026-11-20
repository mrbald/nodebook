import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GraphData, GraphEdge, GraphNode, TalkNeighbor } from '@shared/types'
import type { Point } from './layout'
import { edgeKey } from './elkLayout'
import { edgeLanes, LABEL_FONT_SIZE, LABEL_LINE_HEIGHT, manualConnector, sectionPath } from './graphGeometry'
import { fitMapView, mapGlyphRadius, MAP_HIT_RADIUS, MAP_LABEL_FONT, MAP_LABEL_LINE, placeMapTitles, type MapView } from './mapPresentation'
import { boundaryPoint, distance, hitEdges, isClipped, nearestPoint, project, projectIncidentEdges, revealShift, type DrawnEdge, type IncidentEdge, type NodeFootprint, type Viewport } from './edgeNavigationGeometry'
import { GraphEdgePreview, type EdgeDestination } from './GraphEdgePreview'
import { useForceLayout } from './useForceLayout'
import { useRoutedLayout } from './useRoutedLayout'
import { isMapLayout, MAP_LAYOUT_OPTIONS, type MapLayout } from './mapLayoutPreference'
import { dagreLayout } from './dagreLayout'
import { spaceRoutedLayers, spaceTreeRanks } from './layerSpacing'
import { nodePicker } from './nodePicking'
import { radialLayout } from './radialLayout'
import { groupsLayout } from './groupsLayout'
import { blocksLayout } from './blocksLayout'
import { VaultThemes } from './VaultThemes'
import { StatusSelect } from '../StatusSelect'
import { pageRank, community } from './structure'
import './edgeNavigation.css'

const W = 800
const H = 600
const NO_EXPANSIONS: ReadonlySet<string> = new Set()
const NO_RELATED: TalkNeighbor[] = []
const RELATED = '~related'
/** Synthetic overlay relation joining two notes that share a name (main/graph.ts). */
const SAME_NAME = 'same_name'
const PALETTE = ['#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66']
const COMMUNITY = ['#7aa2f7', '#bb9af7', '#7ec699', '#e0a050', '#e06c75', '#56b6c2', '#d19a66', '#9ece6a']
const FOLDER = ['#7aa2f7', '#e0a050', '#7ec699', '#bb9af7', '#e06c75', '#56b6c2', '#d19a66', '#9ece6a']
const communityColor = (c: number): string => COMMUNITY[c % COMMUNITY.length]

const ORIGINS = {
  run: { label: 'Staged note', color: '#7aa2f7' },
  vault: { label: 'Vault note', color: 'var(--muted)' }
}
const COLOR_LABELS = { links: 'Links', folder: 'Folder', meaning: 'Meaning', origin: 'Origin' }
type ColorMode = keyof typeof COLOR_LABELS
const SCOPE_OPTIONS = [
  { value: 'local', label: 'Local' },
  { value: 'vault', label: 'Whole vault' }
]

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
  if (present.has(SAME_NAME)) m.set(SAME_NAME, '#e06c75')
  ;[...present]
    .filter((r) => !m.has(r))
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
      const key = edgeKey(e)
      if (!seen.has(key)) {
        seen.add(key)
        edges.push(e)
      }
    }
  }
  return {
    ...main,
    nodes: [...nodes.values()],
    edges,
    hasSources: main.hasSources || extras.some((graph) => graph.hasSources)
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const relLabel = (rel: string): string =>
  rel === RELATED ? '✨ related' : rel === SAME_NAME ? 'same name' : rel

type Gesture =
  | { kind: 'pan'; ox: number; oy: number; sx: number; sy: number; edgeKeys: string[] }
  | { kind: 'node'; node: GraphNode; ox: number; oy: number; sx: number; sy: number }

interface CanvasEdgePreview {
  keys: string[]
  anchor: Point
  choosing?: boolean
}

type Camera = MapView | { titleAnchor: Point }
const OVERVIEW: MapView = { x: 0, y: 0, k: 1 }

function cameraView(camera: Camera, cardFontSize: number, overview: MapView, width: number, height: number): MapView {
  if (camera === OVERVIEW) return overview
  if (!('titleAnchor' in camera)) return camera
  const k = 11 / cardFontSize
  const { x, y } = camera.titleAnchor
  return { x: width / 2 - x * k, y: height / 2 - y * k, k }
}

function MapGlyph({ theme, radius, className, fill }: {
  theme: boolean; radius: number; className: string; fill?: string
}) {
  const style = fill ? { fill } : undefined
  return theme
    ? <path className={className} d={`M0 ${-radius} L${radius} 0 L0 ${radius} L${-radius} 0 Z`} style={style} />
    : <circle className={className} r={radius} style={style} />
}

/**
 * The knowledge map — a force-directed, read-only view of an index slice. Drag a
 * node to arrange it, drag the background to pan, wheel to zoom, click a node to
 * open it. Colour the dots by cluster (links), by folder, or by meaning. Curate
 * the *view* (filter via the legend; right-click to hide a node) — never the notes.
 * With Talk to Docs enabled, Related adds dashed edges to similar unlinked notes.
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
  initialGlobal = false,
  runId,
  scopeLabel,
  scopeSlot,
  statusSlot,
  loadGraph = window.nodebook.graph,
  emptyMessage,
  defaultShowSources = false,
  showOriginOption = false,
  layoutPreference,
  onLayoutChange,
  active = true,
  themeMembers = false,
  collectionScope = false,
  readOnly = false
}: {
  focusPath: string | null
  focusName: string
  vaultRoot: string | null
  talkReady: boolean
  /** Recenter the map on a note (double-click / "Focus here"). */
  onOpen?: (path: string, trigger?: HTMLElement | SVGElement) => void
  /** Leave the map and open a note in the editor ("Open ↗"). */
  onOpenInEditor: (path: string, trigger: HTMLElement | SVGElement | undefined, node: Partial<Pick<GraphNode, 'source' | 'label'>>) => void
  onClose: () => void
  reloadKey?: number
  initialGlobal?: boolean
  runId?: string
  scopeLabel?: string
  /** Global status controls (theme, telemetry) rendered in the toolbar, so they
   *  persist across the editor and the map. */
  scopeSlot?: React.ReactNode
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
  /** Overlay maps start by colouring nodes by their staged or vault origin. */
  showOriginOption?: boolean
  layoutPreference: MapLayout
  onLayoutChange: (layout: MapLayout) => void
  /** Book maps stay mounted when hidden so their camera and selection survive. */
  active?: boolean
  /** A bounded theme slice with no source, local/depth or expansion controls. */
  themeMembers?: boolean
  /** A collection without local/global switching or a depth limit. */
  collectionScope?: boolean
  readOnly?: boolean
}): React.JSX.Element {
  const [semEdges, setSemEdges] = useState<{ source: string; target: string }[]>([])
  const [depth, setDepth] = useState(1)
  const [global, setGlobal] = useState(initialGlobal)
  const canSwitchScope = !!focusPath && !runId && !themeMembers && !collectionScope
  const isLocal = canSwitchScope && !global
  const [themesPane, setThemesPane] = useState<'unopened' | 'map' | 'themes'>('unopened')
  const themesButton = useRef<HTMLButtonElement>(null)
  const showVaultThemes = global && !runId && themesPane === 'themes'
  const mapActive = active && !showVaultThemes
  const restoreThemesButton = useRef(false)
  useLayoutEffect(() => {
    if (mapActive && restoreThemesButton.current) {
      restoreThemesButton.current = false
      themesButton.current?.focus()
    }
  }, [mapActive])
  const [cap, setCap] = useState(200) // global-view node cap; "show more" raises it
  const [showRelated, setShowRelated] = useState(true)
  // Session-only; the default depends on the view (see defaultShowSources).
  const [showSources, setShowSources] = useState(defaultShowSources)
  const mapScope = useMemo(() => ({ focusPath, global, depth, vaultRoot, runId, loadGraph }),
    [focusPath, global, depth, vaultRoot, runId, loadGraph])
  const sliceRequest = useMemo(() => ({ scope: mapScope, showSources }), [mapScope, showSources])
  const [slice, setSlice] = useState<{ request: typeof sliceRequest; graph: GraphData | null } | null>(null)
  const [pendingRequest, setPendingRequest] = useState<typeof sliceRequest | null>(null)
  const currentSlice = slice?.request === sliceRequest ? slice : null
  const base = currentSlice?.graph ?? null
  // Keep the toggle mounted and focused while its same-scope graph is fetched.
  const hasSources = slice?.request.scope === mapScope && slice.graph?.hasSources
  const loadPending = pendingRequest === sliceRequest
  const loadFailed = !!currentSlice && !currentSlice.graph && !loadPending
  const [expansions, setExpansions] = useState<{ scope: typeof mapScope; paths: Set<string> } | null>(null)
  const expanded = expansions?.scope === mapScope ? expansions.paths : NO_EXPANSIONS
  const relatedRequest = useMemo(() => talkReady && showRelated && isLocal && focusPath
    ? { focusPath, vaultRoot } : null, [talkReady, showRelated, isLocal, focusPath, vaultRoot])
  const [relatedResult, setRelatedResult] = useState<{ request: NonNullable<typeof relatedRequest>; neighbors: TalkNeighbor[] } | null>(null)
  const related = relatedResult?.request === relatedRequest ? relatedResult.neighbors : NO_RELATED
  const [colorMode, setColorMode] = useState<ColorMode>(showOriginOption ? 'origin' : 'links')
  if (colorMode === 'meaning' && !talkReady) setColorMode('links')
  const [layoutMode, setLayoutMode] = useState(layoutPreference)
  const [hiddenRels, setHiddenRels] = useState<Set<string>>(new Set())
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set())
  const [hiddenFolders, setHiddenFolders] = useState<Set<string>>(new Set())
  const [dragged, setDragged] = useState<Map<string, Point>>(new Map())
  const [pinned, setPinned] = useState<Map<string, Point>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [keyboardId, setKeyboardId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [edgePreview, setEdgePreview] = useState<CanvasEdgePreview | null>(null)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  const [focusedRow, setFocusedRow] = useState<string | null>(null)
  const [returnView, setReturnView] = useState<{ id: string; view: MapView } | null>(null)
  // Relation-typing: which outbound target is being named, and the typed-in name.
  const [typingTarget, setTypingTarget] = useState<string | null>(null)
  const [relInput, setRelInput] = useState('')
  const [camera, setCamera] = useState<Camera>(OVERVIEW)
  const [canvasSize, setCanvasSize] = useState({ width: W, height: H })
  const [forceReset, setForceReset] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const choiceRef = useRef<HTMLDivElement>(null)
  const lastEdgeHit = useRef<Point | null>(null)
  const lastPreviewMove = useRef<Point | null>(null)
  const preserveCameraOnFocus = useRef(false)
  const fitButton = useRef<HTMLButtonElement>(null)
  const markerPrefix = useId()
  const gesture = useRef<Gesture | null>(null)
  const movedRef = useRef(false)
  // Manual double-click detection (more reliable than onDoubleClick alongside
  // pointer-capture dragging): same node clicked twice within the threshold.
  const lastClick = useRef<{ id: string; t: number }>({ id: '', t: 0 })

  // Apply a new preference on the visible map. Each layout starts at its own
  // fit and clears unpinned hand placements.
  if (mapActive && layoutMode !== layoutPreference) {
    setLayoutMode(layoutPreference)
    setDragged(new Map())
    setCamera(OVERVIEW)
    setHoveredId(null)
    setEdgePreview(null)
    setReturnView(null)
  }

  useEffect(() => {
    let alive = true
    const { scope, showSources } = sliceRequest
    setPendingRequest(sliceRequest)
    void (async () => {
      const main = await scope.loadGraph(scope.global ? null : scope.focusPath, { depth: scope.depth, cap, showSources })
      const extras =
        expanded.size > 0
          ? await Promise.all([...expanded].map((p) => scope.loadGraph(p, { depth: 1, showSources })))
          : []
      if (alive) {
        setSlice({ request: sliceRequest, graph: extras.length ? mergeGraphs(main, extras) : main })
        setPendingRequest(null)
      }
    })().catch(() => {
      if (alive) {
        setSlice({ request: sliceRequest, graph: null })
        setPendingRequest(null)
      }
    })
    return () => {
      alive = false
    }
  }, [sliceRequest, cap, expanded, reloadKey])

  // Leaving/entering the global view resets the cap to its default.
  useEffect(() => setCap(200), [global, focusPath])

  useEffect(() => {
    if (!relatedRequest) return
    let alive = true
    void window.nodebook.talkNeighbors(relatedRequest.focusPath, 5).then((neighbors) => {
      if (alive) setRelatedResult({ request: relatedRequest, neighbors })
    }, () => {
      if (alive) setRelatedResult(null)
    })
    return () => {
      alive = false
    }
  }, [relatedRequest, reloadKey])

  useEffect(() => {
    setCamera(OVERVIEW)
    setHiddenNodes(new Set())
    setDragged(new Map())
    setSelectedId(null)
    setEdgePreview(null)
    setReturnView(null)
    gesture.current = null
    lastClick.current = { id: '', t: 0 }
  }, [mapScope])

  // Selecting a different node closes any open relation-typing input.
  useEffect(() => {
    setTypingTarget(null)
    setRelInput('')
    setEdgePreview(null)
    setHoveredRow(null)
    setFocusedRow(null)
  }, [selectedId])

  useEffect(() => {
    if (!mapActive) {
      setEdgePreview(null)
      setHoveredRow(null)
      setFocusedRow(null)
    }
  }, [mapActive])

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

  // Stored member → theme → document links read with the book at the top.
  const { labels, routed: routing, failed, arranging } = useRoutedLayout(
    layoutMode === 'elk' ? visible : null, W, H, defaultShowSources ? 'UP' : 'DOWN', mapActive
  )
  const routed = useMemo(() => routing && spaceRoutedLayers(routing, labels, canvasSize), [routing, labels, canvasSize])
  const isForce = layoutMode === 'force'
  const force = useForceLayout(
    isForce ? visible : null,
    JSON.stringify([global, focusPath, forceReset]), W, H, dragged, pinned, mapActive
  )

  const naturalLayout = useMemo(() => {
    if (!visible) return null
    const o = { width: W, height: H }
    if (layoutMode === 'tree') return dagreLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'elk') {
      if (routing) return routing.centres
      return failed ? dagreLayout(visible.nodes, visible.edges, o) : null
    }
    if (layoutMode === 'radial') return radialLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'groups') return groupsLayout(visible.nodes, visible.edges, o)
    if (layoutMode === 'blocks') return blocksLayout(visible.nodes, visible.edges, o)
    return force.positions
  }, [visible, layoutMode, force.positions, routing, failed])
  const layout = useMemo(() => {
    if (routed) return routed.centres
    if (naturalLayout && (layoutMode === 'tree' || failed)) return spaceTreeRanks(naturalLayout, canvasSize)
    return naturalLayout
  }, [routed, naturalLayout, layoutMode, failed, canvasSize])

  const hasCanvas = !!layout && !!visible?.nodes.length
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!hasCanvas || !svg) return
    const measure = ({ width, height }: Pick<DOMRect, 'width' | 'height'>): void => {
      if (width > 0 && height > 0) setCanvasSize((size) =>
        width === size.width && height === size.height ? size : { width, height }
      )
    }
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect))
    observer.observe(svg)
    measure(svg.getBoundingClientRect())
    return () => observer.disconnect()
  }, [hasCanvas])

  const { width, height } = canvasSize
  const routingScale = routed?.scale ?? 1
  const overview = useMemo(() => {
    if (!layout) return OVERVIEW
    if (!routed) return fitMapView(layout.values(), width, height)
    const extent = [...routed.routes.values()].flat(2)
    for (const [id, p] of layout) {
      const label = labels.get(id)!
      const rx = label.width * routingScale / 2
      const ry = label.height * routingScale / 2
      extent.push({ x: p.x - rx, y: p.y - ry }, { x: p.x + rx, y: p.y + ry })
    }
    return fitMapView(extent, width, height, Math.min(width / W, height / H))
  }, [layout, routed, labels, width, height, routingScale])

  const paths = useMemo(
    () => new Map([...(routed?.routes ?? [])].map(([key, sections]) => [key, {
      path: sectionPath(sections), sections, automatic: true as const
    }])),
    [routed]
  )
  const lanes = useMemo(() => routed && visible ? edgeLanes(visible.edges) : null, [routed, visible])

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
  const glyphRadius = (node: GraphNode): number =>
    mapGlyphRadius((pr.get(node.id) ?? 0) / maxPr, node.kind === 'theme')
  const posOf = useCallback((id: string): Point | undefined =>
    pinned.get(id) ?? dragged.get(id) ?? layout?.get(id), [pinned, dragged, layout])
  const positioned = useMemo(() => layout && visible ? visible.nodes.flatMap((node) => {
    const point = posOf(node.id)
    return point ? [{ node, point }] : []
  }) : [], [layout, visible, posOf])
  const nodesById = useMemo(() => new Map((visible?.nodes ?? []).map((node) => [node.id, node])), [visible])
  const manualRouting = useMemo(() => !!routed && !!visible?.nodes.some(({ id }) => {
    const placed = pinned.get(id) ?? dragged.get(id)
    const automatic = routed.centres.get(id)
    return placed && automatic && (placed.x !== automatic.x || placed.y !== automatic.y)
  }), [routed, visible, pinned, dragged])
  const markerIds = useMemo(() => new Map([...colors.keys()].map((relation, i) => [relation, `${markerPrefix}-${i}`])), [colors, markerPrefix])
  const idleMarkerId = `${markerPrefix}-idle`
  const drawnEdges = useMemo(() => (visible?.edges ?? []).flatMap((edge): DrawnEdge[] => {
    const a = posOf(edge.source)
    const b = posOf(edge.target)
    if (!a || !b) return []
    const key = edgeKey(edge)
    if (!routed) return [{ edge, key, geometry: { line: [a, b] } }]
    const automatic = !manualRouting && paths.get(key)
    const geometry = automatic || manualConnector(
      a, b, labels.get(edge.source)!, labels.get(edge.target)!, routingScale, lanes?.get(key) ?? 0
    )
    return [{ edge, key, geometry }]
  }), [visible, posOf, routed, manualRouting, paths, labels, routingScale, lanes])
  const cardFontSize = LABEL_FONT_SIZE * routingScale
  const view = useMemo(() => cameraView(camera, cardFontSize, overview, width, height),
    [camera, cardFontSize, overview, width, height])
  const viewport = useMemo<Viewport>(() => ({ ...canvasSize, scale: 1, x: 0, y: 0 }), [canvasSize])
  const pickNode = useMemo(() => {
    const scale = routingScale * view.k
    return nodePicker(positioned.map(({ node, point }) => {
      const label = routed && labels.get(node.id)
      return {
        id: node.id,
        center: project(point, view, viewport),
        card: label ? { halfWidth: label.width * scale / 2, halfHeight: label.height * scale / 2 } : undefined
      }
    }), viewport)
  }, [positioned, routingScale, routed, labels, view, viewport])
  const incidentDrawn = useMemo(() => selectedId ? drawnEdges.filter(({ edge }) =>
    edge.source === selectedId || edge.target === selectedId) : [], [drawnEdges, selectedId])
  const incidentEdges = useMemo(() => mapActive && selectedId
    ? projectIncidentEdges(incidentDrawn, selectedId, view, viewport) : [],
  [mapActive, selectedId, incidentDrawn, view, viewport])
  const incidentByKey = useMemo(() => new Map(incidentEdges.map((e) => [e.key, e])), [incidentEdges])
  const canvasEdges = (edgePreview?.keys ?? []).flatMap((key) => {
    const edge = incidentByKey.get(key)
    return edge ? [edge] : []
  })
  const rowEdge = incidentByKey.get(hoveredRow ?? (canvasEdges.length ? '' : focusedRow ?? ''))
  const tracedEdges = rowEdge ? [rowEdge] : canvasEdges
  const footprint = (node: GraphNode, v: MapView): NodeFootprint | undefined => {
    const p = posOf(node.id)
    if (!p) return
    const label = routed && labels.get(node.id)
    const scale = v.k * routingScale
    return {
      center: project(p, v, viewport),
      halfWidth: label ? Math.max(MAP_HIT_RADIUS, label.width * scale / 2) : MAP_HIT_RADIUS,
      halfHeight: label ? Math.max(MAP_HIT_RADIUS, label.height * scale / 2) : MAP_HIT_RADIUS
    }
  }
  const destinations = new Map<string, EdgeDestination>()
  for (const edge of tracedEdges) {
    const node = nodesById.get(edge.destination)
    const box = node && footprint(node, view)
    if (!node || !box) continue
    const group = destinations.get(node.id)
    if (group) group.edges.push(edge)
    else destinations.set(node.id, {
      node, edges: [edge], boundary: isClipped(box, viewport) ? boundaryPoint(edge, box, viewport) : undefined
    })
  }
  const previewDestinations = [...destinations.values()]
  const boundaryMarkers = new Map<string, EdgeDestination[]>()
  if (previewDestinations.length > 1) {
    for (const destination of previewDestinations) {
      const side = destination.boundary?.side
      if (!side) continue
      const group = boundaryMarkers.get(side)
      if (group) group.push(destination)
      else boundaryMarkers.set(side, [destination])
    }
  }
  const previewAnchor = edgePreview?.anchor ?? { x: viewport.width / 2, y: viewport.height / 2 }
  const labelVisible = cardFontSize * view.k >= 9
  const routedOverview = !!routed && !labelVisible
  const activeIds = useMemo(() => new Set([selectedId, focusedId, hoveredId].filter((id): id is string => !!id)),
    [selectedId, focusedId, hoveredId])
  const titleMetrics = useMemo(() => {
    if (!visible?.nodes.length) return null
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.font = `${MAP_LABEL_FONT}px ${getComputedStyle(document.documentElement).fontFamily}`
    const measure = (title: string): number => Math.ceil(ctx.measureText(title).width)
    const titles = [...visible.nodes].sort((a, b) =>
      Number(b.focus) - Number(a.focus) || Number(b.kind === 'theme') - Number(a.kind === 'theme') ||
      (pr.get(b.id) ?? 0) - (pr.get(a.id) ?? 0)
    ).map(({ id, label: title }) => ({ id, title, width: measure(title) }))
    return { titles, measure }
  }, [visible, pr])
  const cardScale = routingScale * view.k
  const screenTitles = titleMetrics && (!routed || routedOverview) ? placeMapTitles(
    titleMetrics.titles, activeIds, (id) => {
      const p = posOf(id)
      const node = nodesById.get(id)
      if (!p || !node) return
      const r = glyphRadius(node)
      const label = routed && labels.get(id)
      return {
        ...project(p, view, viewport),
        halfWidth: label ? Math.max(r, label.width * cardScale / 2) : r,
        halfHeight: label ? Math.max(r, label.height * cardScale / 2) : r
      }
    }, width, height, view.k / overview.k, titleMetrics.measure
  ) : []
  const nodeFill = (node: GraphNode): string | undefined => {
    if (node.ghost) return undefined
    if (colorMode === 'origin' && node.source) return ORIGINS[node.source].color
    if (colorMode === 'folder') return folderColors.get(folderOf(node.path, vaultRoot))
    if (colorMode === 'meaning') return communityColor(meaningCluster.get(node.id) ?? 0)
    return communityColor(comm.get(node.id) ?? 0)
  }
  const filtered = hiddenRels.size + hiddenNodes.size + hiddenFolders.size
  const modes: ColorMode[] = ['links', 'folder']
  if (talkReady) modes.push('meaning')
  if (showOriginOption) modes.push('origin')

  const fromScreen = (x: number, y: number): DOMPoint | undefined => {
    const matrix = svgRef.current?.getScreenCTM()
    return matrix ? new DOMPoint(x, y).matrixTransform(matrix.inverse()) : undefined
  }

  const zoomAt = (p: Point, factor: number): void => {
    setEdgePreview(null)
    setCamera((camera) => {
      const v = cameraView(camera, cardFontSize, overview, width, height)
      const zoomLimit = Math.max(overview.k * 10, routed ? 16 / cardFontSize : 0)
      const k = clamp(v.k * factor, Math.min(v.k, overview.k * 0.25), Math.max(v.k, zoomLimit))
      if (k === v.k) return camera
      const r = k / v.k
      return { k, x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r }
    })
  }
  const onWheel = (e: React.WheelEvent): void => {
    const point = fromScreen(e.clientX, e.clientY)
    if (point) zoomAt(point, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  }
  const fitView = (): void => {
    setEdgePreview(null)
    if (!dragged.size && !pinned.size) {
      setCamera(OVERVIEW)
      return
    }
    const extent = positioned.flatMap(({ node, point }) => {
      const rect = routed && labels.get(node.id)
      if (!rect) return [point]
      const rx = rect.width * routingScale / 2
      const ry = rect.height * routingScale / 2
      return [{ x: point.x - rx, y: point.y - ry }, { x: point.x + rx, y: point.y + ry }]
    })
    for (const { geometry } of drawnEdges) {
      if ('points' in geometry) extent.push(...geometry.points)
      if ('sections' in geometry) extent.push(...geometry.sections.flat())
    }
    setCamera(fitMapView(extent, width, height))
  }
  const canvasPointer = ({ clientX, clientY }: Pick<React.MouseEvent, 'clientX' | 'clientY'>): Point | undefined => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect && { x: clientX - rect.left, y: clientY - rect.top }
  }
  const reachesPreview = (p: Point, previous?: Point): boolean => {
    if (!edgePreview) return false
    const canvas = canvasRef.current?.getBoundingClientRect()
    const rect = choiceRef.current?.getBoundingClientRect()
    if (!canvas || !rect) return false
    const pointer = { x: canvas.left + p.x, y: canvas.top + p.y }
    const hit = lastEdgeHit.current ?? edgePreview.anchor
    const anchor = { x: canvas.left + hit.x, y: canvas.top + hit.y }
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (previous) {
      const before = { x: canvas.left + previous.x, y: canvas.top + previous.y }
      // A steady approach may pass across a card or another stroke to the same destination.
      if (distance(p, previous) > 24 || distance(pointer, center) >= distance(before, center)) return false
    }
    const nearest = { x: clamp(pointer.x, rect.left, rect.right), y: clamp(pointer.y, rect.top, rect.bottom) }
    if (distance(pointer, nearest) <= 12) return true
    // Allow a direct move from the last stroke hit to the control even when the route bends.
    return distance(pointer, nearestPoint(pointer, [anchor, center])) <= 12
  }
  const updateEdgePreview = (e: React.PointerEvent, p: Point, onNode: boolean): void => {
    if (!incidentEdges.length || edgePreview?.choosing || e.pointerType === 'touch') return
    const previous = lastPreviewMove.current
    lastPreviewMove.current = p
    const edges = onNode ? [] : hitEdges(incidentEdges, p)
    const keys = edges.map(({ key }) => key)
    if (!keys.length && !edgePreview) return
    if (edgePreview?.keys.length === keys.length && edgePreview.keys.every((key, i) => key === keys[i])) {
      lastEdgeHit.current = p
      return
    }
    if (!onNode && !keys.length && reachesPreview(p)) return
    const rim = previewDestinations.length === 1 && previewDestinations[0].boundary ? previewDestinations[0].node.id : null
    const sameDestination = edges.length > 0 && edges.every(({ destination }) => destination === rim)
    if (rim && previous && (onNode || sameDestination) && reachesPreview(p, previous)) return
    if (keys.length) lastEdgeHit.current = p
    setEdgePreview(keys.length ? { keys, anchor: p } : null)
  }
  const onCanvasPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const p = canvasPointer(e)
    if (!p) return
    const id = pickNode(p)
    const node = id ? nodesById.get(id) : undefined
    const centre = node && posOf(node.id)
    const start = { sx: e.clientX, sy: e.clientY }
    if (node && centre) {
      setEdgePreview(null)
      setKeyboardId(node.id)
      if ((e.target as Element).closest('.graph-node')?.getAttribute('data-node-id') !== node.id) {
        e.preventDefault()
        focusGraphNode(node.id, false)
      }
      gesture.current = { kind: 'node', node, ox: centre.x, oy: centre.y, ...start }
    } else {
      const edgeKeys = hitEdges(incidentEdges, p).map(({ key }) => key)
      gesture.current = { kind: 'pan', ox: view.x, oy: view.y, edgeKeys, ...start }
    }
    movedRef.current = false
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const onCanvasContextMenu = (e: React.MouseEvent): void => {
    const p = canvasPointer(e)
    const id = e.button === 2 && p ? pickNode(p) : (e.target as Element).closest('.graph-node')?.getAttribute('data-node-id')
    const node = id ? nodesById.get(id) : undefined
    if (!node) return
    e.preventDefault()
    if (!node.focus) {
      setHoveredId(null)
      setHiddenNodes((s) => new Set(s).add(node.id))
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) {
      const p = canvasPointer(e)
      if (p && e.pointerType !== 'touch') {
        const id = pickNode(p)
        setHoveredId(id ?? null)
        updateEdgePreview(e, p, !!id)
      }
      return
    }
    if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 3) movedRef.current = true
    if (!movedRef.current) return
    setEdgePreview(null)
    const start = fromScreen(g.sx, g.sy)
    const current = fromScreen(e.clientX, e.clientY)
    if (!start || !current) return
    const dx = current.x - start.x
    const dy = current.y - start.y
    if (g.kind === 'pan') {
      setCamera({ k: view.k, x: g.ox + dx, y: g.oy + dy })
    } else if (!pinned.has(g.node.id)) {
      setDragged((m) => new Map(m).set(g.node.id, { x: g.ox + dx / view.k, y: g.oy + dy / view.k }))
    }
  }

  const showKeyboardNode = (id: string): void => {
    const node = nodesById.get(id)
    if (!node) return
    setCamera((camera) => {
      const v = cameraView(camera, cardFontSize, overview, width, height)
      const box = footprint(node, v)
      if (!box || !isClipped(box, viewport)) return camera
      const shift = revealShift(box, viewport)
      return { ...v, x: v.x + shift.x, y: v.y + shift.y }
    })
  }
  const keyboardEntry = positioned.find(({ node }) => node.id === keyboardId)?.node.id
    ?? positioned.find(({ node }) => node.focus)?.node.id ?? positioned[0]?.node.id
  const graphNodeElement = (id: string): SVGGElement | undefined =>
    svgRef.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? undefined
  const focusGraphNode = (id: string, reveal = true): void => {
    const target = graphNodeElement(id)
    if (target) {
      setKeyboardId(id)
      preserveCameraOnFocus.current = !reveal
      target.focus({ preventScroll: true })
      preserveCameraOnFocus.current = false
    }
  }
  const selectNode = (id: string | null): void => {
    setEdgePreview(null)
    setReturnView(null)
    setSelectedId(id)
  }
  const followDestination = (id: string): void => {
    const node = nodesById.get(id)
    if (!node || !selectedId || id === selectedId) return
    const box = footprint(node, view)
    if (!box) return
    const shift = revealShift(box, viewport)
    setEdgePreview(null)
    setHoveredRow(null)
    setFocusedRow(null)
    setReturnView({ id: selectedId, view })
    if (shift.x || shift.y) setCamera({ ...view, x: view.x + shift.x, y: view.y + shift.y })
    setSelectedId(id)
    lastClick.current = { id: '', t: 0 }
    focusGraphNode(id, false)
  }
  const returnToNote = (): void => {
    if (!returnView) return
    setCamera(returnView.view)
    selectNode(returnView.id)
    focusGraphNode(returnView.id, false)
  }
  const dismissEdgePreview = (): void => {
    setEdgePreview(null)
    if (selectedId) focusGraphNode(selectedId, false)
  }
  const choosingEdge = !!edgePreview?.choosing
  const onMapKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || (!edgePreview && !rowEdge)) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.graph-canvas-host, .graph-inspector') ||
        target.closest('input, textarea, select, [contenteditable], dialog, [role="dialog"], [role="alertdialog"], [role="menu"]')) return
    event.preventDefault()
    event.stopPropagation()
    setHoveredRow(null)
    setFocusedRow(null)
    if (choosingEdge || target.closest('.graph-edge-preview')) dismissEdgePreview()
    else setEdgePreview(null)
  }
  useLayoutEffect(() => {
    if (choosingEdge) choiceRef.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [choosingEdge])
  const zoomToTitles = (): void => {
    const anchor = positioned.find(({ node }) => node.id === selectedId)
      ?? positioned.find(({ node }) => node.id === keyboardId)
      ?? positioned.find(({ node }) => node.focus || node.kind === 'document')
      ?? positioned[0]
    if (!anchor) return
    focusGraphNode(anchor.node.id)
    // Keep the title size as the window and toolbar settle after a resize.
    setCamera({ titleAnchor: anchor.point })
  }
  const onNodeKeyDown = (event: React.KeyboardEvent<SVGGElement>, node: GraphNode): void => {
    if (['+', '=', '-'].includes(event.key) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      const point = posOf(node.id)
      if (point) zoomAt({ x: view.x + point.x * view.k, y: view.y + point.y * view.k }, event.key === '-' ? 1 / 1.12 : 1.12)
      return
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (event.repeat) return
      if (event.key === 'Enter' && node.path) onOpenInEditor(node.path, event.currentTarget, node)
      else selectNode(node.id)
      return
    }
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!next && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return
    if (!positioned.length) return
    event.preventDefault()
    const at = positioned.findIndex((item) => item.node.id === node.id)
    const id = positioned[(at + positioned.length + (next ? 1 : -1)) % positioned.length].node.id
    showKeyboardNode(id)
    focusGraphNode(id)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const g = gesture.current
    gesture.current = null
    // An edge starts as a pan gesture so moving the pointer still drags the map.
    if (g?.kind === 'pan' && !movedRef.current) {
      const p = canvasPointer(e)
      const hits = g.edgeKeys.flatMap((key) => {
        const edge = incidentByKey.get(key)
        return edge ? [edge] : []
      })
      const ids = new Set(hits.map(({ destination }) => destination))
      if (ids.size === 1) followDestination([...ids][0])
      else if (ids.size > 1 && p) setEdgePreview({ keys: hits.map(({ key }) => key), anchor: p, choosing: true })
      else selectNode(null)
      return
    }
    if (g?.kind !== 'node' || movedRef.current) return
    // A plain click selects (fills the inspector, view unchanged); a second click
    // on the same node within the threshold refocuses the map on it. Navigation
    // is the secondary gesture — never a single click.
    const now = performance.now()
    const isDouble = lastClick.current.id === g.node.id && now - lastClick.current.t < 350
    if (isDouble && g.node.path) {
      const trigger = graphNodeElement(g.node.id)
      if (onOpen) {
        setGlobal(false)
        onOpen(g.node.path, trigger)
        selectNode(null)
      } else {
        onOpenInEditor(g.node.path, trigger, g.node)
      }
      lastClick.current = { id: '', t: 0 }
    } else {
      selectNode(g.node.id)
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
    if (camera === OVERVIEW) setCamera(view)
    setExpansions((current) => {
      const next = new Set(current?.scope === mapScope ? current.paths : NO_EXPANSIONS)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { scope: mapScope, paths: next }
    })
  }

  // Pin a node at its current spot so it anchors the layout; unpin to release it.
  const togglePin = (id: string): void => {
    if (camera === OVERVIEW) setCamera(view)
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
  // The diamond only earns a line in the key when there is one on the map.
  const hasThemes = (visible?.nodes ?? []).some((n) => n.kind === 'theme')
  const legend: [string, string][] = byFolder ? [...folderColors.entries()] : [...colors.entries()]
  const hidden = byFolder ? hiddenFolders : hiddenRels
  const setHidden = byFolder ? setHiddenFolders : setHiddenRels

  // Inspector stats.
  const nodeCount = visible?.nodes.length ?? 0
  const cappedTotal = base?.total !== undefined && base.total > base.nodes.length ? base.total : null
  const edgeCount = visible?.edges.length ?? 0
  const clusterCount = byFolder
    ? folderColors.size
    : new Set([...(colorMode === 'meaning' ? meaningCluster : comm).values()]).size

  // Node ids are paths, but everything the user reads or writes is the note
  // *name* — so edge endpoints are shown, and links are written, through this.
  const labelOf = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n.label])), [data])
  const nameOf = (id: string): string => labelOf.get(id) ?? id

  // The selected node's details (its edges in the current slice) for the inspector.
  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null
  const previewPath = selectedNode?.path
  const previewRun = selectedNode?.source === 'vault' ? undefined : runId
  const [preview, setPreview] = useState<{ path: string; run?: string; text: string } | null>(null)
  useEffect(() => {
    if (!mapActive || !previewPath) return
    let live = true
    void window.nodebook.notePreview(previewPath, previewRun).then((text) => {
      if (live) setPreview({ path: previewPath, run: previewRun, text })
    }, () => { if (live) setPreview(null) })
    return () => { live = false }
  }, [mapActive, previewPath, previewRun, reloadKey])
  const selectedPreview = preview && preview.path === previewPath && preview.run === previewRun ? preview.text : ''
  const linkedNote = (edge: GraphEdge, id: string): React.JSX.Element => incidentByKey.has(edgeKey(edge)) ? (
    <button className="graph-insp-target graph-insp-link" type="button"
      title={`Inspect ${nameOf(id)} on the map`}
      onClick={() => followDestination(id)}>
      {nameOf(id)}
    </button>
  ) : <span className="graph-insp-target">{nameOf(id)}</span>
  const traceInspectorRow = (edge: GraphEdge): React.HTMLAttributes<HTMLDivElement> => {
    const key = edgeKey(edge)
    if (!incidentByKey.has(key)) return {}
    return {
      onPointerEnter: () => setHoveredRow(key),
      onPointerLeave: () => setHoveredRow((current) => current === key ? null : current),
      onFocus: () => {
        setHoveredRow(null)
        setEdgePreview(null)
        setFocusedRow(key)
      },
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedRow((current) => current === key ? null : current)
        }
      }
    }
  }
  const describeEdge = ({ edge }: IncidentEdge): string => {
    const direction = edge.relation === RELATED || edge.relation === SAME_NAME ? 'Undirected'
      : edge.source === selectedId ? 'Outgoing' : 'Incoming'
    return `${direction} ${relLabel(edge.relation).replaceAll('_', ' ')}`
  }
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

  const footer = (
    <span className="graph-toolbar-right">
      {statusSlot}
      <button className="graph-close" type="button" onClick={onClose}>✕ Close</button>
    </span>
  )

  return (
    <>
    <div className="graph-view" hidden={showVaultThemes} onKeyDown={onMapKeyDown}>
      <div className="graph-main">
        {(!runId || cappedTotal !== null) && (
          <div className="graph-scope" aria-label={scopeLabel}>
            {!runId && <strong>{global ? 'Whole vault' : focusName || 'Note map'}</strong>}
            {cappedTotal !== null && (
              <span>Showing {nodeCount.toLocaleString()} of {cappedTotal.toLocaleString()} nodes</span>
            )}
          </div>
        )}
        {visible && layout && visible.nodes.length > 0 ? (
          <div className="graph-canvas-host" ref={canvasRef}
            onPointerLeave={() => { if (!choosingEdge) setEdgePreview(null) }}>
          <svg
            ref={svgRef}
            className={`graph-canvas${isForce ? ' graph-canvas-force' : ''}${routedOverview ? ' graph-routed-overview' : ''}${edgePreview && !choosingEdge ? ' is-edge-hover' : ''}`}
            role="group"
            aria-label="Knowledge map notes"
            aria-busy={isForce && (loadPending || force.arranging) ? true : undefined}
            data-layout={routed ? (manualRouting ? 'manual' : 'routed') : failed ? 'fallback' : layoutMode}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            onWheel={onWheel}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoveredId(null)}
            onContextMenu={onCanvasContextMenu}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { gesture.current = null }}
            onLostPointerCapture={() => { gesture.current = null }}
          >
            {routed && (
              <defs>
                {[[null, idleMarkerId] as const, ...markerIds].map(([relation, id]) => (
                  <marker
                    key={id} id={id} viewBox="0 0 6 6"
                    markerWidth={6 / view.k} markerHeight={6 / view.k}
                    markerUnits="userSpaceOnUse" refX="6" refY="3" orient="auto"
                  >
                    <path d="M0 0 L6 3 L0 6 Z" fill={relation ? colors.get(relation) : 'var(--muted)'} />
                  </marker>
                ))}
              </defs>
            )}
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {drawnEdges.map(({ edge: e, key, geometry }) => {
                const related = e.relation === RELATED
                const sameName = e.relation === SAME_NAME
                const incident = activeIds.has(e.source) || activeIds.has(e.target)
                const className = 'graph-edge'
                  + (related ? ' graph-edge-related' : '')
                  + (sameName ? ' graph-edge-samename' : '')
                  + (incident ? ' is-incident' : activeIds.size ? ' is-dim' : '')
                const stroke = (incident && colors.get(e.relation)) || 'var(--muted)'
                if ('line' in geometry) {
                  const [a, b] = geometry.line
                  return <line key={key} className={className}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={stroke}
                    vectorEffect="non-scaling-stroke"
                    data-edge-key={key}
                  />
                }
                const arrow = !related && !sameName &&
                  (incident ? markerIds.get(e.relation) : !routedOverview && !activeIds.size && idleMarkerId)
                return <path
                  key={key}
                  className={`${className} graph-edge-path`}
                  d={geometry.path}
                  stroke={stroke}
                  vectorEffect="non-scaling-stroke"
                  markerEnd={arrow ? `url(#${arrow})` : undefined}
                  data-edge-key={key}
                  data-automatic={'automatic' in geometry ? 'true' : undefined}
                />
              })}
              <g pointerEvents="none" aria-hidden="true">
                {tracedEdges.map(({ key, geometry }) => {
                  const props = {
                    className: 'graph-edge-trace',
                    'data-trace-edge-key': key,
                    vectorEffect: 'non-scaling-stroke'
                  }
                  if ('path' in geometry) return <path key={key} d={geometry.path} {...props} />
                  const [a, b] = geometry.line
                  return <line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...props} />
                })}
              </g>
              {positioned.map(({ node, point: p }) => {
                const cls = `graph-node${node.focus ? ' is-focus' : ''}${node.ghost ? ' is-ghost' : ''}${node.id === selectedId ? ' is-selected' : ''}${node.id === hoveredId ? ' is-hovered' : ''}${pinned.has(node.id) ? ' is-pinned' : ''}${destinations.has(node.id) ? ' is-edge-destination' : ''}`
                const fill = nodeFill(node)
                const label = routed && labels.get(node.id)
                const r = glyphRadius(node)
                const theme = node.kind === 'theme'
                return (
                  <g
                    key={node.id}
                    className={`${cls}${isForce ? ' graph-force-node' : ''}${label ? ' graph-elk-node' : ''}`}
                    transform={`translate(${p.x},${p.y})${label ? ` scale(${routingScale})` : ''}`}
                    data-node-id={node.id}
                    tabIndex={node.id === keyboardEntry ? 0 : -1}
                    role="button"
                    aria-label={node.label}
                    aria-description={node.source ? ORIGINS[node.source].label : undefined}
                    aria-pressed={node.id === selectedId}
                    onKeyDown={(ev) => onNodeKeyDown(ev, node)}
                    onFocus={(ev) => {
                      if (ev.currentTarget.matches(':focus-visible')) {
                        setKeyboardId(node.id)
                        setFocusedId(node.id)
                        if (!preserveCameraOnFocus.current) showKeyboardNode(node.id)
                      }
                    }}
                    onBlur={() => setFocusedId((id) => id === node.id ? null : id)}
                  >
                    <desc>{node.label}</desc>
                    {label ? (
                      <>
                        <rect
                          className="graph-note-hit"
                          x={-Math.max(label.width / 2, MAP_HIT_RADIUS / cardScale)}
                          y={-Math.max(label.height / 2, MAP_HIT_RADIUS / cardScale)}
                          width={Math.max(label.width, 2 * MAP_HIT_RADIUS / cardScale)}
                          height={Math.max(label.height, 2 * MAP_HIT_RADIUS / cardScale)}
                        />
                        <rect
                          className="graph-note-box"
                          x={-label.width / 2} y={-label.height / 2}
                          width={label.width} height={label.height} rx={3}
                          vectorEffect="non-scaling-stroke"
                        />
                        <g transform={routedOverview ? `scale(${1 / cardScale})` : `translate(${12 - label.width / 2},0)`}>
                          <MapGlyph theme={theme} radius={r} className="graph-note-glyph" fill={fill} />
                        </g>
                        {labelVisible && label.lines.map((text, i) => (
                          <text
                            key={i} x={24 - label.width / 2}
                            y={5 + LABEL_LINE_HEIGHT * (i - (label.lines.length - 1) / 2)}
                            style={{ fontSize: LABEL_FONT_SIZE }}
                          >{text}</text>
                        ))}
                      </>
                    ) : (
                      <g transform={`scale(${1 / view.k})`}>
                        <circle className={isForce ? 'graph-point-hit graph-force-hit' : 'graph-point-hit'} r={MAP_HIT_RADIUS} />
                        <MapGlyph theme={theme} radius={r} fill={fill}
                          className={isForce ? 'graph-point-dot graph-force-dot' : 'graph-point-dot'} />
                      </g>
                    )}
                  </g>
                )
              })}
            </g>
            {screenTitles.length > 0 && (
              <g pointerEvents="none" aria-hidden="true">
                {screenTitles.map(({ id, lines, active, x, y, width, height }) => (
                  <g key={id} className={`graph-screen-label${isForce ? ' graph-force-label' : routed ? ' graph-routed-label' : ''}${active ? ' is-active' : ''}`} data-label-id={id}>
                    {active && <rect x={x} y={y} width={width} height={height} rx={3} />}
                    <text x={x + width / 2} y={y + 13} fontSize={MAP_LABEL_FONT}>
                      {lines.map((line, i) => <tspan key={i} x={x + width / 2} dy={i ? MAP_LABEL_LINE : 0}>{line}</tspan>)}
                    </text>
                  </g>
                ))}
              </g>
            )}
          </svg>
          {(edgePreview || previewDestinations.some(({ boundary }) => boundary)) && previewDestinations.length > 0 && (
            <GraphEdgePreview anchor={previewAnchor} destinations={previewDestinations} viewport={viewport}
              describe={describeEdge} follow={followDestination} choiceRef={choiceRef}
              closeChoice={choosingEdge ? () => setEdgePreview(null) : undefined} />
          )}
          {[...boundaryMarkers].map(([side, group]) => (
            <GraphEdgePreview key={side} anchor={previewAnchor} destinations={group} viewport={viewport}
              describe={describeEdge} boundaryMarker />
          ))}
          </div>
        ) : (
          <div className="graph-empty" role="status">
            {loadFailed ? 'Could not load this map.' : arranging || force.arranging ? 'Arranging map…' : data
              ? (emptyMessage ??
                'Nothing to show — clear the filters, or add a [[link]] to this note.')
              : 'Loading…'}
          </div>
        )}

        <div className="graph-toolbar">
          <div className="graph-controls">
            {scopeSlot}
            {canSwitchScope && (
              <StatusSelect
                kind="vault-scope"
                prefix="Scope: "
                title="Map scope"
                value={global ? 'vault' : 'local'}
                options={SCOPE_OPTIONS}
                onChange={(scope) => setGlobal(scope === 'vault')}
              />
            )}
            {global && !runId && vaultRoot && <button className="graph-ctl" type="button" ref={themesButton}
              onClick={() => setThemesPane('themes')}>Themes</button>}
            {isLocal && (
              <span className="graph-depth">
                <button
                  className="graph-ctl"
                  type="button"
                  aria-label="Decrease depth"
                  disabled={depth <= 1}
                  onClick={() => setDepth((d) => Math.max(1, d - 1))}
                >
                  −
                </button>
                Depth {depth}
                <button
                  className="graph-ctl"
                  type="button"
                  aria-label="Increase depth"
                  disabled={depth >= 3}
                  onClick={() => setDepth((d) => Math.min(3, d + 1))}
                >
                  +
                </button>
              </span>
            )}
            <StatusSelect
              kind="colour"
              prefix="Colour: "
              title="Colour the dots by…"
              value={colorMode}
              options={modes.map((mode) => ({ value: mode, label: COLOR_LABELS[mode] }))}
              onChange={(value) => setColorMode(value as ColorMode)}
            />
            <StatusSelect
              kind="layout"
              prefix="Layout: "
              title="Map layout"
              value={layoutMode}
              options={MAP_LAYOUT_OPTIONS}
              onChange={(value) => {
                if (isMapLayout(value)) onLayoutChange(value)
              }}
            />
            {talkReady && isLocal && (
              <button
                className={`graph-ctl${showRelated ? ' is-on' : ''}`}
                type="button"
                aria-pressed={showRelated}
                title="Show semantically-related (but unlinked) notes"
                onClick={() => setShowRelated((s) => !s)}
              >
                Related<span aria-hidden="true">: {showRelated ? 'on' : 'off'}</span>
              </button>
            )}
            {!themeMembers && hasSources && (
              <button
                className={`graph-ctl${showSources ? ' is-on' : ''}`}
                type="button"
                aria-pressed={showSources}
                title="Show source documents on this map"
                onClick={() => setShowSources((s) => !s)}
              >
                Source<span aria-hidden="true">: {showSources ? 'on' : 'off'}</span>
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
            <span className="graph-zoom">
              <button className="graph-ctl" type="button" aria-label="Zoom out" title="Zoom out" disabled={!hasCanvas}
                onClick={() => zoomAt({ x: width / 2, y: height / 2 }, 1 / 1.12)}>−</button>
              <button className="graph-ctl" type="button" aria-label="Zoom in" title="Zoom in" disabled={!hasCanvas}
                onClick={() => zoomAt({ x: width / 2, y: height / 2 }, 1.12)}>+</button>
              <button className="graph-ctl" type="button" ref={fitButton} onClick={fitView} disabled={!hasCanvas}>
                Fit view
              </button>
            </span>
            {(dragged.size > 0 || pinned.size > 0) && (
              <button
                className="graph-ctl"
                type="button"
                title="Clear dragged positions and pins, then fit the view"
                onClick={() => {
                  fitButton.current?.focus()
                  setCamera(OVERVIEW)
                  setDragged(new Map())
                  setPinned(new Map())
                  if (isForce) setForceReset((n) => n + 1)
                }}
              >
                Clear placements
              </button>
            )}
            {failed && <span role="status">Routing unavailable. Showing tree layout.</span>}
            {manualRouting && <span role="status">Manual placement</span>}
            {isForce && hasCanvas && (loadPending || force.arranging) && <span role="status">Updating map…</span>}
            {force.degraded && <span role="status">Showing an approximate Force layout.</span>}
            {routed && !labelVisible && (
              <button className="graph-ctl" onClick={zoomToTitles}>Zoom to titles</button>
            )}
          </div>
          {!showVaultThemes && footer}
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
              {selectedNode.source && `${ORIGINS[selectedNode.source].label} · `}
              {selectedNode.ghost
                ? 'Referenced, not yet created'
                : `${selOut.length} out · ${selIn.length} in`}
            </div>
            {selectedPreview && <p className="graph-insp-excerpt">{selectedPreview}</p>}
            {selectedNode.aliases && selectedNode.aliases.length > 0 && (
              <div className="graph-insp-aliases" title="Notes you confirmed are the same thing">
                also known as {selectedNode.aliases.join(', ')}
              </div>
            )}
            <div className="graph-insp-actions">
              {selectedNode.path && (
                <>
                  {onOpen && <button
                    className="graph-ctl"
                    title="Recenter the map on this note"
                    onClick={() => {
                      setGlobal(false)
                      onOpen(selectedNode.path!, graphNodeElement(selectedNode.id))
                      selectNode(null)
                    }}
                  >
                    Focus here
                  </button>}
                  <button
                    className="graph-ctl"
                    title={onOpen ? 'Open this note in the editor' : 'Open this note'}
                    onClick={(event) => onOpenInEditor(selectedNode.path!, event.currentTarget, selectedNode)}
                  >
                    Open ↗
                  </button>
                </>
              )}
              {!themeMembers && !selectedNode.focus && selectedNode.path && (
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
              {returnView && nodesById.has(returnView.id) && (
                <button className="graph-ctl" title={`Return to ${nameOf(returnView.id)} and its map view`}
                  onClick={returnToNote}>
                  Back to previous note
                </button>
              )}
              <button className="graph-ctl" onClick={() => selectNode(null)}>
                Deselect
              </button>
            </div>
            {selOut.length > 0 && (
              <div className="graph-insp-section">
                <div className="graph-insp-label">Links out</div>
                {selOut.map((e, i) => {
                  const typeable = !readOnly && !themeMembers && selectedNode.source !== 'run' &&
                    e.relation === 'links_to' && !!selectedNode.path && incidentByKey.has(edgeKey(e))
                  return (
                    <div key={`o${i}`} className="graph-insp-edge" data-inspector-edge-key={edgeKey(e)} {...traceInspectorRow(e)}>
                      <span className="graph-insp-rel">{relLabel(e.relation)}</span>
                      {linkedNote(e, e.target)}
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
                  <div key={`i${i}`} className="graph-insp-edge" data-inspector-edge-key={edgeKey(e)} {...traceInspectorRow(e)}>
                    <span className="graph-insp-rel">{relLabel(e.relation)}</span>
                    {linkedNote(e, e.source)}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {(global || focusName || themeMembers) && (
              <div className="graph-insp-title">{global ? 'Whole vault' : focusName || 'Theme members'}</div>
            )}
            <div className="graph-insp-stat">
              {nodeCount} {nodeCount === 1 ? 'note' : 'notes'} · {edgeCount}{' '}
              {edgeCount === 1 ? 'link' : 'links'}
              {colorMode !== 'origin' && clusterCount > 1 ? ` · ${clusterCount} clusters` : ''}
            </div>
            {cappedTotal !== null && (
              <div className="graph-insp-more">
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
            {hasThemes && (
              <div className="graph-insp-note graph-shape-key">
                <span className="graph-shape-theme" aria-hidden="true" />
                theme — a group of notes
              </div>
            )}
            {colorMode === 'origin' && nodeCount > 0 && (
              <div className="graph-insp-section">
                {Object.values(ORIGINS).map(({ label, color }) => (
                  <div className="graph-insp-note graph-shape-key" key={label}>
                    <span className="graph-legend-dot" style={{ background: color }} aria-hidden="true" />
                    {label}
                  </div>
                ))}
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
              Click to inspect · double-click to {onOpen ? 'focus' : 'open'} · right-click to hide.
              On the keyboard, use arrows to move, Space to inspect and Enter to open.
            </p>
          </>
        )}
      </aside>
    </div>
    {global && !runId && vaultRoot && themesPane !== 'unopened' && (
      <VaultThemes active={active && showVaultThemes} vault={vaultRoot} revision={reloadKey ?? 0}
        footer={showVaultThemes ? footer : null}
        onOpenNote={(path, trigger) => onOpenInEditor(path, trigger, { source: 'vault' })}
        onNoteMap={() => {
          restoreThemesButton.current = true
          setThemesPane('map')
        }}
      />
    )}
    </>
  )
}
