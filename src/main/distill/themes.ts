/**
 * Themes — the layer that turns a run's flat pile of notes into a map you can
 * read: book → a handful of themes → the notes under each. Pure and
 * dependency-free (the embedding and the naming call live in the orchestrator);
 * everything here is a deterministic function of its input.
 *
 * Three steps, in order:
 *
 *  1. **Cluster** the notes by meaning (`clusterNotes`, k-means over the note
 *     vectors — `cluster.ts`). `k ≈ √n`, clamped to 3..16: few enough to read at
 *     a glance, many enough that a theme still says something.
 *  2. **Name** every cluster in ONE model call (`themeNamingPrompt` +
 *     `parseThemeNames`). One call, not one per theme: naming is presentation,
 *     and presentation should not cost a call per group.
 *  3. **Fall back** per cluster to its medoid note's title (`themeNameOf`) —
 *     the note nearest the middle of the group is the least-bad label for it.
 *     So a naming call that fails, or answers for only some groups, costs the
 *     names it missed and nothing else.
 *
 * The rendering half (`renderThemeNote`, `attachThemes`) lives in `emit.ts`
 * with the other markdown writers.
 */

import { kmeans, type Point } from './cluster'
import { parseLenientObject } from './lenientJson'

/** Below this many notes a run is not themed: three themes over five notes is
 *  filing, not grouping, and the map reads better flat. */
export const MIN_THEME_NOTES = 6

/** Bounds on the number of themes (see the module header). */
export const MIN_THEMES = 3
export const MAX_THEMES = 16

/** Longest theme name kept from the model (2–4 words is what we ask for; this
 *  is the backstop against a model that answers with a paragraph). */
const NAME_CAP = 60

/** Members listed per theme in the naming prompt, and how much of each note's
 *  summary goes with them. Naming needs a sense of the group, not the whole
 *  group — and the prompt has to fit a small model's window too. */
const PROMPT_MEMBERS = 8
const PROMPT_SUMMARY = 140

/** How many themes for `n` notes: about √n, clamped to [3, 16] and never more
 *  than there are notes. */
export function themeK(n: number): number {
  if (n <= 0) return 0
  return Math.min(n, Math.max(MIN_THEMES, Math.min(MAX_THEMES, Math.round(Math.sqrt(n)))))
}

/** One group of notes. Indices are positions in the input array, ascending. */
export interface NoteCluster {
  members: number[]
  /** The member nearest the group's centre — names the theme when the model
   *  does not. */
  medoid: number
}

/** L2-normalise a copy of `v` (a zero vector is returned unchanged). `kmeans`
 *  compares squared distances, which only track cosine similarity on unit
 *  vectors — so this is done here rather than assumed of the embedder. */
function normalized(v: Float32Array): Float32Array {
  let sq = 0
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i]
  const norm = Math.sqrt(sq)
  if (norm === 0) return Float32Array.from(v)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/**
 * Group note vectors into themes. Deterministic: same vectors in, same
 * clusters out, in a stable order (see `cluster.ts`). `k` defaults to
 * `themeK(vectors.length)`.
 */
export function clusterNotes(vectors: Float32Array[], opts: { k?: number } = {}): NoteCluster[] {
  if (vectors.length === 0) return []
  const points: Point[] = vectors.map((vec, id) => ({ id, vec: normalized(vec) }))
  const k = opts.k && opts.k > 0 ? Math.min(opts.k, vectors.length) : themeK(vectors.length)
  return kmeans(points, k, { repCount: 1 }).map((c) => ({
    members: c.memberIds,
    medoid: c.representativeIds[0] ?? c.memberIds[0]
  }))
}

/** A note as the namer sees it. */
export interface ThemeMember {
  title: string
  summary: string
}

/** The `language` field comes first on purpose. Asked only to "write in the
 *  same language as the notes", a model without extended thinking named the
 *  groups of an English book in Russian, Polish and Turkish on identical
 *  prompts (2 of 3 tries wrong); made to state the language before naming, it
 *  answered in English 3 of 3 times (Sonnet, claude-code 2.1.258, thinking
 *  off). Stating it is the anchor; the value itself is not read. */
const SCHEMA_HINT = `{
  "language": "<the language the notes are written in>",
  "themes": [ { "index": <the group's number>, "name": "2-4 words" } ]
}`

/**
 * The one prompt that names every group. The group blocks are marked
 * `[theme N]` and their members listed as `- <title>` with the summary
 * indented under it — the same shape as the extraction prompt's `[chunk N]`
 * blocks, so a stub can answer it by reading its own input.
 */
export function themeNamingPrompt(clusters: { members: ThemeMember[] }[]): {
  system: string
  user: string
} {
  const system =
    'You name groups of related notes. Each group is a set of notes that belong ' +
    'together; give it a SHORT name — 2 to 4 words — saying what the group is ' +
    'about. First say which language the notes are written in, then write ' +
    'every name in that SAME LANGUAGE; never translate. Do not copy a single ' +
    'note\'s title as the group name, and do ' +
    'not give two groups the same name. Return ONLY JSON in this exact shape:\n' +
    SCHEMA_HINT
  const body = clusters
    .map((c, i) => {
      const members = c.members
        .slice(0, PROMPT_MEMBERS)
        .map((m) => {
          const summary = m.summary.replace(/\s+/g, ' ').trim().slice(0, PROMPT_SUMMARY)
          return summary ? `- ${m.title}\n  ${summary}` : `- ${m.title}`
        })
        .join('\n')
      return `[theme ${i}]\n${members}`
    })
    .join('\n\n')
  const user =
    `Name each of these ${clusters.length} groups of notes. One entry per group, ` +
    'using the group\'s own number as "index".\n\nGROUPS:\n\n' +
    body
  return { system, user }
}

/**
 * Parse the naming reply into one name per group. Tolerant in the same way as
 * `parseExtraction`: the outermost `{...}` is taken, prose and code fences
 * around it are ignored, a stray quote inside a name is mended, and an entry with no usable `index` falls back to its
 * position in the array. A group the model skipped stays `null` — the caller
 * names it from its medoid (`themeNameOf`). `ok` is false only when there was
 * no parseable object at all, which is what earns a repair retry.
 */
export function parseThemeNames(
  raw: string,
  count: number
): { ok: boolean; names: (string | null)[] } {
  const names = new Array<string | null>(count).fill(null)
  const parsed = parseLenientObject(raw)
  if (parsed === undefined) return { ok: false, names }
  const list = (parsed as { themes?: unknown } | null)?.themes
  if (!Array.isArray(list)) return { ok: false, names }
  list.forEach((entry, pos) => {
    if (!entry || typeof entry !== 'object') return
    const o = entry as Record<string, unknown>
    const raw = typeof o.index === 'number' ? o.index : Number(o.index)
    const i = Number.isInteger(raw) ? raw : pos
    if (i < 0 || i >= count || names[i] !== null) return
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : ''
    if (name) names[i] = name.slice(0, NAME_CAP).trim()
  })
  return { ok: true, names }
}

/**
 * The final name for one group: what the model called it, or — when it said
 * nothing usable — the title of the group's medoid note.
 */
export function themeNameOf(
  cluster: NoteCluster,
  titles: string[],
  named: string | null
): string {
  if (named) return named
  return titles[cluster.medoid] ?? titles[cluster.members[0]] ?? 'theme'
}

