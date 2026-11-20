import type { BookNoteRef } from '../../shared/types'

/** Only offer another level when it would shorten a substantial note list. */
const MIN_NOTES = 60
const MAX_GROUPS = 8
const STOP_WORDS = new Set(
  'a an and are as at be by can for from has have in is it its of on or than that the their these this to use using via was what when where which with without figure listing section'.split(' ')
)

interface TitleGroup {
  key: string
  label: string
  members: string[]
}

interface Candidate extends Omit<TitleGroup, 'key'> {
  terms: string[]
  leading: number
  namedByWholeTitle: boolean
}

function words(title: string): string[] {
  return title.normalize('NFC').match(/[\p{L}\p{M}\p{N}]+(?:[-‐‑'’][\p{L}\p{M}\p{N}]+)*/gu) ?? []
}

function informative(word: string): boolean {
  return /\p{L}/u.test(word) && !STOP_WORDS.has(word)
}

/** Keep inflections of an English parent heading from turning into subthemes. */
function parentTerm(word: string): string {
  return /^[a-z]{5,}$/.test(word) ? word.replace(/(?:ing|s)$/, '') : word
}

/** Group only titles that actually share a distinguishing term or phrase. */
export function titleSubthemes(notes: BookNoteRef[], parentLabel: string): TitleGroup[] {
  if (notes.length < MIN_NOTES) return []
  const minimum = Math.max(4, Math.min(12, Math.ceil(notes.length * 0.03)))
  const maximum = notes.length / 2
  const parentTerms = new Set(words(parentLabel).map((word) => parentTerm(word.toLowerCase())))
  const distinguishes = (word: string): boolean => informative(word) && !parentTerms.has(parentTerm(word))
  const candidates = new Map<string, Candidate>()
  for (const { id, title } of notes) {
    const tokens = words(title)
    const keys = tokens.map((word) => word.toLowerCase())
    const first = keys.findIndex(informative)
    const seen = new Set<string>()
    for (let start = 0; start < keys.length; start++) {
      if (!informative(keys[start])) continue
      for (let end = start + 1; end <= Math.min(start + 3, keys.length); end++) {
        if (!informative(keys[end - 1])) continue
        const terms = keys.slice(start, end)
        if (!terms.some(distinguishes)) continue
        const key = terms.join(' ')
        if (seen.has(key)) continue
        seen.add(key)
        const candidate = candidates.get(key) ?? {
          label: tokens.slice(start, end).join(' '),
          terms,
          members: [],
          leading: 0,
          namedByWholeTitle: false
        }
        candidate.members.push(id)
        if (start === first) candidate.leading++
        if (start === 0 && end === keys.length) candidate.namedByWholeTitle = true
        candidates.set(key, candidate)
      }
    }
  }

  const options = [...candidates]
    .filter(([, { members, terms, namedByWholeTitle, leading }]) =>
      members.length >= minimum && members.length <= maximum &&
      // A word used only in passing is a weak heading on its own.
      (terms.length > 1 || namedByWholeTitle || leading >= members.length / 3)
    )
    .map(([key, { label, terms, members }]) => {
      // Prefer a more readable phrase when it accounts for much of the support
      // for the words that distinguish it from its parent theme.
      const support = Math.max(...terms
        .filter(distinguishes)
        .map((term) => candidates.get(term)?.members.length ?? 0))
      const bonus = terms.length > 1 && members.length >= support * 0.55 ? 1.35 : 1
      return { key, label, members, bonus }
    })
  const used = new Set<string>()
  const groups: TitleGroup[] = []
  while (groups.length < MAX_GROUPS) {
    const scored = options.map(({ key, label, members, bonus }) => {
      const available = members.filter((id) => !used.has(id))
      return { key, label, members: available, score: available.length * bonus }
    }).filter(({ members }) => members.length >= minimum)
    scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const best = scored[0]
    if (!best) break
    for (const id of best.members) used.add(id)
    groups.push({
      key: best.key,
      label: best.label.replace(/^\p{L}/u, (first) => first.toUpperCase()),
      members: best.members
    })
  }
  return groups.length >= 2 && used.size >= notes.length * 0.35 ? groups : []
}
