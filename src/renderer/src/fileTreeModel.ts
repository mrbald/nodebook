import type { MarkdownFile } from '@shared/types'

/**
 * Builds the sidebar tree from the flat vault file list.
 *
 * "Folder" means exactly a filesystem directory under the vault — the tree
 * mirrors the directory structure encoded in each file's `rel` path. Folders
 * sort before files; both alphabetical.
 *
 * Single-child folder chains are *compacted* into one row (JetBrains "compact
 * middle packages"): a folder that contains only one subfolder and no files of
 * its own is merged with that subfolder, so `a/b/c` shows as one `a/b/c` node
 * instead of three near-empty levels.
 *
 * Pure and DOM-free — unit-tested.
 */

export type TreeNode =
  | { type: 'folder'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; file: MarkdownFile }

interface RawFolder {
  folders: Map<string, RawFolder>
  files: MarkdownFile[]
}

function emptyFolder(): RawFolder {
  return { folders: new Map(), files: [] }
}

function ensureFolder(root: RawFolder, parts: string[]): RawFolder {
  let cur = root
  for (const seg of parts) {
    if (!seg) continue
    let next = cur.folders.get(seg)
    if (!next) {
      next = emptyFolder()
      cur.folders.set(seg, next)
    }
    cur = next
  }
  return cur
}

export function buildFileTree(files: MarkdownFile[], dirs: string[] = []): TreeNode[] {
  const root = emptyFolder()
  // Pre-create every directory so empty folders still appear in the tree.
  for (const d of dirs) ensureFolder(root, d.split('/'))
  for (const f of files) {
    const parts = f.rel.split('/')
    ensureFolder(root, parts.slice(0, -1)).files.push(f)
  }
  return toNodes(root, '')
}

function toNodes(folder: RawFolder, prefix: string): TreeNode[] {
  const nodes: TreeNode[] = []

  for (const name of [...folder.folders.keys()].sort((a, b) => a.localeCompare(b))) {
    let sub = folder.folders.get(name)!
    let label = name
    let path = prefix ? `${prefix}/${name}` : name
    // Compact a chain of single-subfolder, file-less folders into one row.
    while (sub.folders.size === 1 && sub.files.length === 0) {
      const [childName, childFolder] = [...sub.folders.entries()][0]
      label = `${label}/${childName}`
      path = `${path}/${childName}`
      sub = childFolder
    }
    nodes.push({ type: 'folder', name: label, path, children: toNodes(sub, path) })
  }

  for (const f of [...folder.files].sort((a, b) => a.name.localeCompare(b.name))) {
    nodes.push({ type: 'file', name: f.name, file: f })
  }

  return nodes
}
