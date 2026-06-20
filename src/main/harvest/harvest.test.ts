import { describe, it, expect } from 'vitest'
import { harvest } from './index'

describe('harvest', () => {
  it('takes the title from the first H1, else the file name', () => {
    expect(harvest('/v/Note.md', '# My Title\n\nbody').title).toBe('My Title')
    expect(harvest('/v/Some File.md', 'no heading here').title).toBe('Some File')
  })

  it('emits a links_to triple for each wikilink', () => {
    const { triples } = harvest('/v/A.md', 'see [[Graph Model]] and [[B]]')
    expect(triples).toEqual([
      { subject: 'A', relation: 'links_to', object: 'Graph Model' },
      { subject: 'A', relation: 'links_to', object: 'B' }
    ])
  })

  it('strips alias and heading from wikilink targets', () => {
    const { triples } = harvest('/v/A.md', '[[Target|shown text]] [[Other#Section]]')
    expect(triples.map((t) => t.object)).toEqual(['Target', 'Other'])
  })

  it('extracts typed fields, resolving wikilink values to their target', () => {
    const { triples } = harvest('/v/Paper.md', 'author:: [[Jane Doe]]\nstatus:: draft')
    expect(triples).toContainEqual({ subject: 'Paper', relation: 'author', object: 'Jane Doe' })
    expect(triples).toContainEqual({ subject: 'Paper', relation: 'status', object: 'draft' })
  })

  it('does not extract links or fields inside fenced code blocks', () => {
    const doc = ['```', 'see [[NotALink]]', 'key:: not a field', '```', 'real [[Link]]'].join('\n')
    const { triples } = harvest('/v/A.md', doc)
    expect(triples).toEqual([{ subject: 'A', relation: 'links_to', object: 'Link' }])
  })

  it('returns the raw content as the FTS text payload', () => {
    const doc = '# T\n\nsearchable words'
    expect(harvest('/v/T.md', doc).text).toBe(doc)
  })
})
