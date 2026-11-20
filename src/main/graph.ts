import { targetResolver } from '../shared/markdown/resolveTarget'
import type { GraphData, GraphEdge, GraphNode, NoteKind } from '../shared/types'

/**
 * Build a slice of the knowledge graph from the index's raw rows — pure and
 * DOM/DB-free so it is golden-tested in isolation.
 *
 * **Identity is the file path.** A real note's node id is its stored path, so two
 * notes that happen to share a name are two dots, not one; the *label* stays the
 * note name. A link target with no file is a "ghost", id `ghost:<target>`.
 * Because a link names a note but a node is a file, resolving a target can be
 * ambiguous — `ambiguousTargets` counts the targets that could have meant more
 * than one note, so the UI can say so instead of quietly guessing.
 *
 * The one exception to "one file, one node" is a CONFIRMED alias. A merge writes
 * `same_as:: [[Original]]` into a note only when the user ticked "same as the
 * existing note" in the merge dialog, and that is the signal this module honours:
 * the note is folded into the one it names, its edges are re-pointed there, and
 * the name it used to answer to is kept as an `alias` on the surviving node. An
 * unconfirmed name clash stays two dots — a clash is not evidence of identity.
 *
 * `focus` (a note *path*) gives a local depth-`d` neighbourhood; `null` gives the
 * whole graph capped to the highest-degree nodes. Edges in the result always
 * have both endpoints present (no dangling references).
 *
 * A note's `kind` (frontmatter, via the index) rides along on its node so the
 * map can draw a book or a theme differently. One kind also changes the graph
 * itself: a `kind: document` note is a whole book, so it is left out of the
 * global degree ranking — see the ranking branch below.
 */

export interface FileRow {
  path: string
  title: string | null
  /** The note's declared `kind:` (see harvest's `frontmatterKind`). Absent in
   *  rows from an index that predates the column — read as `note`. */
  kind?: NoteKind | null
}

export interface TripleRow {
  /** The subject's note name, as harvested. Kept for the triple store's own
   *  sake; the graph keys the subject node by `source_file` (identity is path). */
  subject: string
  relation: string
  object: string
  /** The file the triple was harvested from — the subject node's identity. */
  source_file: string
}

/** Prefix marking a node that is linked to but has no file behind it. */
const GHOST = 'ghost:'
/** Synthetic overlay relation: the same note name on both sides (see `overlayGraph`). */
export const SAME_NAME = 'same_name'
/** The body field a merge writes when the user confirmed two notes are one thing. */
export const SAME_AS = 'same_as'
export const DEFAULT_GRAPH_CAP = 200

/** Base note name from a path: strip directories and the `.md` extension. */
export function noteName(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).replace(/\.md$/i, '')
}

/** The raw rows one index contributes to a graph (files + triples). */
export interface GraphRows {
  files: FileRow[]
  triples: TripleRow[]
}

/** Which notes a confirmed `same_as::` decision has made one thing. */
export interface SameAsGroups {
  /** The surviving note for a path — the path itself when nothing folded it. */
  canon: (path: string) => string
  /** Surviving path → every path folded onto it, sorted, itself included. Only
   *  real groups (two notes or more) get an entry. */
  groups: Map<string, string[]>
}

/**
 * The one definition of "these notes are the same thing".
 *
 * `same_as:: [[Other]]` is a user-confirmed decision written into markdown by
 * the merge dialog. Union the SUBJECT into the OBJECT (the note that was
 * already in the vault wins, so a merge converges onto what you had), following
 * chains to their end. The pairs are sorted first, so a run of triples in any
 * order collapses to the same canonical note every time. An alias naming a note
 * that does not exist is not a collapse — a typo stays visible as an ordinary
 * edge to a ghost.
 *
 * The map folds the group into one dot; the reading view shows a note what its
 * twins say. Both call this, so they can never disagree.
 */
