/**
 * What merging a run into the vault would actually do — decided BEFORE a single
 * byte is written, so the dialog can say it and the user can disagree.
 *
 * Pure and dependency-free (hashes arrive as opaque strings; `artifact.ts` reads
 * the files and computes them), so every rule here is unit-tested.
 *
 * Three outcomes per staged note, and the middle one is the point:
 *
 *  - **new** — no note of that name anywhere in the vault. It lands under its
 *    own name.
 *  - **identical** — a vault note of that name already holds exactly these
 *    bytes. Writing it again would be a no-op, so it is skipped.
 *  - **collides** — a vault note of that name exists with *different* content.
 *    A NAME CLASH IS NOT EVIDENCE OF IDENTITY: two people can both write a note
 *    called "Options" about different things. So the run's copy is saved beside
 *    it under a disambiguated name — `Options (Sapiens)` — and the user is asked
 *    (per item, unticked by default) whether the two are really the same thing.
 *    Only then does the merge write `same_as:: [[Options]]`, and only then does
 *    the map collapse them into one dot.
 *
 * Names are compared case-insensitively, because that is how the collision would
 * actually happen on macOS and Windows filesystems.
 */

import { noteName } from './link'

/** What a merge would do with one staged note. */
export type MergeAction = 'new' | 'identical' | 'collides'

/** One staged note as the planner sees it. */
export interface RunNote {
  /** Note name (basename without `.md`) — how `[[links]]` address it. */
  name: string
  content: string
  /** Content hash, in whatever scheme the caller uses on both sides. */
  hash: string
}

/** Every note name in the vault, with the hash of the file behind each. */
export interface VaultNotes {
  /** Every note name anywhere in the vault (the index's `noteNames()`). */
  names: Set<string>
  /** name → content hash, for spotting a byte-identical note. */
  hashByName: Map<string, string>
}

/** One line of the merge plan. */
export interface MergePlanEntry {
  /** The staged note's own name. */
  name: string
  action: MergeAction
  /** The name it will be written under — `name` unless it collides. For an
   *  `identical` entry nothing is written at all; the field still names the
   *  vault note it matched. */
  targetName: string
}

/** Lowercase key for the case-insensitive name comparison. */
const key = (s: string): string => s.toLowerCase()

/**
 * Decide, for each staged note, what merging it would do. `sourceTitle` is the
 * document's short name — it becomes the disambiguator, so a collision reads as
 * "the Sapiens one" rather than "the second one".
 *
 * A disambiguated name that is ALSO taken (a previous run of the same book, or
 * two staged notes disambiguating onto the same name) gets ` 2`, ` 3`, … — the
 * plan never hands two notes the same target.
 */
export function mergePlan(
  runNotes: RunNote[],
  vault: VaultNotes,
  sourceTitle: string
): MergePlanEntry[] {
  const vaultNames = new Set([...vault.names].map(key))
  const vaultHashes = new Map([...vault.hashByName].map(([n, h]) => [key(n), h]))
  // Names already spoken for: the vault's, plus every target this plan hands out.
  const taken = new Set(vaultNames)
  const book = noteName(sourceTitle)

  return runNotes.map((note) => {
    const k = key(note.name)
    if (!vaultNames.has(k)) {
      taken.add(k)
      return { name: note.name, action: 'new' as const, targetName: note.name }
    }
    if (vaultHashes.get(k) === note.hash)
      return { name: note.name, action: 'identical' as const, targetName: note.name }

    const base = noteName(`${note.name} (${book})`)
    let target = base
    for (let n = 2; taken.has(key(target)); n++) target = `${base} ${n}`
    taken.add(key(target))
    return { name: note.name, action: 'collides' as const, targetName: target }
  })
}

// ---------------------------------------------------------------------------
// Links follow renames
// ---------------------------------------------------------------------------

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]` — the same shape the
 *  editor, `harvest()` and `markdownRender` all read. */
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g

/**
 * Re-point every `[[link]]` whose target was renamed by the merge plan, leaving
 * everything else byte-identical.
 *
 * This is what stops a disambiguated merge from shredding the run's own map: if
 * `Faction` lands as `Faction (Federalist)`, then a sibling note's
 * `about:: [[Faction]]` has to follow it, or the run arrives in the vault with a
 * dead link pointing at somebody else's note. Body fields (`key:: [[X]]`) are
 * plain wikilinks, so one pass covers them too.
 *
 * Only the TARGET moves: the alias after `|` and the anchor after `#` are the
 * user-visible text and the heading, and both are preserved exactly — as is any
 * whitespace padding inside the brackets.
 */
export function rewriteLinks(content: string, renames: Map<string, string>): string {
  if (renames.size === 0) return content
  const by = new Map([...renames].map(([from, to]) => [key(from), to]))
  return content.replace(WIKILINK_RE, (whole, inner: string) => {
    const cut = inner.search(/[|#]/)
    const rawTarget = cut < 0 ? inner : inner.slice(0, cut)
    const rest = cut < 0 ? '' : inner.slice(cut)
    const to = by.get(key(rawTarget.trim()))
    if (to === undefined) return whole
    // Keep the original padding, so only the name itself changes.
    const lead = rawTarget.slice(0, rawTarget.length - rawTarget.trimStart().length)
    const trail = rawTarget.slice(rawTarget.trimEnd().length)
    return `[[${lead}${to}${trail}${rest}]]`
  })
}

/** The body field a confirmed "same as" writes (consumed by `buildGraph`). */
export const SAME_AS = 'same_as'

/**
 * Record the user's confirmation that this note IS the vault's `original`, as
 * one body line the map reads and a person can delete. It goes right after the
 * `source::` field, where the note's other provenance lives; a note with no
 * such field (the source document's own copy) gets it as the first body line.
 */
export function withSameAs(content: string, original: string): string {
  const line = `${SAME_AS}:: [[${original}]]`
  const lines = content.split('\n')
  let at = -1
  for (let i = 0; i < lines.length; i++) if (/^source::\s/.test(lines[i])) at = i
  if (at < 0) {
    // No `source::` field: put it after the frontmatter block, else at the top.
    const fm = /^---\n[\s\S]*?\n---\n/.exec(content)
    return fm ? `${fm[0]}${line}\n${content.slice(fm[0].length)}` : `${line}\n${content}`
  }
  lines.splice(at + 1, 0, line)
  return lines.join('\n')
}
