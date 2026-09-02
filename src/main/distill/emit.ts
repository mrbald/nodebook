/**
 * Render grounded items into editable, cited markdown notes — the artifact a
 * distill run produces. Pure and dependency-free (no fs here; the orchestrator
 * writes the files). The note shape is chosen so the existing `harvest()` parser
 * turns it into the right graph edges with no special-casing:
 *
 *  - **Body `key:: value` fields** carry the real knowledge edges: `source::` to
 *    the book, and each typed relation (`about::`, `supports::`, …). These become
 *    triples and drive the derived map.
 *  - **Frontmatter** carries display/provenance metadata (`kind`, the `source`
 *    note name, per-citation `cite` spans). It uses single-colon YAML, which
 *    `harvest()` ignores — so the span provenance never pollutes the graph with
 *    citation ghost-nodes.
 *
 * The source is named by ONE short human title everywhere (`sourceTitle`, run
 * through `noteName`): the body `source::` target, the frontmatter `source:`
 * line (the renderer's citation panel resolves it to a note), and the book note
 * file `artifact.ts` writes (`sourceNoteName`) — so the name always resolves to
 * a real note. Raw machine identity lives in the run's `meta.json` and the cite
 * chunk/span provenance, not here.
 *
 * Link targets are normalized the same way as note names, so `[[target]]` always
 * resolves to the note emitted for that title.
 */

import type { GroundedNote } from './extract'

export interface EmittedNote {
  /** Basename without extension; also how `[[links]]` reference this note. */
  name: string
  /** `${name}.md`. */
  fileName: string
  /** Full markdown content. */
  content: string
}

const DOC_EXT_RE = /\.(pdf|epub|md|markdown|txt|text)$/i
const TITLE_CAP = 80

/** Cut `s` back to the last word boundary at or before `max` chars. No ellipsis. */
function capWords(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * A short, human title for a source file — via `noteName` it becomes the one
 * source name used everywhere (see the module header), so links always resolve.
 *
 * Strips the file's directory and a known document extension, then — for the
 * common library-dump convention (`Title -- Author -- Year -- Publisher -- ...`)
 * — keeps just the title and author segments. Underscores (another dump
 * convention) become spaces. Falls back to the stripped basename, then
 * `'source'`; never empty.
 */
export function sourceTitle(file: string): string {
  const base = (file.split(/[/\\]/).pop() ?? file).replace(DOC_EXT_RE, '')
  const segments = base.split(' -- ')
  const picked = segments.length > 1 ? segments.slice(0, 2).join(' — ') : base
  const cleaned = capWords(picked.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim(), TITLE_CAP)
  return cleaned || base.trim() || 'source'
}

/**
 * Normalize a title into a safe note name: strip path- and wikilink-hostile
 * characters and collapse whitespace. Applied identically to link targets, so a
 * `[[target]]` resolves to the note emitted for that target's title.
 */
export function noteName(title: string): string {
  const n = title.replace(/[\\/:*?"<>|#[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n || 'untitled'
}

/** A harvest-valid relation name (`[A-Za-z][\w -]*`), or '' to skip the link. */
function relationName(relation: string): string {
  const clean = relation.trim().replace(/[^A-Za-z0-9_ -]/g, '_')
  return /^[A-Za-z]/.test(clean) ? clean : ''
}

function frontmatter(note: GroundedNote, sources: string[]): string {
  const lines = ['---', `kind: ${note.kind}`]
  if (sources.length) lines.push(`source: ${sources.join(', ')}`)
  if (note.citations.length) {
    lines.push('cite:')
    for (const c of note.citations) {
      lines.push(`  - chunk: ${c.chunkId}`)
      lines.push(`    span: ${c.start}-${c.end}`)
      // JSON-string-escaped: the quote can contain anything (quotes, newlines,
      // colons) and this stays a valid single-line YAML double-quoted scalar,
      // so an old parser that only reads chunk+span still ignores it safely.
      lines.push(`    quote: ${JSON.stringify(c.quote)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** Render one note's markdown. `name` overrides the title-derived note name
 *  (used when a run de-collides duplicate names). */
export function renderNote(note: GroundedNote, name = noteName(note.title)): string {
  // One name for the source everywhere — frontmatter, body link, book note
  // file — so it always resolves (see the module header).
  const sources = [...new Set(note.citations.map((c) => noteName(sourceTitle(c.file))))]

  const fields: string[] = []
  for (const s of sources) fields.push(`source:: [[${s}]]`)
  for (const l of note.links) {
    const rel = relationName(l.relation)
    const target = noteName(l.target)
    if (rel && target) fields.push(`${rel}:: [[${target}]]`)
  }

  const quotes = [...new Set(note.citations.map((c) => c.quote.replace(/\s+/g, ' ').trim()))]

  const parts = [frontmatter(note, sources), '', `# ${name}`, '']
  if (fields.length) parts.push(fields.join('\n'), '')
  if (note.summary) parts.push(note.summary, '')
  for (const q of quotes) parts.push(`> ${q}`)

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * Render a run's notes, assigning each a unique filename. Names should already
 * be unique after dedup; the numeric suffix is a backstop so two notes can never
 * clobber the same file on disk.
 *
 * `reserved` names are taken before the first note is placed — the run writes
 * the source book as a note of its own (`artifact.sourceNoteName`), and an
 * extracted concept titled like the book would otherwise overwrite it, taking
 * the book's text out of the run and pointing every `source::` edge at a
 * concept. De-collision is case-insensitive, matching the collision it guards
 * against on case-insensitive filesystems.
 */
export function emitNotes(
  notes: GroundedNote[],
  opts: { reserved?: string[] } = {}
): EmittedNote[] {
  const used = new Map<string, number>()
  for (const r of opts.reserved ?? []) used.set(noteName(r).toLowerCase(), 1)
  return notes.map((note) => {
    const base = noteName(note.title)
    const seen = used.get(base.toLowerCase()) ?? 0
    used.set(base.toLowerCase(), seen + 1)
    const name = seen === 0 ? base : `${base} ${seen + 1}`
    return { name, fileName: `${name}.md`, content: renderNote(note, name) }
  })
}
