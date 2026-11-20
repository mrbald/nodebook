import { describe, expect, it } from 'vitest'
import type { Citation } from '@shared/types'
import { renderAskMarkdown, renderMarkdown } from './markdownRender'

const passages: Citation[] = [
  { id: 'P1', path: '/vault/alpha/Twin.md', title: 'alpha/Twin', start: 0, end: 3, quote: 'one' },
  { id: 'P2', path: '/vault/beta/Twin.md', title: 'beta/Twin', start: 0, end: 3, quote: 'two' }
]

describe('renderAskMarkdown', () => {
  it('renders only known passage IDs and leaves ordinary wikilinks alone outside Ask', () => {
    const { html, cited } = renderAskMarkdown('See [[P2]], [[Twin]] or [[P9]].', passages)
    expect(cited).toEqual(new Set(['P2']))
    expect(html).toContain('data-target="P2" href="#">beta/Twin</a>')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(renderMarkdown('[[Twin]]')).toContain('data-target="Twin"')
  })

  it('does not count references that only occur in code or target an anchor', () => {
    const { html, cited } = renderAskMarkdown('`[[P1]]` [[P2#heading]]', passages)
    expect(cited.size).toBe(0)
    expect(html).not.toContain('<a ')
  })
})


it('resolves only managed relative images in the scoped reader and counts repeated placements', () => {
  const id = 'a'.repeat(64)
  const note = '/my vault/Source book.md'
  const input = `![One](figures/${id}.png) and ![Two](figures/${id}.png)`
  const html = renderMarkdown(input, { path: note, runId: 'book' })
  expect(html).toContain('data-occurrence="0"')
  expect(html).toContain('data-occurrence="1"')
  expect(html).toContain(`nodebook-figure://asset/${id}?note=%2Fmy+vault%2FSource+book.md&amp;run=book`)
  const handmade = renderMarkdown(`![Other](nodebook-figure://asset/${id}?note=other)`, { path: note })
  expect(handmade).not.toContain('<img')
  const linked = renderMarkdown(`[![Chart](figures/${id}.png)](https://example.org/)`, { path: note })
  expect(linked).toContain('data-figure-id')
  expect(linked).not.toContain('<a ')
})
