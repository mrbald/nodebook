import { describe, it, expect } from 'vitest'
import { buildFileTree, type TreeNode } from './fileTreeModel'
import type { MarkdownFile } from '@shared/types'

const mk = (rel: string): MarkdownFile => ({
  path: `/v/${rel}`,
  name: rel.split('/').pop()!.replace(/\.md$/i, ''),
  rel
})

const names = (nodes: TreeNode[]): string[] => nodes.map((n) => n.name)

describe('buildFileTree', () => {
  it('nests files under their folders, folders before files, both sorted', () => {
    const tree = buildFileTree([mk('welcome.md'), mk('Graph Model.md'), mk('projects/Roadmap.md')])
    expect(names(tree)).toEqual(['projects', 'Graph Model', 'welcome'])
    const projects = tree[0]
    expect(projects.type).toBe('folder')
    if (projects.type === 'folder') expect(names(projects.children)).toEqual(['Roadmap'])
  })

  it('compacts single-child folder chains into one row', () => {
    const tree = buildFileTree([mk('a/b/c/Note.md')])
    expect(names(tree)).toEqual(['a/b/c'])
    const node = tree[0]
    expect(node.type === 'folder' && node.path).toBe('a/b/c')
    if (node.type === 'folder') expect(names(node.children)).toEqual(['Note'])
  })

  it('does NOT compact a folder that also holds files', () => {
    // `a` has a file (Top) and a subfolder (b) → stays its own level.
    const tree = buildFileTree([mk('a/Top.md'), mk('a/b/Deep.md')])
    expect(names(tree)).toEqual(['a'])
    const a = tree[0]
    expect(a.type).toBe('folder')
    if (a.type === 'folder') {
      expect(names(a.children)).toEqual(['b', 'Top']) // folder before file
      const b = a.children[0]
      if (b.type === 'folder') expect(names(b.children)).toEqual(['Deep'])
    }
  })

  it('carries the file through on leaf nodes', () => {
    const tree = buildFileTree([mk('welcome.md')])
    const leaf = tree[0]
    expect(leaf.type).toBe('file')
    if (leaf.type === 'file') expect(leaf.file.rel).toBe('welcome.md')
  })

  it('shows empty directories passed via the dirs list', () => {
    const tree = buildFileTree([mk('welcome.md')], ['archive', 'projects'])
    expect(names(tree)).toEqual(['archive', 'projects', 'welcome'])
    const archive = tree[0]
    expect(archive.type).toBe('folder')
    if (archive.type === 'folder') expect(archive.children).toHaveLength(0)
  })
})