export function sameAsGroups(triples: TripleRow[], paths: string[]): SameAsGroups {
  const pathSet = new Set(paths)
  const resolve = targetResolver(paths)

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    for (let i = 0; i < 64; i++) {
      const up = parent.get(r)
      if (up === undefined || up === r) break
      r = up
    }
    return r
  }
  const pairs: [string, string][] = []
  for (const t of triples) {
    if (t.relation !== SAME_AS || !pathSet.has(t.source_file)) continue
    const { id } = resolve(t.object, t.source_file)
    if (pathSet.has(id)) pairs.push([t.source_file, id])
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  for (const [subject, object] of pairs) {
    const a = find(subject)
    const b = find(object)
    if (a !== b) parent.set(a, b)
  }
  const canon = parent.size === 0 ? (id: string): string => id : find

  const groups = new Map<string, string[]>()
  for (const path of new Set(pairs.flat())) {
    const c = canon(path)
    const list = groups.get(c)
    if (list) list.push(path)
    else groups.set(c, [path])
  }
  for (const list of groups.values()) list.sort()
  return { canon, groups }
}

/** The notes confirmed to be the same thing as `path`, itself excluded. */
export function sameAsTwins(triples: TripleRow[], paths: string[], path: string): string[] {
  const { canon, groups } = sameAsGroups(triples, paths)
  return (groups.get(canon(path)) ?? []).filter((p) => p !== path)
}

/**
 * Overlay two graph sources into one view — a `primary` (the vault) and a
 * `secondary` (a distilled run; in future, another vault). Pure: it unions the
 * rows and builds the graph, writing nothing. Nodes are files, so nothing is
 * collapsed: each node is tagged with the side its *path* came from
 * (`vault` / `run`), and a note whose *name* also exists on the other side is
 * flagged `sameName` and joined to its twin by a `same_name` edge. That is the
 * honest preview of a collision — two notes, one name, drawn as two dots — and
 * it is what a merge would have to decide about.
 */
export function overlayGraph(
  primary: GraphRows,
  secondary: GraphRows,
  focus: string | null,
  opts: { depth?: number; cap?: number; showSources?: boolean } = {}
): GraphData {
  const g = buildGraph(
    [...primary.files, ...secondary.files],
    [...primary.triples, ...secondary.triples],
    focus,
    opts
  )
  const sPaths = new Set(secondary.files.map((f) => f.path))
  const pNames = new Set(primary.files.map((f) => noteName(f.path)))
  const sNames = new Set(secondary.files.map((f) => noteName(f.path)))

  // Ghosts belong to neither side's files, so they carry no provenance.
  const nodes: GraphNode[] = g.nodes.map((n) => {
    if (!n.path) return n
    const source: 'vault' | 'run' = sPaths.has(n.path) ? 'run' : 'vault'
    const twinned = source === 'run' ? pNames.has(n.label) : sNames.has(n.label)
    return twinned ? { ...n, source, sameName: true } : { ...n, source }
  })

  // One `same_name` edge per cross-side pair actually drawn in this slice.
  const byName = new Map<string, { vault: string[]; run: string[] }>()
  for (const n of nodes) {
    if (!n.sameName || !n.source) continue
    let sides = byName.get(n.label)
    if (!sides) byName.set(n.label, (sides = { vault: [], run: [] }))
    sides[n.source].push(n.id)
  }
  const edges: GraphEdge[] = [...g.edges]
  for (const name of [...byName.keys()].sort()) {
    const { vault, run } = byName.get(name)!
    for (const v of [...vault].sort())
      for (const r of [...run].sort()) edges.push({ source: v, target: r, relation: SAME_NAME })
  }
  return { ...g, nodes, edges }
}

export interface ResolvedEdge {
  subject: string
  relation: string
  object: string
  /** The normalised target text, for counting ambiguous *targets* not edges. */
  key: string
  ambiguous: boolean
}

interface ResolvedGraph {
  pathSet: Set<string>
  kindOf: Map<string, NoteKind>
  resolve: ReturnType<typeof targetResolver>
  canon: SameAsGroups['canon']
  aliasLabels: Map<string, Set<string>>
  ghostLabel: Map<string, string>
  edges: ResolvedEdge[]
}

