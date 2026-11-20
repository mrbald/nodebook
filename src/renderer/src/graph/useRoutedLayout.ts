import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import type { GraphData } from '@shared/types'
import { elkLayout, type ElkReply, type ElkRequest } from './elkLayout'
import { LABEL_FONT_SIZE, measureNodeLabel, type NodeLabel } from './graphGeometry'

export function useRoutedLayout(
  graph: Pick<GraphData, 'nodes' | 'edges'> | null,
  width: number,
  height: number,
  direction: ElkRequest['direction'],
  active: boolean
) {
  const [result, setResult] = useState<{ request: ElkRequest; reply: ElkReply } | null>(null)
  const labels = useMemo(() => {
    const labels = new Map<string, NodeLabel>()
    if (!graph?.nodes.length) return labels
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return labels
    ctx.font = `${LABEL_FONT_SIZE}px ${getComputedStyle(document.documentElement).fontFamily}`
    for (const node of graph.nodes) labels.set(node.id, measureNodeLabel(ctx, node.label))
    return labels
  }, [graph])
  const request = useMemo<ElkRequest | null>(() => {
    if (!graph || !labels.size) return null
    return {
      nodes: [...labels].map(([id, { width, height }]) => ({ id, width, height })),
      edges: graph.edges,
      width,
      height,
      direction
    }
  }, [graph, labels, width, height, direction])

  const reply = request && result?.request === request ? result.reply : null
  const hasReply = useEffectEvent(() => reply !== null)

  useEffect(() => {
    if (!active || !request || hasReply()) return
    let worker: Worker | undefined
    let live = true
    const finish = (reply: ElkReply): void => {
      if (live) setResult({ request, reply })
      live = false
      worker?.terminate()
    }
    try {
      // The embedded app serves the classic worker as a local asset. Only the
      // small ELK browser API runs on the renderer thread.
      const engineWorker = new Worker(elkWorkerUrl)
      worker = engineWorker
      worker.onerror = ({ message }) => finish({ error: message })
      worker.onmessageerror = () => finish({ error: 'Unreadable layout response' })
      const elk = new ELK({ algorithms: ['layered'], workerFactory: () => engineWorker })
      void elkLayout(elk, request).then(
        (layout) => finish({ layout }),
        (error: unknown) => finish({ error: String(error) })
      )
    } catch (error) {
      finish({ error: String(error) })
    }
    return () => {
      live = false
      worker?.terminate()
    }
  }, [active, request])

  return {
    labels,
    routed: reply && 'layout' in reply ? reply.layout : null,
    failed: !!(reply && 'error' in reply) || (!!graph?.nodes.length && !request),
    arranging: !!request && !reply
  }
}
