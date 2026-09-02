import type { GraphData, GraphEdge, GraphNode } from '../shared/types'

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
 */

export interface FileRow {
  path: string
  title: string | null
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

/** Base note name from a path: strip directories and the `.md` extension. */
export function noteName(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).replace(/\.md$/i, '')
}

/** The folder a path sits in ('' at the root), separator-normalised. */
function folderOf(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? '' : norm.slice(0, i)
}

/** The raw rows one index contributes to a graph (files + triples). */
export interface GraphRows {
  files: FileRow[]
  triples: TripleRow[]
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

export function buildGraph(
  files: FileRow[],
  triples: TripleRow[],
  focus: string | null,
  opts: { depth?: number; cap?: number; showSources?: boolean } = {}
): GraphData {
  const depth = opts.depth ?? 1
  const cap = opts.cap ?? 200
  const showSources = opts.showSources ?? false

  const pathSet = new Set(files.map((f) => f.path))
  // Resolve a link target to a real note by name OR by path suffix (so
  // `[[projects/Roadmap]]` finds `projects/Roadmap.md`), matching the editor's
  // link resolver. Every suffix keeps *all* of its files, because a name is not
  // an identity: several files can answer to it.
  const suffixToPaths = new Map<string, string[]>()
  for (const f of files) {
    const segs = f.path
      .replace(/\.md$/i, '')
      .split(/[/\\]/)
      .filter(Boolean)
    for (let i = segs.length - 1; i >= 0; i--) {
      const key = segs.slice(i).join('/')
      const list = suffixToPaths.get(key)
      if (list) list.push(f.path)
      else suffixToPaths.set(key, [f.path])
    }
  }
  for (const list of suffixToPaths.values()) list.sort()

  /**
   * A link target → a node id, seen from the note that wrote the link:
   * exactly one file with that name (or path suffix) wins outright; several
   * prefer one in the linking note's own folder, else the lexicographically
   * smallest path — and either way the target is reported as ambiguous, because
   * the link really could have meant either note; none is a ghost.
   */
  const resolve = (object: string, from: string): { id: string; key: string; ambiguous: boolean } => {
    const key = object
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\.md$/i, '')
    const cands = suffixToPaths.get(key)
    if (!cands || cands.length === 0) return { id: `${GHOST}${object}`, key, ambiguous: false }
    if (cands.length === 1) return { id: cands[0], key, ambiguous: false }
    const sameFolder = cands.filter((p) => folderOf(p) === folderOf(from))
    return { id: sameFolder[0] ?? cands[0], key, ambiguous: true }
  }

  // --- Confirmed aliases collapse ----------------------------------------
  // `same_as:: [[Other]]` is a user-confirmed decision written into markdown by
  // the merge dialog. Union the SUBJECT into the OBJECT (the note that was
  // already in the vault wins, so a merge converges onto what you had), following
  // chains to their end. The pairs are sorted first, so a run of triples in any
  // order collapses to the same canonical node every time.
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
  const aliasPairs: [string, string][] = []
  for (const t of triples) {
    if (t.relation !== SAME_AS || !pathSet.has(t.source_file)) continue
    const { id } = resolve(t.object, t.source_file)
    // An alias naming a note that does not exist is not a collapse — it stays an
    // ordinary edge to a ghost, so a typo is visible instead of silent.
    if (pathSet.has(id)) aliasPairs.push([t.source_file, id])
  }
  aliasPairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  for (const [subject, object] of aliasPairs) {
    const a = find(subject)
    const b = find(object)
    if (a !== b) parent.set(a, b)
  }
  const canon = parent.size === 0 ? (id: string): string => id : find
  /** Labels folded into each surviving node — shown in the map's inspector. */
  const aliasLabels = new Map<string, Set<string>>()
  for (const id of new Set(aliasPairs.flat())) {
    const c = canon(id)
    if (c === id) continue
    const set = aliasLabels.get(c) ?? new Set<string>()
    set.add(noteName(id))
    aliasLabels.set(c, set)
  }
  const collapsed = (t: TripleRow, object: string): boolean =>
    t.relation === SAME_AS && pathSet.has(t.source_file) && pathSet.has(object)

