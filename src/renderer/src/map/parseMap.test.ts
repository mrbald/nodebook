import { describe, it, expect } from 'vitest'
import { parseMap } from './parseMap'

const MAP = `# Project Map

- [[Root Note]]
  - [[Child A]]
    - a plain grandchild
  - [[Child B]]
- [[Another Root]]

## Edges
- [[Child A]] depends_on [[Child B]]
- [[Root Note]] relates_to [[Another Root]]
`

describe('parseMap', () => {
  it('reads the title from the first H1', () => {
    expect(parseMap(MAP).title).toBe('Project Map')
    expect(parseMap('- just a list').title).toBeNull()
  })

  it('builds the containment tree from indentation', () => {
    const { nodes } = parseMap(MAP)
    expect(nodes.map((n) => n.label)).toEqual(['Root Note', 'Another Root'])
    const root = nodes[0]
    expect(root.children.map((n) => n.label)).toEqual(['Child A', 'Child B'])
    expect(root.children[0].children.map((n) => n.label)).toEqual(['a plain grandchild'])
  })

  it('captures wikilink targets and leaves plain labels without one', () => {
    const { nodes } = parseMap(MAP)
    expect(nodes[0].target).toBe('Root Note')
    expect(nodes[0].children[0].children[0].target).toBeUndefined()
  })

  it('parses the Edges section into triples', () => {
    expect(parseMap(MAP).edges).toEqual([
      { source: 'Child A', relation: 'depends_on', target: 'Child B' },
      { source: 'Root Note', relation: 'relates_to', target: 'Another Root' }
    ])
  })

  it('does not treat outline bullets as edges, and ignores non-edge bullets under Edges', () => {
    const { nodes, edges } = parseMap('- [[A]]\n- [[B]]\n\n## Edges\n- not an edge line\n')
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(0)
  })

  it('strips alias and heading anchors from targets', () => {
    const { nodes } = parseMap('- [[Target|Shown]]\n- [[Other#Section]]')
    expect(nodes[0].label).toBe('Shown')
    expect(nodes[0].target).toBe('Target')
    expect(nodes[1].target).toBe('Other')
  })
})
