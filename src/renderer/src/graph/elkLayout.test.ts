import { describe, expect, it } from 'vitest'
import ELK from 'elkjs/lib/elk.bundled.js'
import { edgeKey, elkLayout, type ElkRequest } from './elkLayout'
import { edgeLanes, manualEdgePath } from './graphGeometry'
import type { GraphEdge } from '@shared/types'

const elk = new ELK()
const edge = (source: string, target: string, relation = 'links_to'): GraphEdge => ({
  source, target, relation
})
function request(ids: string[], edges: GraphEdge[], overrides: Partial<ElkRequest> = {}): ElkRequest {
  return {
    nodes: ids.map((id) => ({ id, width: 66, height: 30 })),
    edges,
    width: 800,
    height: 600,
    direction: 'DOWN',
    ...overrides
  }
}

describe('elkLayout', () => {
  it('centres a single node', async () => {
    const layout = await elkLayout(elk, request(['A'], []))
    expect(layout.centres.get('A')).toEqual({ x: 400, y: 300 })
    expect(layout.routes.size).toBe(0)
  })

  it('lays out a chain in reading order and routes a shortcut around unrelated nodes', async () => {
    const shortcut = edge('A', 'D')
    const graph = request(['A', 'B', 'C', 'D'], [
      edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), shortcut
    ])
    const layout = await elkLayout(elk, graph)
    const p = layout.centres
    expect(p.get('A')!.y).toBeLessThan(p.get('B')!.y)
    expect(p.get('B')!.y).toBeLessThan(p.get('C')!.y)
    const route = layout.routes.get(edgeKey(shortcut))![0]
    expect(route.length).toBeGreaterThan(2)
    for (const id of ['B', 'C']) {
      const { x, y } = p.get(id)!
      expect(route.slice(1).some((end, i) => {
        const start = route[i]
        return Math.min(start.x, end.x) < x + 33 && Math.max(start.x, end.x) > x - 33 &&
          Math.min(start.y, end.y) < y + 15 && Math.max(start.y, end.y) > y - 15
      })).toBe(false)
    }
    expect(await elkLayout(elk, graph)).toEqual(layout)
  })

  it('retains parallel, reciprocal, and self edges by relation', async () => {
    const graphEdges = [
      edge('A root', 'B'), edge('A root', 'B', 'supports'), edge('B', 'A root'), edge('A root', 'A root')
    ]
    const graph = request(['A root', 'B'], [...graphEdges, graphEdges[0], edge('A root', 'missing')])
    const layout = await elkLayout(elk, graph)
    expect(layout.centres.size).toBe(2)
    expect(layout.routes.size).toBe(graphEdges.length)
    const paths = graphEdges.map((e) => JSON.stringify(layout.routes.get(edgeKey(e))))
    expect(new Set(paths).size).toBe(graphEdges.length)
  })

  it('fits wide node boxes and all route coordinates together', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`)
    const graph = request(ids, ids.slice(1).map((id) => edge('n0', id)), { width: 400, height: 300 })
    const layout = await elkLayout(elk, graph)
    expect(layout.scale).toBeLessThan(1)
    const leafX = ids.slice(1).map((id) => layout.centres.get(id)!.x).sort((a, b) => a - b)
    expect(leafX.slice(1).every((x, i) => x - leafX[i] > 66 * layout.scale)).toBe(true)
    const routePoints = [...layout.routes.values()].flat(2)
    for (const { x, y } of routePoints) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(400)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(300)
    }
  })

  it('keeps the book above its members while preserving the stored edge direction', async () => {
    const graph = request(['note', 'theme', 'book'], [
      edge('note', 'theme', 'part_of'), edge('theme', 'book', 'source')
    ], { direction: 'UP' })
    const layout = await elkLayout(elk, graph)
    const p = layout.centres
    expect(p.get('book')!.y).toBeLessThan(p.get('theme')!.y)
    const points = layout.routes.get(edgeKey(graph.edges[0]))![0]
    expect(points[0].y).toBeGreaterThan(points.at(-1)!.y)
  })

  it('keeps the manual connectors on box borders and separates parallel lanes', () => {
    const edges = [edge('A', 'B'), edge('A', 'B', 'supports'), edge('B', 'A')]
    const lanes = edgeLanes(edges)
    const size = { width: 20, height: 10 }
    const paths = edges.map((e) => {
      const a = { x: e.source === 'A' ? 0 : 100, y: 0 }
      const b = { x: e.target === 'A' ? 0 : 100, y: 0 }
      return manualEdgePath(a, b, size, size, 1, lanes.get(edgeKey(e))!)
    })
    expect(new Set(paths).size).toBe(edges.length)
    expect(paths[1]).toBe('M10 0 Q50 0 90 0')
  })
})
