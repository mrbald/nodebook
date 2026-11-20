import { relative } from 'path'
import { targetResolver } from '../shared/markdown/resolveTarget'
import type { VaultThemeNote, VaultThemesData } from '../shared/types'
import { noteName, sameAsGroups, SAME_AS, type GraphRows } from './graph'
import { ignoredInVault, withinRoot } from './paths'

const MIN_THEME_SIZE = 3
const MIN_VAULT_SIZE = 6
const MAX_EXACT_VECTORS = 128
const SEMANTIC_NEIGHBORS = 6
const PROJECTION_COUNT = 5
const PROJECTION_WINDOW = 8
const LINK_CANDIDATES = 12

interface Affinity {
  weight: number
  corroborated: boolean
  semantic?: true
}

type Affinities = Map<number, Affinity>[]

function connect(edges: Affinities, a: number, b: number, affinity: Affinity): void {
  edges[a].set(b, affinity)
  edges[b].set(a, affinity)
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let d = 0; d < a.length; d++) sum += a[d] * b[d]
  return sum
}

interface EmbeddedNote {
  note: number
  vector: Float32Array
}

/** Sorted views give each vector a bounded neighborhood in several directions.
 * The direction seed and tie order are fixed so an unchanged vault stays put. */
function projectionWindows(notes: EmbeddedNote[]): { order: number[]; position: number[] }[] {
  let seed = 1729
  return Array.from({ length: PROJECTION_COUNT }, () => {
    const direction = Float32Array.from(notes[0].vector, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0
      return seed < 0 ? -1 : 1
    })
    const value = notes.map(({ vector }) => dot(vector, direction))
    const order = notes.map((_, i) => i).sort((a, b) => value[a] - value[b] || a - b)
    const position = new Array<number>(notes.length)
    order.forEach((i, rank) => { position[i] = rank })
    return { order, position }
  })
}

function addSemanticAffinities(edges: Affinities, notes: EmbeddedNote[]): void {
  if (notes.length < MIN_THEME_SIZE) return
  const mean = new Float32Array(notes[0].vector.length)
  for (const { vector } of notes) {
    for (let d = 0; d < mean.length; d++) mean[d] += vector[d] / notes.length
  }
  // Many embedding spaces give unrelated notes a high cosine. Require a
  // match to clear both the absolute floor and each note's vault baseline.
  const floors = notes.map(({ vector }) => Math.max(0.8, dot(vector, mean) + 0.04))
  const exact = notes.length <= MAX_EXACT_VECTORS ? notes.map((_, i) => i) : null
  const windows = exact ? [] : projectionWindows(notes)
  const indexByNote = new Map(notes.map(({ note }, i) => [note, i]))
  const nearest = notes.map(({ note, vector }, i) => {
    const candidates = new Set(exact)
    for (const { order, position } of windows) {
      const from = Math.max(0, position[i] - PROJECTION_WINDOW)
      const to = Math.min(order.length - 1, position[i] + PROJECTION_WINDOW)
      for (let rank = from; rank <= to; rank++) candidates.add(order[rank])
    }
    // Test the strongest actual links even when the windows miss them. Cap
    // these too so a dense link graph cannot force all-pairs cosine work.
    const links = [...edges[note]].sort((a, b) => b[1].weight - a[1].weight || a[0] - b[0])
    for (const [target] of links.slice(0, LINK_CANDIDATES)) {
      const j = indexByNote.get(target)
      if (j !== undefined) candidates.add(j)
    }
    candidates.delete(i)
    return [...candidates]
      .map((j) => ({ target: notes[j].note, score: dot(vector, notes[j].vector), floor: floors[j] }))
      .filter(({ score, floor }) => score >= Math.max(floors[i], floor))
      .sort((a, b) => b.score - a.score || a.target - b.target)
      .slice(0, SEMANTIC_NEIGHBORS)
  })
  for (const [i, matches] of nearest.entries()) {
    const { note } = notes[i]
    for (const { target, score } of matches) {
      const link = edges[note].get(target)
      if (link?.semantic) continue
      connect(edges, note, target, {
        weight: (link?.weight ?? 0) + score,
        corroborated: true,
        semantic: true
      })
    }
  }
}

