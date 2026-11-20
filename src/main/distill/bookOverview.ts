import { createHash } from 'crypto'
import type {
  BookLinkEvidence,
  BookNoteRef,
  BookOverview,
  BookThemeDetails,
  BookThemeSummary,
  GraphData
} from '../../shared/types'
import { targetResolver } from '../../shared/markdown/resolveTarget'
import {
  DEFAULT_GRAPH_CAP,
  SAME_AS,
  graphSlice,
  noteName,
  resolveGraph,
  type GraphRows,
  type ResolvedEdge,
  type TripleRow
} from '../graph'
import { harvest } from '../harvest'
import { THEME_RELATION } from './emit'
import { titleSubthemes } from './bookSubthemes'

interface Theme {
  members: Set<string>
  edges: ResolvedEdge[]
}

interface BookProjection {
  overview: BookOverview | null
  themeDetails: (themeId: string | null) => BookThemeDetails | null
  themeGraph: (themeId: string | null, cap?: number) => GraphData | null
  themeOf: (noteId: string) => { id: string; label: string } | null
  linkEvidence: (source: string, target: string) => BookLinkEvidence | null
}

type ThemeLink = BookOverview['links'][number]
type NotePair = BookLinkEvidence['pairs'][number]
type Relationship = NotePair['relationships'][number]
type ReadIndexedText = (path: string) => string | undefined

interface LinkedThemes {
  link: ThemeLink
  pairs: Map<string, NotePair>
}

const SUBTHEME_ID = 'book-subtheme:'

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function rankMembers({ members, edges }: Theme): string[] {
  const degree = new Map<string, number>()
  for (const { subject, object } of edges) {
    degree.set(subject, (degree.get(subject) ?? 0) + 1)
    degree.set(object, (degree.get(object) ?? 0) + 1)
  }
  return [...members].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byId(a, b))
}

function stagedNoteRef(titles: Map<string, string | null>, id: string): BookNoteRef {
  return { id, title: titles.get(id)?.trim() || noteName(id) }
}

function summarize(titles: Map<string, string | null>, id: string, label: string, theme: Theme): BookThemeSummary {
  const examples: BookNoteRef[] = []
  const seen = new Set<string>()
  for (const member of rankMembers(theme)) {
    const example = stagedNoteRef(titles, member)
    const titleKey = example.title.normalize('NFC').toLowerCase()
    if (seen.has(titleKey)) continue
    seen.add(titleKey)
    examples.push(example)
    if (examples.length === 3) break
  }
  return { id, label, count: theme.members.size, examples }
}

function pairKey(a: string, b: string): string {
  return JSON.stringify([a, b])
}

function relationshipOrder(a: Relationship, b: Relationship): number {
  return byId(a.source, b.source) || byId(a.target, b.target) || byId(a.relation, b.relation) ||
    byId(a.originalSource?.id ?? '', b.originalSource?.id ?? '') ||
    byId(a.originalTarget?.id ?? '', b.originalTarget?.id ?? '')
}

function linkEvidenceFilter(
  triples: TripleRow[],
  readText?: ReadIndexedText
): (triple: TripleRow) => boolean {
  const verified = new Map<string, Set<string> | null>()
  let wikiLinks: Set<string> | undefined
  return ({ source_file, relation, object }) => {
    if (!verified.has(source_file)) {
      const text = readText?.(source_file)
      const links = text === undefined ? null : new Set(
        harvest(source_file, text, { linkedFieldsOnly: true }).triples.map(({ relation, object }) =>
          pairKey(relation, object)
        )
      )
      verified.set(source_file, links)
    }
    const links = verified.get(source_file)
    if (links) return links.has(pairKey(relation, object))
    // Metadata-only indexes retain link rows but have no indexed Markdown.
    if (relation === 'links_to') return true
    wikiLinks ??= new Set(triples.filter((t) => t.relation === 'links_to')
      .map((t) => pairKey(t.source_file, t.object)))
    return wikiLinks.has(pairKey(source_file, object))
  }
}

function markStrongLinks(links: ThemeLink[], themes: Map<string, Theme>): void {
  const incident = new Map<string, { link: ThemeLink; other: string; weight: number }[]>()
  for (const id of themes.keys()) incident.set(id, [])
  for (const link of links) {
    const { source, target, count } = link
    const weight = count / Math.sqrt(themes.get(source)!.members.size * themes.get(target)!.members.size)
    incident.get(source)!.push({ link, other: target, weight })
    incident.get(target)!.push({ link, other: source, weight })
  }
  const top = new Map<string, Set<ThemeLink>>()
  for (const [id, edges] of incident) {
    edges.sort((a, b) => b.weight - a.weight || byId(a.other, b.other))
    top.set(id, new Set(edges.slice(0, 3).map(({ link }) => link)))
  }
  const connected = new Set<string>()
  for (const link of links) {
    if (top.get(link.source)!.has(link) && top.get(link.target)!.has(link)) {
      link.strong = true
      connected.add(link.source)
      connected.add(link.target)
    }
  }
  // Every theme with evidence gets at least one strong link. Check isolation
  // from the mutual selection so fallback choices do not depend on iteration order.
  for (const [id, edges] of incident) {
    if (edges.length && !connected.has(id)) edges[0].link.strong = true
  }
}

