import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

/**
 * Recently-opened vaults. This is *state* (it changes on every open), so it
 * lives in its own `recents.json` under userData rather than churning the user's
 * hand-edited settings.toml. The list is most-recent-first, de-duplicated, and
 * capped; stale paths (deleted folders) are dropped on read.
 */

const MAX_RECENTS = 10

/** Pure: prepend `path` (most-recent-first), de-duplicated, capped at `max`. */
export function pushRecent(list: string[], path: string, max = MAX_RECENTS): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max)
}

function recentsPath(): string {
  return join(app.getPath('userData'), 'recents.json')
}

/** The recent vaults that still exist on disk (most-recent-first). */
export function readRecents(): string[] {
  try {
    const arr = JSON.parse(readFileSync(recentsPath(), 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr.filter((p) => typeof p === 'string' && existsSync(p))
  } catch {
    return []
  }
}

/** Record `path` as the most-recently-opened vault. Best-effort. */
export function addRecent(path: string): void {
  try {
    writeFileSync(recentsPath(), JSON.stringify(pushRecent(readRecents(), path)), 'utf8')
  } catch {
    /* a missing/unwritable userData dir shouldn't break opening a vault */
  }
}

/** Forget all recent vaults. */
export function clearRecents(): void {
  try {
    writeFileSync(recentsPath(), '[]', 'utf8')
  } catch {
    /* ignore */
  }
}
