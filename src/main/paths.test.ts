import { describe, it, expect } from 'vitest'
import { realpathSync } from 'fs'
import { join, parse } from 'path'
import { tmpdir } from 'os'
import { withinRoot, ignoredInVault } from './paths'

const parent = realpathSync(tmpdir())
const root = join(parent, 'vault')

describe('withinRoot', () => {
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
    expect(withinRoot(root, join(parent, 'other', 'note.md'))).toBe(false)
  })

  it('accepts descendants when the vault is the volume root', () => {
    const volume = parse(root).root
    expect(withinRoot(volume, root)).toBe(true)
  })
})

describe('ignoredInVault', () => {
  it('ignores dot-dirs inside the vault', () => {
    const ig = ignoredInVault(root)
    expect(ig(join(root, '.nodebook', 'index.db'))).toBe(true)
    expect(ig(join(root, '.git', 'HEAD'))).toBe(true)
    expect(ig(join(root, 'sub', '.hidden'))).toBe(true)
  })

  it('does not ignore normal notes', () => {
    const ig = ignoredInVault(root)
    expect(ig(root)).toBe(false)
    expect(ig(join(root, 'note.md'))).toBe(false)
    expect(ig(join(root, 'sub', 'note.md'))).toBe(false)
  })

  it('still watches a vault that lives under a dotted ancestor', () => {
    const dottedRoot = join(parent, '.local', 'share', 'notes')
    const ig = ignoredInVault(dottedRoot)
    expect(ig(dottedRoot)).toBe(false)
    expect(ig(join(dottedRoot, 'note.md'))).toBe(false)
    expect(ig(join(dottedRoot, '.nodebook', 'index.db'))).toBe(true)
  })
})