function collectLinks(
  triples: GraphRows['triples'],
  members: Map<string, string>,
  { pathSet, kindOf, resolve, canon }: ReturnType<typeof resolveGraph>,
  titles: Map<string, string | null>,
  readText?: ReadIndexedText
): Map<string, LinkedThemes> {
  // A summary line asserts that two groups are connected. An ambiguous
  // wikilink cannot establish that; an explicit link in either direction can.
  const linkedThemes = new Map<string, LinkedThemes>()
  const seenRelationships = new Set<string>()
  const isLink = linkEvidenceFilter(triples, readText)
  for (const t of triples) {
    if (!pathSet.has(t.source_file) || kindOf.get(t.source_file) === 'document') continue
    const subject = canon(t.source_file)
    const a = members.get(subject)
    if (!a) continue
    const resolved = resolve(t.object, t.source_file)
    if (resolved.ambiguous) continue
    const object = canon(resolved.id)
    const b = members.get(object)
    if (!b || a === b || !isLink(t)) continue
    const relationshipKey = JSON.stringify([t.source_file, t.relation, resolved.id])
    if (seenRelationships.has(relationshipKey)) continue
    seenRelationships.add(relationshipKey)

    const forward = a < b
    const [source, target] = forward ? [a, b] : [b, a]
    const key = pairKey(source, target)
    const linked = linkedThemes.get(key) ?? {
      link: { source, target, count: 0, strong: false },
      pairs: new Map<string, NotePair>()
    }
    linkedThemes.set(key, linked)
    const [first, second] = forward ? [subject, object] : [object, subject]
    const noteKey = pairKey(first, second)
    const pair = linked.pairs.get(noteKey) ?? {
      source: stagedNoteRef(titles, first),
      target: stagedNoteRef(titles, second),
      relationships: []
    }
    pair.relationships.push({
      source: subject,
      target: object,
      relation: t.relation,
      ...(subject !== t.source_file ? { originalSource: stagedNoteRef(titles, t.source_file) } : {}),
      ...(object !== resolved.id ? { originalTarget: stagedNoteRef(titles, resolved.id) } : {})
    })
    linked.pairs.set(noteKey, pair)
    linked.link.count = linked.pairs.size
  }

  return linkedThemes
}

function evidenceFor(
  linkedThemes: Map<string, LinkedThemes>,
  source: string,
  target: string
): BookLinkEvidence | null {
  if (typeof source !== 'string' || typeof target !== 'string' || source === target) return null
  const forward = source < target
  const linked = linkedThemes.get(forward ? pairKey(source, target) : pairKey(target, source))
  if (!linked) return null
  const pairs = [...linked.pairs.values()].map((pair) => {
    // A typed field also emits a harvested wikilink. Keep its typed
    // relationship, and keep bare links on other directed endpoints.
    const actualPair = (edge: Relationship): string => pairKey(
      edge.originalSource?.id ?? edge.source,
      edge.originalTarget?.id ?? edge.target
    )
    const typed = new Set(pair.relationships.filter((edge) => edge.relation !== 'links_to').map(actualPair))
    return {
      source: forward ? pair.source : pair.target,
      target: forward ? pair.target : pair.source,
      relationships: pair.relationships
        .filter((edge) => edge.relation !== 'links_to' || !typed.has(actualPair(edge)))
        .sort(relationshipOrder)
    }
  }).sort((a, b) => byId(a.source.id, b.source.id) || byId(a.target.id, b.target.id))
  return { pairs }
}

