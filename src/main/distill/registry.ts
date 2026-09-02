/**
 * The concept registry — what the model already named, carried into the next
 * call.
 *
 * Reading a document window by window means the model meets the same idea many
 * times without ever seeing what it called that idea an hour ago. Left alone it
 * invents a fresh title each time ("Faction", "Factions", "The problem of
 * faction"), so the map comes out as parallel piles that only dedup's fuzzy
 * matching can partly rescue, and cross-window links are impossible: a note
 * cannot link to a title it has never seen.
 *
 * So each call carries the titles grounded so far, most recent first, cut at a
 * weight budget. Most recent first is the useful order under a budget: the
 * concepts of the pages just read are the ones the next pages are most likely
 * to be about, and a book's earlier vocabulary drops off the end rather than
 * crowding out its current one.
 *
 * Pure and dependency-free: an ordered set of strings plus a renderer. It never
 * decides anything — the model may ignore it, and grounding still checks every
 * quote.
 */

import { weightOf } from '../rag/chunk'

/** Opening line of the rendered block: what the list is, and what to do with
 *  it. Kept short — it is paid for out of the same budget as the titles. */
const HEADER =
  'Known concepts so far — reuse these exact titles and link to them when the text discusses them:'

export class ConceptRegistry {
  /** Titles in most-recent-first order; the key is the case-folded title, so
   *  the same name never appears twice in the block. */
  private readonly seen = new Map<string, string>()

  /** Record the titles one window produced. Later windows win: a title seen
   *  again moves back to the front, because that is where the reading is now. */
  add(titles: readonly string[]): void {
    for (const raw of titles) {
      const title = raw.trim()
      if (!title) continue
      const key = title.toLowerCase()
      this.seen.delete(key)
      this.seen.set(key, title)
    }
  }

  /** Titles known so far, most recent first. */
  titles(): string[] {
    return [...this.seen.values()].reverse()
  }

  /**
   * The prompt block, at most `budgetWeight` weight units (see `weightOf`).
   * Empty string when nothing is known yet, or when the budget cannot even
   * hold the header — an empty block is better than a truncated instruction.
   */
  render(budgetWeight: number): string {
    const titles = this.titles()
    if (titles.length === 0) return ''
    let weight = weightOf(HEADER)
    if (weight > budgetWeight) return ''
    const lines: string[] = []
    for (const title of titles) {
      const line = `- ${title}`
      const cost = weightOf(line) + 1 // + the newline that joins it
      if (weight + cost > budgetWeight) break
      lines.push(line)
      weight += cost
    }
    if (lines.length === 0) return ''
    return [HEADER, ...lines].join('\n')
  }
}