/** A weighted modularity pass moves a note only when a neighboring group
 * accounts for more of its links than the group's total reach would predict. */
function communities(edges: Affinities): number[] {
  const groups = edges.map((_, i) => i)
  const degrees = edges.map((neighbors) => {
    let sum = 0
    for (const { weight } of neighbors.values()) sum += weight
    return sum
  })
  const mass = [...degrees]
  const total = mass.reduce((sum, degree) => sum + degree, 0)
  if (total === 0) return groups
  for (let pass = 0; pass < 12; pass++) {
    let changed = false
    for (const [note, neighbors] of edges.entries()) {
      if (!neighbors.size) continue
      const own = groups[note]
      const degree = degrees[note]
      const support = new Map<number, number>()
      for (const [neighbor, { weight }] of neighbors) {
        const group = groups[neighbor]
        support.set(group, (support.get(group) ?? 0) + weight)
      }
      mass[own] -= degree
      let best = own
      const ownScore = (support.get(own) ?? 0) - (degree * mass[own]) / total
      let bestScore = ownScore
      for (const [group, weight] of support) {
        const score = weight - (degree * mass[group]) / total
        if (score > bestScore + 1e-9 ||
          (score > ownScore + 1e-9 && Math.abs(score - bestScore) <= 1e-9 && group < best)) {
          best = group
          bestScore = score
        }
      }
      mass[best] += degree
      groups[note] = best
      changed ||= best !== own
    }
    if (!changed) break
  }
  return groups
}

function linkAffinities(
  triples: GraphRows['triples'],
  resolve: ReturnType<typeof targetResolver>,
  canonical: (path: string) => string,
  positions: Map<string, number>,
  documents: Set<string>
): Affinities {
  // Harvest emits a bare link beside its typed field. Require the bare link
  // to prove a field refers to an actual note, then count the pair only once.
  const outgoing: Map<number, Set<string>>[] = Array.from({ length: positions.size }, () => new Map())
  for (const { source_file, relation, object } of triples) {
    const source = canonical(source_file)
    const from = positions.get(source)
    if (from === undefined || documents.has(source)) continue
    const target = resolve(object, source_file)
    if (target.ambiguous) continue
    const path = canonical(target.id)
    const to = positions.get(path)
    if (to === undefined || to === from || documents.has(path)) continue
    const relations = outgoing[from].get(to) ?? new Set<string>()
    relations.add(relation)
    outgoing[from].set(to, relations)
  }

  const directed: Map<number, boolean>[] = outgoing.map((links) => {
    const explicit = new Map<number, boolean>()
    for (const [target, relations] of links) {
      if (!relations.has('links_to')) continue
      const typed = [...relations].some((r) => r !== 'links_to' && r !== 'source' && r !== SAME_AS)
      if (typed || (!relations.has('source') && !relations.has(SAME_AS))) explicit.set(target, typed)
    }
    return explicit
  })
  const neighbors = directed.map(() => new Set<number>())
  for (const [from, links] of directed.entries()) {
    for (const to of links.keys()) {
      neighbors[from].add(to)
      neighbors[to].add(from)
    }
  }
  const edges: Affinities = directed.map(() => new Map())
  for (const [from, links] of directed.entries()) {
    for (const [to, typed] of links) {
      if (edges[from].has(to)) continue
      const reciprocal = directed[to].has(from)
      const named = typed || directed[to].get(from) === true
      // An index note with many outgoing links is weak evidence by itself.
      const reach = Math.max(neighbors[from].size, neighbors[to].size)
      if (reach > 24 && !reciprocal && !named) continue
      connect(edges, from, to, {
        weight: (1 + Number(reciprocal) * 0.5 + Number(named) * 0.5) * Math.min(1, 6 / reach),
        corroborated: reciprocal || named
      })
    }
  }
  return edges
}

