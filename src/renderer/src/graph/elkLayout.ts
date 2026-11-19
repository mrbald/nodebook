import type { ELK, ElkNode } from 'elkjs/lib/elk-api'
import type { GraphEdge } from '@shared/types'
import type { Point } from './layout'

export interface NodeSize {
  width: number
  height: number
}

export interface ElkRequest {
  nodes: ({ id: string } & NodeSize)[]
  edges: GraphEdge[]
  width: number
  height: number
  direction: 'UP' | 'DOWN'
}

export interface ElkLayout {
  centres: Map<string, Point>
  routes: Map<string, Point[][]>
  scale: number
}

export type ElkReply = { layout: ElkLayout } | { error: string }

export function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.source, edge.relation, edge.target])
}

export async function elkLayout(elk: ELK, request: ElkRequest): Promise<ElkLayout> {
  const { nodes, edges, width, height, direction } = request
  const ids = new Map(nodes.map(({ id }, i) => [id, `n${i}`]))
  const keys = new Map<string, string>()
  const elkEdges: NonNullable<ElkNode['edges']> = []
  const seen = new Set<string>()
  for (const edge of edges) {
    const source = ids.get(edge.source)
    const target = ids.get(edge.target)
    if (!source || !target) continue
    const key = edgeKey(edge)
    if (seen.has(key)) continue
    seen.add(key)
    const id = `e${elkEdges.length}`
    keys.set(id, key)
    elkEdges.push({ id, sources: [source], targets: [target] })
  }
  const graph = await elk.layout<ElkNode>({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '38',
      'elk.layered.spacing.nodeNodeBetweenLayers': '26',
      'elk.spacing.edgeNode': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '10',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '7',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]'
    },
    children: nodes.map(({ id, width, height }) => ({ id: ids.get(id)!, width, height })),
    edges: elkEdges
  })
  const graphWidth = graph.width || 1
  const graphHeight = graph.height || 1
  const scale = Math.min(1, width / graphWidth, height / graphHeight)
  const dx = (width - graphWidth * scale) / 2
  const dy = (height - graphHeight * scale) / 2
  const fit = ({ x, y }: Point): Point => ({ x: dx + x * scale, y: dy + y * scale })

  const centres = new Map<string, Point>()
  const originalIds = new Map([...ids].map(([original, elkId]) => [elkId, original]))
  for (const child of graph.children ?? []) {
    const id = originalIds.get(child.id)
    if (id === undefined || child.x === undefined || child.y === undefined) continue
    centres.set(id, fit({
      x: child.x + (child.width ?? 0) / 2,
      y: child.y + (child.height ?? 0) / 2
    }))
  }
  const routes = new Map<string, Point[][]>()
  for (const edge of graph.edges ?? []) {
    const key = keys.get(edge.id)
    if (key === undefined || !edge.sections?.length) continue
    routes.set(key, edge.sections.map(({ startPoint, bendPoints, endPoint }) =>
      [startPoint, ...(bendPoints ?? []), endPoint].map(fit)
    ))
  }
  return { centres, routes, scale }
}
