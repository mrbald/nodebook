/**
 * What a note's `same_as` twins say, prepared for the reading panel.
 *
 * A merge can mark two notes as one idea (`same_as:: [[Other]]`), and the map
 * already draws them as one dot. The reader still has one file open, so the
 * panel gathers the other file's gist and its citations and shows them beside
 * the note's own. Nothing is written: the union exists only while the note is
 * being read.
 *
 * Pure, so it is unit-tested; the panel does the reading and the rendering.
 */

import type { NoteCitation } from './citations'

export { noteGist, quoteLine, type NoteGist } from '../../shared/markdown/noteGist'

/** A citation as the panel shows it: one from a twin says which note it is from. */
export interface PanelCitation extends NoteCitation {
  /** The twin's name, when this citation came from a twin rather than the note. */
  from?: string
}

/** What one twin contributes to the Sources list. */
export interface TwinCitations {
  name: string
  citations: NoteCitation[]
}

/**
 * Identity of a citation for the union below. A quote names the passage, so two
 * runs that grounded on the same words are the same citation however their
 * offsets drifted. A citation from before quotes were recorded has only its
 * span — and that span is what tells it apart, so quoteless citations from one
 * book must not all collapse onto each other.
 */
function citationKey(c: NoteCitation): string {
  return JSON.stringify(
    c.quote !== undefined ? ['q', c.source, c.quote] : ['s', c.source, c.start, c.end]
  )
}

/**
 * The note's own citations, then each twin's, with nothing said twice. The
 * note's own copy wins, so a passage both notes cite carries no "from" label.
 */
export function unionCitations(own: NoteCitation[], twins: TwinCitations[]): PanelCitation[] {
  const seen = new Set<string>()
  const out: PanelCitation[] = []
  const take = (c: NoteCitation, from?: string): void => {
    const key = citationKey(c)
    if (seen.has(key)) return
    seen.add(key)
    out.push(from === undefined ? c : { ...c, from })
  }
  for (const c of own) take(c)
  for (const twin of twins) for (const c of twin.citations) take(c, twin.name)
  return out
}
