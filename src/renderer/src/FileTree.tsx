import { useMemo, useState } from 'react'
import type { MarkdownFile } from '@shared/types'
import { buildFileTree, type TreeNode } from './fileTreeModel'

export type ContextTarget =
  | { kind: 'file'; file: MarkdownFile }
  | { kind: 'folder'; path: string }
  | { kind: 'root' }

interface FileTreeProps {
  files: MarkdownFile[]
  dirs?: string[]
  active: MarkdownFile | null
  /** Whether the active file has unsaved edits (shows a • on it). */
  dirty?: boolean
  onOpen: (f: MarkdownFile) => void
  onContextMenu?: (target: ContextTarget, x: number, y: number) => void
}

interface FolderNodeProps {
  node: Extract<TreeNode, { type: 'folder' }>
  active: MarkdownFile | null
  dirty?: boolean
  onOpen: (f: MarkdownFile) => void
  depth: number
  onContextMenu?: (target: ContextTarget, x: number, y: number) => void
}

function FolderNode({ node, active, dirty, onOpen, depth, onContextMenu }: FolderNodeProps) {
  const [open, setOpen] = useState(true)

  return (
    <li>
      <div
        className="tree-folder"
        style={{ paddingLeft: depth * 12 + 10 }}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu?.({ kind: 'folder', path: node.path }, e.clientX, e.clientY)
        }}
      >
        <span className="tree-toggle">{open ? '▾' : '▸'}</span>
        {node.name}
      </div>
      {open && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeItem key={child.type === 'folder' ? child.path : child.file.path} node={child} active={active} dirty={dirty} onOpen={onOpen} depth={depth + 1} onContextMenu={onContextMenu} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface TreeItemProps {
  node: TreeNode
  active: MarkdownFile | null
  dirty?: boolean
  onOpen: (f: MarkdownFile) => void
  depth: number
  onContextMenu?: (target: ContextTarget, x: number, y: number) => void
}

function TreeItem({ node, active, dirty, onOpen, depth, onContextMenu }: TreeItemProps) {
  if (node.type === 'folder') {
    return (
      <FolderNode
        node={node}
        active={active}
        dirty={dirty}
        onOpen={onOpen}
        depth={depth}
        onContextMenu={onContextMenu}
      />
    )
  }

  const isActive = active?.path === node.file.path
  return (
    <li>
      <div
        className={`tree-file${isActive ? ' active' : ''}`}
        style={{ paddingLeft: depth * 12 + 10 }}
        onClick={() => onOpen(node.file)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu?.({ kind: 'file', file: node.file }, e.clientX, e.clientY)
        }}
      >
        <span className="tree-name">{node.name}</span>
        {isActive && dirty && <span className="tree-dirty">●</span>}
      </div>
    </li>
  )
}

export function FileTree({ files, dirs, active, dirty, onOpen, onContextMenu }: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(files, dirs ?? []), [files, dirs])

  return (
    <ul
      className="file-tree"
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.({ kind: 'root' }, e.clientX, e.clientY)
      }}
    >
      {tree.map((node) => (
        <TreeItem
          key={node.type === 'folder' ? node.path : node.file.path}
          node={node}
          active={active}
          dirty={dirty}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          depth={0}
        />
      ))}
    </ul>
  )
}