/** Derive both book views from the full staged graph before either view caps it. */
export function projectBook({ files, triples }: GraphRows, readText?: ReadIndexedText): BookProjection {
  // An uncertain alias must not move a note (or its links) into another theme.
  let bookTriples = triples
  if (triples.some((t) => t.relation === SAME_AS)) {
    const target = targetResolver(files.map((f) => f.path))
    bookTriples = triples.filter((t) => t.relation !== SAME_AS || !target(t.object, t.source_file).ambiguous)
  }
  const graph = resolveGraph(files, bookTriples)
  const { pathSet, kindOf, resolve, canon } = graph
  const titles = new Map(files.map(({ path, title }) => [path, title]))
  const realIds = new Set([...pathSet].map(canon))
  const documents = [...realIds].filter((id) => kindOf.get(id) === 'document')
  const content = new Set(
    [...realIds].filter((id) => kindOf.get(id) !== 'document' && kindOf.get(id) !== 'theme')
  )
  const themeIds = new Set<string>()
  const candidates = new Map<string, Set<string>>()
  if (documents.length === 1) {
    const [book] = documents
    // Read the structural evidence before edge deduplication, where a guessed
    // target and an explicit path to the same file can become one graph edge.
    for (const t of triples) {
      if (!pathSet.has(t.source_file)) continue
      const from = canon(t.source_file)
      const isThemeSource = t.relation === 'source' && kindOf.get(from) === 'theme'
      const isMembership = t.relation === THEME_RELATION && content.has(from)
      if (!isThemeSource && !isMembership) continue
      const { id, ambiguous } = resolve(t.object, t.source_file)
      if (ambiguous) continue
      const to = canon(id)
      if (isThemeSource && to === book) themeIds.add(from)
      if (isMembership && kindOf.get(to) === 'theme') {
        const matches = candidates.get(from) ?? new Set<string>()
        matches.add(to)
        candidates.set(from, matches)
      }
    }
  }

  const members = new Map<string, string>()
  const themes = new Map<string, Theme>(
    [...themeIds].map((id) => [id, { members: new Set(), edges: [] }])
  )
  for (const [note, matches] of candidates) {
    const valid = [...matches].filter((id) => themeIds.has(id))
    if (valid.length !== 1) continue
    const [id] = valid
    members.set(note, id)
    themes.get(id)!.members.add(note)
  }

  const hasOverview = themes.size >= 2 && members.size > 0
  const unassigned: Theme | null = hasOverview
    ? { members: new Set([...content].filter((id) => !members.has(id))), edges: [] }
    : null
  for (const edge of graph.edges) {
    const { subject, object } = edge
    const a = members.get(subject)
    const b = members.get(object)
    if (!a || !b) {
      if (unassigned?.members.has(subject) && unassigned.members.has(object)) {
        unassigned.edges.push(edge)
      }
      continue
    }
    if (a === b) themes.get(a)!.edges.push(edge)
  }
  const linkedThemes = collectLinks(hasOverview ? triples : [], members, graph, titles, readText)

  const overview: BookOverview | null = hasOverview
    ? {
        themes: [...themes.keys()].sort(byId).map((id) => summarize(titles, id, noteName(id), themes.get(id)!)),
        links: [...linkedThemes.values()].map(({ link }) => link)
          .sort((a, b) => byId(a.source, b.source) || byId(a.target, b.target)),
        noteCount: content.size,
        unassignedCount: content.size - members.size
      }
    : null
  if (overview) markStrongLinks(overview.links, themes)

  const children = new Map<string, Theme>()
  const details = new Map<string | null, BookThemeDetails>()
  const themeDetails = (themeId: string | null): BookThemeDetails | null => {
    const cached = details.get(themeId)
    if (cached) return cached
    const theme = themeId === null ? unassigned : themes.get(themeId)
    if (!theme) return null
    const label = themeId === null ? 'Unassigned' : noteName(themeId)
    const groups = titleSubthemes(
      [...theme.members].sort(byId).map((id) => stagedNoteRef(titles, id)),
      label
    )
    const child = (label: string, ids: string[], key: string | null): BookThemeSummary => {
      const id = SUBTHEME_ID + createHash('sha256')
        .update(JSON.stringify([documents[0], themeId, key]))
        .digest('hex')
      const members = new Set(ids)
      const edges = theme.edges.filter(({ subject, object }) => members.has(subject) && members.has(object))
      const subset = { members, edges }
      children.set(id, subset)
      return summarize(titles, id, label, subset)
    }
    const subthemes = groups.map(({ key, label, members }) => child(label, members, key))
    const assigned = new Set(groups.flatMap(({ members }) => members))
    const other = [...theme.members].filter((id) => !assigned.has(id))
    const remainder = groups.length && other.length ? child('Other notes', other, null) : null
    const result = { subthemes, remainder }
    details.set(themeId, result)
    return result
  }

  return {
    overview,
    themeDetails,
    themeOf(noteId) {
      if (!pathSet.has(noteId)) return null
      const id = canon(noteId)
      const themeId = members.get(id) ?? (themes.has(id) ? id : null)
      return themeId ? { id: themeId, label: noteName(themeId) } : null
    },
    linkEvidence: (source, target) => evidenceFor(linkedThemes, source, target),
    themeGraph(themeId, cap = DEFAULT_GRAPH_CAP) {
      let theme = themeId === null ? unassigned : themes.get(themeId) ?? children.get(themeId)
      // A retained drill-down can outlive the store's most recently used run.
      if (!theme && typeof themeId === 'string' && themeId.startsWith(SUBTHEME_ID)) {
        for (const parentId of [...themes.keys(), null]) {
          themeDetails(parentId)
          theme = children.get(themeId)
          if (theme) break
        }
      }
      if (!theme) return null
      const limit = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : DEFAULT_GRAPH_CAP
      const selected = new Set(rankMembers(theme).slice(0, limit))
      return graphSlice(graph, selected, theme.edges, { total: theme.members.size })
    }
  }
}
