import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import type { GraphData } from '@shared/types'
import ForceLayoutWorker from './forceLayout.worker?worker'
import { forceLayout, type Point } from './layout'

type Slice = Pick<GraphData, 'nodes' | 'edges'>

export function useForceLayout(
  graph: Slice | null,
  scope: string,
  width: number,
  height: number,
  dragged: Map<string, Point>,
  pinned: Map<string, Point>,
  active: boolean
) {
  const [result, setResult] = useState<{
    topology: string
    scope: string
    width: number
    height: number
    positions: Map<string, Point>
    degraded: boolean
  } | null>(null)
  const previous = result?.scope === scope && result.width === width && result.height === height
    ? result : null
  // The index can refresh titles or provenance while the underlying map stays
  // put. The solver only depends on node identities and the ordered links.
  const topology = useMemo(() => graph?.nodes.length ? JSON.stringify([
    graph.nodes.map(({ id }) => id), graph.edges.map(({ source, target }) => [source, target])
  ]) : null, [graph])
  // Pointer moves update manual positions immediately. Take them as fixed
  // anchors when a topology change or reset starts the solver.
  const snapshot = useEffectEvent(() => {
    const placed = new Map([...dragged, ...pinned])
    return {
      graph,
      solved: previous?.topology === topology,
      seed: new Map([...(previous?.positions ?? []), ...placed]),
      fixed: new Set(placed.keys())
    }
  })

  useEffect(() => {
    if (!active || !topology) return
    const { graph, solved, seed, fixed } = snapshot()
    if (!graph || solved) return
    const options = { width, height, seed, fixed }
    const finish = (positions: Map<string, Point>, degraded = false): void =>
      setResult({ topology, scope, width, height, positions, degraded })
    if (graph.nodes.length < 80) {
      finish(forceLayout(graph.nodes, graph.edges, options))
      return
    }

    // The pairwise solver can take several frames on a whole-vault slice.
    let worker: Worker | undefined
    let live = true
    const stop = (): void => {
      live = false
      worker?.terminate()
    }
    const fallback = (): void => {
      if (live) {
        // A failed worker must not move an unbounded solve onto the renderer.
        const small = graph.nodes.length <= 200
        finish(forceLayout(graph.nodes, small ? graph.edges : [], { ...options, iterations: small ? 50 : 0 }), true)
      }
      stop()
    }
    try {
      worker = new ForceLayoutWorker()
      worker.onmessage = ({ data }: MessageEvent<Map<string, Point>>) => {
        if (live) finish(data)
        stop()
      }
      worker.onerror = fallback
      worker.onmessageerror = fallback
      worker.postMessage([
        graph.nodes.map(({ id }) => ({ id })),
        graph.edges.map(({ source, target }) => ({ source, target })),
        options
      ] satisfies Parameters<typeof forceLayout>)
    } catch {
      fallback()
    }
    return stop
  }, [active, topology, height, scope, width])

  return {
    positions: topology ? previous?.positions ?? null : null,
    arranging: !!topology && previous?.topology !== topology,
    degraded: !!(previous && previous.topology === topology && previous.degraded)
  }
}
