import { describe, it, expect } from 'vitest'
import { withinRoot, ignoredInVault } from './paths'

describe('withinRoot', () => {
  const root = '/Users/x/vault'

  it('accepts the root itself and files inside it', () => {
    expect(withinRoot(root, root)).toBe(true)
    expect(withinRoot(root, `${root}/a.md`)).toBe(true)
    expect(withinRoot(root, `${root}/deep/dir/b.md`)).toBe(true)
  })

  it('rejects the sibling-prefix trick (/vault2)', () => {
    expect(withinRoot(root, `${root}2/a.md`)).toBe(false)
  })

  it('rejects .. traversal that escapes the root', () => {
    expect(withinRoot(root, `${root}/../../etc/passwd`)).toBe(false)
    expect(withinRoot(root, `${root}/a/../../../etc/passwd`)).toBe(false)
  })

  it('accepts .. segments that stay inside the root', () => {
    expect(withinRoot(root, `${root}/a/../b.md`)).toBe(true)
  })

  it('rejects unrelated absolute paths', () => {
    expect(withinRoot(root, '/etc/passwd')).toBe(false)
  })
})

describe('ignoredInVault', () => {
  it('ignores dot-dirs inside the vault', () => {
    const ig = ignoredInVault('/Users/x/vault')
    expect(ig('/Users/x/vault/.nodebook/index.db')).toBe(true)
    expect(ig('/Users/x/vault/.git/HEAD')).toBe(true)
    expect(ig('/Users/x/vault/sub/.hidden')).toBe(true)
  })

  it('does not ignore normal notes', () => {
    const ig = ignoredInVault('/Users/x/vault')
    expect(ig('/Users/x/vault')).toBe(false)
    expect(ig('/Users/x/vault/note.md')).toBe(false)
    expect(ig('/Users/x/vault/sub/note.md')).toBe(false)
  })

  it('still watches a vault that lives under a dotted ancestor', () => {
    const ig = ignoredInVault('/home/u/.local/share/notes')
    expect(ig('/home/u/.local/share/notes')).toBe(false)
    expect(ig('/home/u/.local/share/notes/note.md')).toBe(false)
    expect(ig('/home/u/.local/share/notes/.nodebook/index.db')).toBe(true)
  })
})
