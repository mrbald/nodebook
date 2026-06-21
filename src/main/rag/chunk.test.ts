import { describe, it, expect } from 'vitest'
import { chunkMarkdown, embedText } from './chunk'

describe('chunkMarkdown', () => {
  it('splits by heading and carries the heading path', () => {
    const doc = ['# Title', '', 'Intro para.', '', '## Section A', '', 'Body of A.'].join('\n')
    const chunks = chunkMarkdown(doc)
    expect(chunks.map((c) => [c.heading, c.text])).toEqual([
      ['Title', 'Intro para.'],
      ['Title > Section A', 'Body of A.']
    ])
  })

  it('emits no chunk for a heading with no body', () => {
    const chunks = chunkMarkdown('# Empty\n\n## Also empty\n')
    expect(chunks).toEqual([])
  })

  it('offsets slice back to (a superset of) the chunk text', () => {
    const doc = '# H\n\nhello world\n'
    const [c] = chunkMarkdown(doc)
    expect(doc.slice(c.start, c.end)).toContain('hello world')
  })

  it('packs multiple paragraphs and splits when over maxChars', () => {
    const para = 'x'.repeat(40)
    const doc = `# H\n\n${para}\n\n${para}\n\n${para}`
    const chunks = chunkMarkdown(doc, 60) // each para ~41 chars, so ~1 per chunk
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.heading === 'H')).toBe(true)
  })

  it('embedText prepends the heading for context', () => {
    expect(embedText({ heading: 'A > B', start: 0, end: 1, text: 'body' })).toBe('A > B\n\nbody')
    expect(embedText({ heading: '', start: 0, end: 1, text: 'body' })).toBe('body')
  })
})