  interface Edge {
    subject: string
    relation: string
    object: string
    /** The normalised target text, for counting ambiguous *targets* not edges. */
    key: string
    ambiguous: boolean
  }

  // De-dupe parallel triples (same subject/relation/object).
  const ghostLabel = new Map<string, string>()
  const seen = new Set<string>()
  let allEdges: Edge[] = []
  for (const t of triples) {
    const { id, key, ambiguous } = resolve(t.object, t.source_file)
    if (collapsed(t, id)) continue // the alias edge itself: the fold replaces it
    const subject = canon(t.source_file)
    const object = canon(id)
    // Self-loops (self-references, and pairs the fold just made one node).
    if (subject === object) continue
    const dedupe = `${subject} ${t.relation} ${object}`
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
  allEdges = allEdges.filter(
    (e) => e.relation !== 'links_to' || !typedPairs.has(`${e.subject} ${e.object}`)
  )

  // A `source` triple's (resolved) object is a source document — every note
  // distilled from it points back, so it collects one edge per note and turns the
  // map into a star. Hidden by default; `showSources` re-admits it. The hub's
  // edges are dropped here, before BFS/degree-ranking, on purpose: it changes
  // reachability, so notes connected only through the book stop reading as
  // connected to each other.
  // A focus that was itself folded into another note opens its surviving node.
  const focusId = focus ? canon(focus) : null
  const hubs = new Set<string>()
  for (const e of allEdges) if (e.relation === 'source') hubs.add(e.object)
  // The user explicitly opened this node — never hide it, even if it's a hub.
  // Simplest correct fix: exempt it from the hub set, so both the node and its
  // edges survive (instead of special-casing "keep the node, drop its edges").
  if (focusId) hubs.delete(focusId)
  const hiddenSources = showSources ? 0 : hubs.size
  if (!showSources && hubs.size > 0) {
    allEdges = allEdges.filter((e) => !hubs.has(e.subject) && !hubs.has(e.object))
  }

  let nodeIds: Set<string>
  let total: number // candidate nodes available (≥ shown when the global cap bites)
  if (focusId && pathSet.has(focusId)) {
    // BFS out from the focus note to `depth` hops (edges are undirected for reach).
    const included = new Set<string>([focusId])
    let frontier = new Set<string>([focusId])
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>()
      for (const e of allEdges) {
        if (frontier.has(e.subject) && !included.has(e.object)) next.add(e.object)
        if (frontier.has(e.object) && !included.has(e.subject)) next.add(e.subject)
      }
      for (const n of next) included.add(n)
      frontier = next
      if (frontier.size === 0) break
    }
    nodeIds = included
    total = included.size // local slices are never capped
  } else {
    // Global: rank every referenced node by raw degree and keep the top `cap`.
    const deg = new Map<string, number>()
    for (const e of allEdges) {
      deg.set(e.subject, (deg.get(e.subject) ?? 0) + 1)
      deg.set(e.object, (deg.get(e.object) ?? 0) + 1)
    }
    total = deg.size
    nodeIds = new Set(
      [...deg.keys()].sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0)).slice(0, cap)
    )
  }

  const keptEdges = allEdges.filter((e) => nodeIds.has(e.subject) && nodeIds.has(e.object))

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
      ...(folded && folded.size > 0 ? { aliases: [...folded].sort() } : {})
    }
  })
  const edges: GraphEdge[] = keptEdges.map((e) => ({
    source: e.subject,
    target: e.object,
    relation: e.relation
  }))
  return { nodes, edges, total, hiddenSources, ambiguousTargets: ambiguous.size }
}
