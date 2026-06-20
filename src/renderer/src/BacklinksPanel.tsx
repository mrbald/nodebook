import { useEffect, useState } from 'react'
import type { MarkdownFile, Backlink } from '@shared/types'

interface Props {
  active: MarkdownFile
  files: MarkdownFile[]
  onOpen: (f: MarkdownFile) => void
}

export function BacklinksPanel({ active, files, onOpen }: Props) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])

  useEffect(() => {
    let ignore = false

    const relNoExt = active.rel.replace(/\.md$/i, '')

    Promise.all([
      window.nodebook.backlinks(active.name),
      window.nodebook.backlinks(relNoExt),
    ]).then(([byName, byRel]) => {
      if (ignore) return
      const seen = new Set<string>()
      const merged: Backlink[] = []
      for (const item of [...byName, ...byRel]) {
        const key = item.source_file + '|' + item.relation
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(item)
        }
      }
      setBacklinks(merged)
    })

    return () => {
      ignore = true
    }
  }, [active.path])

  const grouped = backlinks.reduce<Record<string, Backlink[]>>((acc, item) => {
    ;(acc[item.relation] ??= []).push(item)
    return acc
  }, {})

  const relations = Object.keys(grouped)

  return (
    <div className="backlinks">
      <h2>Backlinks</h2>
      {relations.length === 0 ? (
        <p className="backlinks-empty">No backlinks.</p>
      ) : (
        relations.map((relation) => (
          <div key={relation}>
            <div className="backlinks-relation">{relation}</div>
            {grouped[relation].map((item) => {
              const baseName = item.source_file
                .replace(/\\/g, '/')
                .split('/')
                .pop()!
                .replace(/\.md$/i, '')
              const target = files.find((f) => f.path === item.source_file)
              return (
                <div
                  key={item.source_file + '|' + item.relation}
                  className="backlinks-item"
                  onClick={() => {
                    if (target) onOpen(target)
                  }}
                >
                  {baseName}
                </div>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}
