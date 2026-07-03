import { resolve, relative } from 'path'
import { sep } from 'path'

/**
 * True only if `p` — after resolving `.`/`..` segments — is `root` or strictly
 * inside it. Resolving first is the security fix: a raw prefix check passes
 * `/vault/../../etc/passwd`. `root` must already be canonical (it is
 * realpath'd at vault pick/create).
 */
export function withinRoot(root: string, p: string): boolean {
  const r = resolve(p)
  return r === root || r.startsWith(root + sep)
}

/**
 * Chokidar ignore predicate for a vault: ignore dot-files/dirs *inside* the
 * vault (.nodebook/, .git/, …). The test runs on the path relative to the
 * vault root — testing the absolute path would silently kill the watcher for
 * a vault under a dotted ancestor (e.g. ~/.local/share/notes).
 */
export function ignoredInVault(root: string): (p: string) => boolean {
  return (p: string) => /(^|[/\\])\.[^/\\]/.test(relative(root, p))
}