/** Project the full index into disjoint group and unmatched lists, writing
 * nothing. Canonical notes are kept even when they have zero usable evidence. */
export function projectVaultThemes(
  root: string,
  { files, triples }: GraphRows,
  vectors: ReadonlyMap<string, Float32Array>
): VaultThemesData {
  const ignored = ignoredInVault(root)
  const eligible = files.filter(({ path }) =>
    withinRoot(root, path) && !ignored(path) && !/\.map\.md$/i.test(path)
  )
  const paths = eligible.map(({ path }) => path).sort()
  const resolve = targetResolver(paths)
  const aliases = triples.filter(({ relation, object, source_file }) =>
    relation === SAME_AS && !resolve(object, source_file).ambiguous
  )
  const { canon, groups: aliasGroups } = sameAsGroups(aliases, paths)
  const notes: VaultThemeNote[] = eligible
    .filter(({ path }) => canon(path) === path)
    .map(({ path, title }) => ({ path, title: title || noteName(path), relativePath: relative(root, path) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const positions = new Map(notes.map(({ path }, n) => [path, n]))
  const documents = new Set(eligible.filter(({ kind }) => kind === 'document').map(({ path }) => path))
  const embedded = notes.flatMap(({ path }, note) => {
    if (documents.has(path)) return []
    // A current canonical vector takes precedence; a confirmed alias can cover
    // the note when its canonical copy is still waiting for local indexing.
    const candidates = [path, ...(aliasGroups.get(path) ?? []).filter((alias) => alias !== path)]
    for (const id of candidates) {
      const vector = vectors.get(id)
      if (vector?.some((value) => value !== 0)) return [{ note, vector }]
    }
    return []
  })

  const result: VaultThemesData = {
    themes: [],
    unmatched: notes,
    noteCount: notes.length,
    embeddedCount: embedded.length
  }
  const byTitle = (a: VaultThemeNote, b: VaultThemeNote): number =>
    a.title.localeCompare(b.title) || a.relativePath.localeCompare(b.relativePath)
  if (notes.length < MIN_VAULT_SIZE) {
    result.unmatched = [...notes].sort(byTitle)
    return result
  }

  const edges = linkAffinities(triples, resolve, canon, positions, documents)
  addSemanticAffinities(edges, embedded)
  const labels = communities(edges)
  const members = new Map<number, number[]>()
  for (const [note, group] of labels.entries()) {
    const list = members.get(group) ?? []
    list.push(note)
    members.set(group, list)
  }
  const assigned = new Set<number>()
  for (const [group, list] of members) {
    if (list.length < MIN_THEME_SIZE || list.length > notes.length * 0.8) continue
    let internal = 0
    let external = 0
    let internalPairs = 0
    let corroborated = false
    const ranked = list.map((note) => {
      let strength = 0
      for (const [other, affinity] of edges[note]) {
        if (labels[other] === group) {
          strength += affinity.weight
          internalPairs++
          corroborated ||= affinity.corroborated
        } else {
          external += affinity.weight
        }
      }
      internal += strength
      return { note, strength }
    })
    // A chain of one-way links alone has no corroboration. Also require at
    // least as much weight inside as outside a proposed boundary.
    if ((!corroborated && internalPairs < 2 * list.length) || internal / 2 < external) continue
    ranked.sort((a, b) => b.strength - a.strength || a.note - b.note)
    for (const note of list) assigned.add(note)
    result.themes.push({
      id: notes[list[0]].path,
      label: notes[ranked[0].note].title,
      notes: list.map((id) => notes[id]).sort(byTitle),
      examples: ranked.slice(1, 3).map(({ note }) => notes[note].title)
    })
  }
  result.themes.sort((a, b) => b.notes.length - a.notes.length || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  result.unmatched = notes.filter((_, id) => !assigned.has(id)).sort(byTitle)
  return result
}