/** Share path resolution and alias folding before a view hides or caps nodes. */
export function resolveGraph(files: FileRow[], triples: TripleRow[]): ResolvedGraph {
  const pathSet = new Set(files.map((f) => f.path))
  // What each file IS (frontmatter `kind:`), for the document rule below and
  // for the map's node styling. Files with no recorded kind read as `note`.
  const kindOf = new Map<string, NoteKind>()
  for (const f of files) if (f.kind && f.kind !== 'note') kindOf.set(f.path, f.kind)
  const resolve = targetResolver(files.map((f) => f.path))

  // --- Confirmed aliases collapse ----------------------------------------
  // A group of notes the user confirmed are one thing folds into one node. The
  // rule itself lives in `sameAsGroups` above, because the reading view honours
  // exactly the same groups.
  const { canon, groups } = sameAsGroups(
    triples,
    files.map((f) => f.path)
  )
  /** Labels folded into each surviving node — shown in the map's inspector. */
  const aliasLabels = new Map<string, Set<string>>()
  for (const [survivor, group] of groups) {
    const set = new Set<string>()
    for (const id of group) if (id !== survivor) set.add(noteName(id))
    if (set.size > 0) aliasLabels.set(survivor, set)
  }
  const collapsed = (t: TripleRow, object: string): boolean =>
    t.relation === SAME_AS && pathSet.has(t.source_file) && pathSet.has(object)

  // De-dupe parallel triples (same subject/relation/object).
  const ghostLabel = new Map<string, string>()
  const seen = new Set<string>()
  const allEdges: ResolvedEdge[] = []
  for (const t of triples) {
    const { id, key, ambiguous } = resolve(t.object, t.source_file)
    if (collapsed(t, id)) continue // the alias edge itself: the fold replaces it
    const subject = canon(t.source_file)
    const object = canon(id)
    // Self-loops (self-references, and pairs the fold just made one node).
    if (subject === object) continue
    const dedupe = JSON.stringify([subject, t.relation, object])
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    if (object.startsWith(GHOST)) ghostLabel.set(object, t.object)
    allEdges.push({ subject, relation: t.relation, object, key, ambiguous })
  }

  // A typed relation for a pair supersedes the bare `links_to`: drop the
  // redundant link so "type this relation" upgrades the edge instead of
  // leaving two parallel edges between the same notes.
  const typedPairs = new Set<string>()
  for (const e of allEdges) {
    if (e.relation !== 'links_to') typedPairs.add(`${e.subject} ${e.object}`)
  }
  const edges = allEdges.filter(
    (e) => e.relation !== 'links_to' || !typedPairs.has(`${e.subject} ${e.object}`)
  )
  return { pathSet, kindOf, resolve, canon, aliasLabels, ghostLabel, edges }
}

function neighbourhood(focusId: string, depth: number, edges: ResolvedEdge[]): Set<string> {
  const included = new Set<string>([focusId])
  let frontier = new Set<string>([focusId])
  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const next = new Set<string>()
    for (const { subject, object } of edges) {
      if (frontier.has(subject) && !included.has(object)) next.add(object)
      if (frontier.has(object) && !included.has(subject)) next.add(subject)
    }
    for (const id of next) included.add(id)
    frontier = next
  }
  return included
}

