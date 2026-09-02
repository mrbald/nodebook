/**
 * Naming a run — the two pure steps between "the user picked this file" and a
 * folder under `.distill/`. Pure and dependency-free so both rules are
 * unit-tested; `index.ts` only wires them to the picked path and the runs list.
 *
 * The rules have to agree with `artifact.assertRunId`, which is what actually
 * refuses a bad id: it compares reserved names case-INSENSITIVELY, so a run
 * called `Sources` is rejected exactly like `sources`. De-colliding here has to
 * work the same way, or a document named `Sources.pdf` would be handed an id
 * that passes this check and then throws on the first write.
 */

import { basename } from 'path'

/** A safe, readable run id from a document path (basename, sanitized). */
export function distillRunId(file: string): string {
  const base = basename(file).replace(/\.[^.]+$/, '')
  return (
    base
      .replace(/[^A-Za-z0-9 ._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 80) || 'run'
  )
}

/** De-collide a run id against already-staged runs (and the reserved names):
 *  distilling two documents with the same basename must not silently replace
 *  the earlier run. Case-insensitive, like every other name comparison here —
 *  the filesystems this ships on are, and so is `assertRunId`. */
export function uniqueRunId(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
