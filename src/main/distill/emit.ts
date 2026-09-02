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
 * Emitting is two passes, because a link target can only be resolved once every
 * final name is known: first every note gets its name (de-collided), then
 * `link.ts` remaps every `[[target]]` onto those names and adds mention links,
 * then the markdown is rendered. `emitRun` reports what that cost — how many
 * links were written, how many still point nowhere, and how connected the
 * result is.
 */

import type { GroundedNote, Link } from './extract'
import { linkNotes, noteName } from './link'

export { noteName }

export interface EmittedNote {
  /** Basename without extension; also how `[[links]]` reference this note. */
  name: string
  /** `${name}.md`. */
  fileName: string
  /** Full markdown content. */
  content: string
}

const DOC_EXT_RE = /\.(pdf|epub|docx|html|htm|xhtml|md|markdown|txt|text)$/i
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

/** A harvest-valid relation name (`[A-Za-z][\w -]*`), or '' to skip the link.
 *  The relations that reach here are the extractor's controlled vocabulary
 *  (see `extract.ts`), `related_to`, and link.ts's `mentions`; this stays a
 *  sanitizer so a hand-built note can never emit a field harvest won't parse. */
function relationName(relation: string): string {
  const clean = relation.trim().replace(/[^A-Za-z0-9_ -]/g, '_')
  return /^[A-Za-z]/.test(clean) ? clean : ''
}

