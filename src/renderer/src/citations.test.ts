import { describe, it, expect } from 'vitest'
import { parseCitations } from './citations'

const note = `---
kind: claim
source: Federalist Papers.md
cite:
  - chunk: 10
    span: 100-130
  - chunk: 12
    span: 200-240
---
# Extended republic

source:: [[Federalist Papers]]

A large republic dilutes faction.
`

describe('parseCitations', () => {
  it('reads source + each cite span from the frontmatter', () => {
    expect(parseCitations(note)).toEqual([
      { source: 'Federalist Papers', chunk: 10, start: 100, end: 130 },
      { source: 'Federalist Papers', chunk: 12, start: 200, end: 240 }
    ])
  })

  it('returns nothing for a note without frontmatter or cites', () => {
    expect(parseCitations('# Plain note\n\nno frontmatter')).toEqual([])
    expect(parseCitations('---\nkind: note\n---\n# x')).toEqual([])
  })

  it('ignores a zero/negative span and strips the .md from the source', () => {
    const bad = '---\nsource: Book.md\ncite:\n  - chunk: 1\n    span: 50-50\n---\n'
    expect(parseCitations(bad)).toEqual([])
  })
})
