/**
 * Render grounded items into editable, cited markdown notes — the artifact a
 * distill run produces. Pure and dependency-free (no fs here; the orchestrator
 * writes the files). The note shape is chosen so the existing `harvest()` parser
 * turns it into the right graph edges with no special-casing:
 *
 *  - **Body `key:: value` fields** carry the real knowledge edges: `source::` to
 *    the book, and each typed relation (`about::`, `supports::`, …). These become
 *    triples and drive the derived map.
 *  - **Frontmatter** carries display/provenance metadata (`kind`, per-citation
 *    `cite` spans). It uses single-colon YAML, which `harvest()` ignores — so the
 *    span provenance never pollutes the graph with citation ghost-nodes.
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

/** Base note name from a source file path (basename without `.md`). */
function sourceName(file: string): string {
  return (file.split(/[/\\]/).pop() ?? file).replace(/\.md$/i, '')
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
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** Render one note's markdown. `name` overrides the title-derived note name
 *  (used when a run de-collides duplicate names). */
export function renderNote(note: GroundedNote, name = noteName(note.title)): string {
  const sources = [...new Set(note.citations.map((c) => sourceName(c.file)))]

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
 */
export function emitNotes(notes: GroundedNote[]): EmittedNote[] {
  const used = new Map<string, number>()
  return notes.map((note) => {
    const base = noteName(note.title)
    const seen = used.get(base.toLowerCase()) ?? 0
    used.set(base.toLowerCase(), seen + 1)
    const name = seen === 0 ? base : `${base} ${seen + 1}`
    return { name, fileName: `${name}.md`, content: renderNote(note, name) }
  })
}