function frontmatter(note: GroundedNote, sources: string[], citeOffset = 0): string {
  const lines = ['---', `kind: ${note.kind}`]
  if (sources.length) lines.push(`source: ${sources.join(', ')}`)
  if (note.citations.length) {
    lines.push('cite:')
    for (const c of note.citations) {
      lines.push(`  - chunk: ${c.chunkId}`)
      // Offsets are into the BOOK NOTE, which is the converted text behind a
      // frontmatter header — so the header's length is added here, once, and
      // the citation panel can select the span with no arithmetic of its own.
      lines.push(`    span: ${c.start + citeOffset}-${c.end + citeOffset}`)
      // Where a reader would say the quote is: "Page 42", or the chapter's
      // name. JSON-escaped, like the quote below, because a heading can hold
      // anything.
      if (c.where) lines.push(`    where: ${JSON.stringify(c.where)}`)
      // JSON-string-escaped: the quote can contain anything (quotes, newlines,
      // colons) and this stays a valid single-line YAML double-quoted scalar,
      // so an old parser that only reads chunk+span still ignores it safely.
      lines.push(`    quote: ${JSON.stringify(c.quote)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** What a converted document's own note looks like on disk. */
export interface DocumentNote {
  /** The note's full markdown: a frontmatter header, then the converted text. */
  content: string
  /** Where the converted text starts inside `content`. Every citation span is
   *  recorded against the note, so this is what `emitRun` shifts them by. */
  citeOffset: number
}

/**
 * Render the converted document itself as a note.
 *
 * `kind: document` is the important line: it tells the index this is a whole
 * book, not something you wrote, so the book is searchable but never parsed for
 * knowledge edges, never averaged into "related notes", and never drawn as a
 * hub on the map. `document:` keeps the path it came from (JSON-escaped, so a
 * path with quotes or a colon stays one valid YAML scalar) and `hash:` its
 * identity in the source store — together they are what "Open original" needs.
 *
 * Nothing is added AFTER the header, so `content.slice(citeOffset)` is exactly
 * the converted text and every recorded span still lands on the right words.
 */
export function renderDocumentNote(source: {
  text: string
  originalPath?: string
  hash?: string
}): DocumentNote {
  const lines = ['---', 'kind: document']
  if (source.originalPath) lines.push(`document: ${JSON.stringify(source.originalPath)}`)
  if (source.hash) lines.push(`hash: ${source.hash}`)
  lines.push('---', '', '')
  const header = lines.join('\n')
  return { content: header + source.text, citeOffset: header.length }
}

/** A note's quotes as they are rendered: whitespace-collapsed, de-duplicated,
 *  in citation order. Also what mention linking reads (see `link.ts`). */
export function quotesOf(note: GroundedNote): string[] {
  return [...new Set(note.citations.map((c) => c.quote.replace(/\s+/g, ' ').trim()))]
}

/** Render one note's markdown. `name` overrides the title-derived note name
 *  (used when a run de-collides duplicate names); `links` overrides the item's
 *  own links (used after `link.ts` has remapped them); `citeOffset` shifts the
 *  citation spans onto the book note (see `renderDocumentNote`). */
export function renderNote(
  note: GroundedNote,
  name = noteName(note.title),
  links: Link[] = note.links,
  citeOffset = 0
): string {
  // One name for the source everywhere — frontmatter, body link, book note
  // file — so it always resolves (see the module header).
  const sources = [...new Set(note.citations.map((c) => noteName(sourceTitle(c.file))))]

  const fields: string[] = []
  for (const s of sources) fields.push(`source:: [[${s}]]`)
  for (const l of links) {
    const rel = relationName(l.relation)
    const target = noteName(l.target)
    if (rel && target) fields.push(`${rel}:: [[${target}]]`)
  }

  const quotes = quotesOf(note)

  const parts = [frontmatter(note, sources, citeOffset), '', `# ${name}`, '']
  if (fields.length) parts.push(fields.join('\n'), '')
  if (note.summary) parts.push(note.summary, '')
  for (const q of quotes) parts.push(`> ${q}`)

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export interface EmitOptions {
  /** Names no emitted note may take (see `emitRun`). */
  reserved?: string[]
  /** dedup's {absorbed title → surviving title} map, so a link written before
   *  the merge still finds its note (see `link.ts`). */
  aliases?: Map<string, string>
  /** Add mention links (default true; see `link.ts`). */
  mentions?: boolean
  /** Where the converted text starts inside the book note — every citation
   *  span is recorded against that note, not against the bare text. Comes from
   *  `renderDocumentNote(source).citeOffset`; 0 means "the note IS the text". */
  citeOffset?: number
}

/** A run's rendered notes, plus what its link graph came out as. */
export interface EmitResult {
  notes: EmittedNote[]
  /** Links written across all notes, `source::` excluded, ghosts included. */
  edges: number
  /** Of those, how many point at no emitted note. */
  ghostLinks: number
  /** Of those, how many came from a name found in a note's own text. */
  mentions: number
  /** Connected components over the emitted notes (links read as undirected). */
  components: number
  /** Each note's final links, parallel to `notes` — what the markdown was
   *  rendered from. The themes pass adds to these and re-counts the graph. */
  links: Link[][]
}

/**
 * Turn titles into unique note names. Names should already be unique after
 * dedup; the numeric suffix is a backstop so two notes can never clobber the
 * same file on disk.
 *
 * `reserved` names are taken before the first title is placed — the run writes
 * the source book as a note of its own (`artifact.sourceNoteName`), and an
 * extracted concept titled like the book would otherwise overwrite it, taking
 * the book's text out of the run and pointing every `source::` edge at a
 * concept. De-collision is case-insensitive, matching the collision it guards
 * against on case-insensitive filesystems.
 *
 * Themes are named the same way, against the notes already placed, so a theme
 * can never take a note's file (see `run.ts`).
 */
export function dedupeNames(titles: string[], reserved: string[] = []): string[] {
  const used = new Map<string, number>()
  for (const r of reserved) used.set(noteName(r).toLowerCase(), 1)
  return titles.map((title) => {
    const base = noteName(title)
    const seen = used.get(base.toLowerCase()) ?? 0
    used.set(base.toLowerCase(), seen + 1)
    return seen === 0 ? base : `${base} ${seen + 1}`
  })
}

/**
 * Render a run's notes: name them, resolve their links against those names
 * (`link.ts`), then write the markdown. Two passes, because a `[[target]]` can
 * only be checked once every final name exists.
 */
export function emitRun(notes: GroundedNote[], opts: EmitOptions = {}): EmitResult {
  const names = dedupeNames(
    notes.map((n) => n.title),
    opts.reserved
  )
  const linked = linkNotes(
    notes.map((note, i) => ({
      title: note.title,
      name: names[i],
      summary: note.summary,
      quotes: quotesOf(note),
      links: note.links
    })),
    { aliases: opts.aliases, mentions: opts.mentions }
  )
  return {
    notes: notes.map((note, i) => ({
      name: names[i],
      fileName: `${names[i]}.md`,
      content: renderNote(note, names[i], linked.links[i], opts.citeOffset)
    })),
    edges: linked.edges,
    ghostLinks: linked.ghostLinks,
    mentions: linked.mentions,
    components: linked.components,
    links: linked.links
  }
}

/** `emitRun`'s notes alone, for callers that don't need the link counts. */
export function emitNotes(notes: GroundedNote[], opts: EmitOptions = {}): EmittedNote[] {
  return emitRun(notes, opts).notes
}

// --- Themes -----------------------------------------------------------------
// A theme note is the group's page: it says what it is (`kind: theme`), which
// book it came from, and lists its members. The edge that puts a note UNDER a
// theme is written on the note itself (`part_of::`, added by `attachThemes`) —
// so the map gets one arrow per note, pointing up, exactly like `source::`.

/** The relation a note carries to its theme. Part of `extract.ts`'s controlled
 *  vocabulary, so the map colours it like any other typed edge. */
export const THEME_RELATION = 'part_of'

export interface ThemeNote {
  /** The theme's final (de-collided) note name. */
  name: string
  /** Member note names, in the order they are listed. */
  members: string[]
  /** The book's note name — `source::` target, as on every emitted note. */
  sourceName: string
}

/**
 * Render one theme note. Deliberately wordless apart from the links: the run
 * may be in any language, and an English sentence written into a Russian run's
 * map would be the one thing on it that isn't the book's.
 */
export function renderThemeNote(theme: ThemeNote): string {
  const parts = [
    ['---', 'kind: theme', `source: ${theme.sourceName}`, '---'].join('\n'),
    '',
    `# ${theme.name}`,
    '',
    `source:: [[${theme.sourceName}]]`,
    ''
  ]
  for (const m of theme.members) parts.push(`- [[${m}]]`)
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** A rendered `key:: value` field line (see `harvest()`'s field rule). */
const FIELD_LINE_RE = /^[A-Za-z][\w-]*::\s/

/**
 * Add `part_of:: [[Theme]]` to every note the assignment names, in the field
 * block under its heading — where `source::` and the model's own relations
 * already are, so `harvest()` reads it as one more triple.
 *
 * Rewrites the rendered markdown rather than re-emitting, because themes are
 * decided after names and links are final: re-running the emitter would move
 * the ground the theme names were just de-collided against.
 */
export function attachThemes(
  notes: EmittedNote[],
  assignment: Map<string, string>
): { notes: EmittedNote[]; added: number } {
  let added = 0
  const out = notes.map((note) => {
    const theme = assignment.get(note.name)
    if (!theme || theme === note.name) return note
    added++
    return { ...note, content: withField(note.content, `${THEME_RELATION}:: [[${theme}]]`) }
  })
  return { notes: out, added }
}

/** Insert `field` after the last field line under the note's `# heading`, or
 *  open a field block there when the note has none. */
function withField(content: string, field: string): string {
  const lines = content.split('\n')
  const heading = lines.findIndex((l) => l.startsWith('# '))
  if (heading < 0) return `${content.trimEnd()}\n\n${field}\n`
  let first = heading + 1
  while (first < lines.length && lines[first].trim() === '') first++
  let last = first
  while (last < lines.length && FIELD_LINE_RE.test(lines[last])) last++
  lines.splice(last > first ? last : heading + 1, 0, ...(last > first ? [field] : ['', field]))
  return lines.join('\n')
}
