import { describe, expect, it } from 'vitest'
import ELK from 'elkjs/lib/elk.bundled.js'
import { dagreLayout } from './dagreLayout'
import { edgeKey, elkLayout } from './elkLayout'
import { spaceRoutedLayers, spaceTreeRanks } from './layerSpacing'
import type { Point } from './layout'

const viewport = { width: 870, height: 758 }
const ids = Array.from({ length: 50 }, (_, index) => `n${index}`)
const nodes = ids.map((id, index) => ({ id, width: 94 + index % 5, height: 30 + 16 * (index % 2) }))
const links = ids.slice(1).map((target, index) => ({
  source: index < 2 ? ids[index] : ids[index % 3], target, relation: 'links_to'
}))
const span = (values: number[]): number => Math.max(...values) - Math.min(...values)

describe('layer spacing', () => {
  it('uses more of the viewport and retains the order and membership of Dagre ranks', () => {
    const natural = dagreLayout(nodes, links)
    const spaced = spaceTreeRanks(natural, viewport)
    const before = [...natural.values()]
    const after = [...spaced.values()]
    expect(after.map(({ x }) => x)).toEqual(before.map(({ x }) => x))
    expect(span(after.map(({ y }) => y))).toBeGreaterThan(span(before.map(({ y }) => y)) * 1.5)
    expect([...new Set(before.map(({ y }) => y))]).toHaveLength(new Set(after.map(({ y }) => y)).size)
    const order = (p: Map<string, Point>): string[] => [...p.keys()].sort((a, b) => p.get(a)!.y - p.get(b)!.y)
    expect(order(spaced)).toEqual(order(natural))
    expect(spaceTreeRanks(natural, { width: 2600, height: 300 })).toBe(natural)
  })

  it('keeps a single rank and a small chain at their natural spacing', () => {
    const row = dagreLayout(nodes, [])
    expect(spaceTreeRanks(row, viewport)).toBe(row)
    const small = dagreLayout(nodes.slice(0, 3), links.slice(0, 2))
    expect(spaceTreeRanks(small, viewport)).toBe(small)
  })

  it('adds room between ELK layers while preserving card size, ports and orthogonal segments', async () => {
    const original = await elkLayout(new ELK(), { nodes, edges: links, width: 800, height: 600, direction: 'UP' })
    const spaced = spaceRoutedLayers(original, new Map(nodes.map((node) => [node.id, node])), viewport)
    const before = [...original.centres.values()]
    const after = [...spaced.centres.values()]
    expect(spaced.scale).toBe(original.scale)
    expect(after.map(({ x }) => x)).toEqual(before.map(({ x }) => x))
    expect(span(after.map(({ y }) => y))).toBeGreaterThan(span(before.map(({ y }) => y)) * 1.5)

    for (const link of links) {
      const oldPath = original.routes.get(edgeKey(link))![0]
      const newPath = spaced.routes.get(edgeKey(link))![0]
      expect(newPath.map(({ x }) => x)).toEqual(oldPath.map(({ x }) => x))
      const last = oldPath.length - 1
      for (const [end, id] of [[0, link.source], [last, link.target]] as const) {
        const oldOffset = oldPath[end].y - original.centres.get(id)!.y
        const newOffset = newPath[end].y - spaced.centres.get(id)!.y
        expect(newOffset).toBeCloseTo(oldOffset, 8)
      }
      for (let i = 1; i < newPath.length; i++) {
        const delta = (path: Point[]): number => Math.min(
          Math.abs(path[i].x - path[i - 1].x), Math.abs(path[i].y - path[i - 1].y)
        )
        expect(delta(newPath)).toBeLessThan(delta(oldPath) + 1e-8)
      }
    }
  })
})
