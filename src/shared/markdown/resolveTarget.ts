/** The folder a path sits in ('' at the root), separator-normalised. */
function folderOf(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? '' : norm.slice(0, i)
}

/** Where a link target landed: a real note's path, or `ghost:<target>`. */
export interface ResolvedTarget {
  id: string
  /** The normalised target text, for counting ambiguous *targets* not edges. */
  key: string
  ambiguous: boolean
}

/**
 * Resolve a link target to a real note by name OR by path suffix (so
 * `[[projects/Roadmap]]` finds `projects/Roadmap.md`), matching the editor's
 * link resolver. Exactly one file with that name wins outright; several prefer
 * one in the linking note's own folder, else the lexicographically smallest
 * path — and either way the target is reported as ambiguous, because the link
 * really could have meant either note; none is a ghost. Matching is
 * case-sensitive, so a target that differs only in case is a ghost.
 */
export function targetResolver(paths: string[]): (object: string, from: string) => ResolvedTarget {
  // Every suffix keeps *all* of its files, because a name is not an identity:
  // several files can answer to it.
  const suffixToPaths = new Map<string, string[]>()
  for (const path of paths) {
    const segs = path
      .replace(/\.md$/i, '')
      .split(/[/\\]/)
      .filter(Boolean)
    for (let i = segs.length - 1; i >= 0; i--) {
      const key = segs.slice(i).join('/')
      const list = suffixToPaths.get(key)
      if (list) list.push(path)
      else suffixToPaths.set(key, [path])
    }
  }
  for (const list of suffixToPaths.values()) list.sort()

  return (object: string, from: string): ResolvedTarget => {
    const key = object
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\.md$/i, '')
    const cands = suffixToPaths.get(key)
    if (!cands || cands.length === 0) return { id: `ghost:${object}`, key, ambiguous: false }
    if (cands.length === 1) return { id: cands[0], key, ambiguous: false }
    const folder = folderOf(from)
    const sameFolder = cands.find((p) => folderOf(p) === folder)
    return { id: sameFolder ?? cands[0], key, ambiguous: true }
  }
}