export function buildGraph(
  files: FileRow[],
  triples: TripleRow[],
  focus: string | null,
  opts: { depth?: number; cap?: number; showSources?: boolean } = {}
): GraphData {
  const depth = opts.depth ?? 1
  const cap = opts.cap ?? DEFAULT_GRAPH_CAP
  const showSources = opts.showSources ?? false
  const resolved = resolveGraph(files, triples)
  const { canon, kindOf, pathSet } = resolved
  let shownEdges = resolved.edges

  // A `source` triple's (resolved) object is a source document — every note
  // distilled from it points back, so it collects one edge per note and turns the
  // map into a star. Hidden by default; `showSources` re-admits it. The hub's
  // edges are dropped here, before BFS/degree-ranking, on purpose: it changes
  // reachability, so notes connected only through the book stop reading as
  // connected to each other.
  // A focus that was itself folded into another note opens its surviving node.
  const focusId = focus ? canon(focus) : null
  const hubs = new Set<string>()
  for (const e of resolved.edges) if (e.relation === 'source') hubs.add(e.object)
  // The user explicitly opened this node — never hide it, even if it's a hub.
  // Simplest correct fix: exempt it from the hub set, so both the node and its
  // edges survive (instead of special-casing "keep the node, drop its edges").
  if (focusId) hubs.delete(focusId)
  const hiddenSources = showSources ? 0 : hubs.size
  if (hubs.size > 0) {
    // Shown, the hub still need not be a star. Once a run has themes, every
    // note already hangs under a theme (`part_of::`) and every theme links to
    // the book — so the note → book edges say nothing the map does not already
    // show, and the book keeps only its theme edges: the root of book → themes
    // → notes, a dozen edges instead of one per note. Each note's own
    // `source::` line stays in the note; only the drawing changes. A hub with
    // no theme edges (a run too small to be themed) keeps its star.
    const themed = new Set<string>()
    for (const e of resolved.edges)
      if (e.relation === 'source' && hubs.has(e.object) && kindOf.get(e.subject) === 'theme')
        themed.add(e.object)
    if (themed.size > 0) {
      shownEdges = shownEdges.filter(
        (e) => e.relation !== 'source' || !themed.has(e.object) || kindOf.get(e.subject) === 'theme'
      )
    }
  }
  let allEdges = showSources ? shownEdges : resolved.edges
  if (!showSources && hubs.size > 0) {
    allEdges = allEdges.filter((e) => !hubs.has(e.subject) && !hubs.has(e.object))
  }

  let nodeIds: Set<string>
  let hasSources: boolean
  let total: number // candidate nodes available (≥ shown when the global cap bites)
  if (focusId && pathSet.has(focusId)) {
    // BFS out from the focus note to `depth` hops (edges are undirected for reach).
    nodeIds = neighbourhood(focusId, depth, allEdges)
    total = nodeIds.size // local slices are never capped
    // Keep the toggle available in both states when a hub can join this slice.
    const withSources = showSources || !hubs.size ? nodeIds : neighbourhood(focusId, depth, shownEdges)
    hasSources = [...hubs].some((id) => withSources.has(id))
  } else {
    // Global: rank every referenced node by raw degree and keep the top `cap`.
    //
    // A `kind: document` note is a whole book. It has a huge degree by
    // construction — every note distilled from it points back — so degree
    // ranking would put it at the top of every map and squeeze real notes out.
    // It is not a hub of your thinking, it is the thing your thinking is about,
    // so it is left out of the global view unless you asked for source
    // documents (`showSources`). Opening one directly still works: that goes
    // through the focus branch above.
    const deg = new Map<string, number>()
    for (const e of allEdges) {
      deg.set(e.subject, (deg.get(e.subject) ?? 0) + 1)
      deg.set(e.object, (deg.get(e.object) ?? 0) + 1)
    }
    const candidates = [...deg.keys()]
    const ranked = showSources ? candidates : candidates.filter((id) => kindOf.get(id) !== 'document')
    hasSources = hubs.size > 0 || candidates.some((id) => kindOf.get(id) === 'document')
    total = ranked.length
    nodeIds = new Set(
      ranked.sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0)).slice(0, cap)
    )
  }

  return { ...graphSlice(resolved, nodeIds, allEdges, { focusId, total, hiddenSources }), hasSources }
}

export function graphSlice(
  { pathSet, kindOf, aliasLabels, ghostLabel }: ResolvedGraph,
  nodeIds: Set<string>,
  candidateEdges: ResolvedEdge[],
  { focusId = null, total = nodeIds.size, hiddenSources = 0 }: {
    focusId?: string | null
    total?: number
    hiddenSources?: number
  } = {}
): GraphData {
  const keptEdges = candidateEdges.filter((e) => nodeIds.has(e.subject) && nodeIds.has(e.object))

  // Degree within the returned slice.
  const degree = new Map<string, number>()
  const ambiguous = new Set<string>()
  for (const e of keptEdges) {
    degree.set(e.subject, (degree.get(e.subject) ?? 0) + 1)
    degree.set(e.object, (degree.get(e.object) ?? 0) + 1)
    if (e.ambiguous) ambiguous.add(e.key)
  }

  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const real = pathSet.has(id)
    const folded = aliasLabels.get(id)
    return {
      id,
      label: ghostLabel.get(id) ?? noteName(id),
      path: real ? id : null,
      ghost: !real,
      degree: degree.get(id) ?? 0,
      focus: focusId === id,
      ...(folded && folded.size > 0 ? { aliases: [...folded].sort() } : {}),
      ...(kindOf.has(id) ? { kind: kindOf.get(id) as NoteKind } : {})
    }
  })
  const edges: GraphEdge[] = keptEdges.map((e) => ({
    source: e.subject,
    target: e.object,
    relation: e.relation
  }))
  return { nodes, edges, total, hiddenSources, ambiguousTargets: ambiguous.size }
}
