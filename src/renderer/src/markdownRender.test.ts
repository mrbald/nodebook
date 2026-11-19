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
