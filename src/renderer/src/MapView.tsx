import { useMemo, useState } from 'react'
import type { MapNode } from './map/parseMap'
import { parseMap } from './map/parseMap'

interface TreeNodeProps {
  node: MapNode
  onOpen: (t: string) => void
}

function TreeNode({ node, onOpen }: TreeNodeProps) {
  const [collapsed, setCollapsed] = useState(false)
  const hasChildren = node.children.length > 0

  return (
    <li className="map-node">
      {hasChildren ? (
        <span className="map-node-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▸' : '▾'}
        </span>
      ) : (
        <span className="map-node-toggle map-node-toggle-empty" />
      )}
      {node.target ? (
        <span className="map-node-label map-link" onClick={() => onOpen(node.target!)}>
          {node.label}
        </span>
      ) : (
        <span className="map-node-label">{node.label}</span>
      )}
      {hasChildren && !collapsed && (
        <ul className="map-tree">
          {node.children.map((child, i) => (
            <TreeNode key={i} node={child} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface MapViewProps {
  content: string
  onOpen: (target: string) => void
}

export function MapView({ content, onOpen }: MapViewProps) {
  const parsed = useMemo(() => parseMap(content), [content])

  return (
    <div className="map-view">
      {parsed.title && <h1 className="map-title">{parsed.title}</h1>}
      <ul className="map-tree">
        {parsed.nodes.map((node, i) => (
          <TreeNode key={i} node={node} onOpen={onOpen} />
        ))}
      </ul>
      {parsed.edges.length > 0 && (
        <div className="map-edges">
          <h2>Edges</h2>
          {parsed.edges.map((edge, i) => (
            <div key={i} className="map-edge">
              <span className="map-link" onClick={() => onOpen(edge.source)}>
                {edge.source}
              </span>
              <span className="map-edge-rel">{edge.relation}</span>
              <span className="map-link" onClick={() => onOpen(edge.target)}>
                {edge.target}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
