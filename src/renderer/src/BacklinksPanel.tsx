import { useEffect, useState } from 'react'
import type { MarkdownFile, Backlink, Outbound } from '@shared/types'

interface Props {
  active: MarkdownFile
  files: MarkdownFile[]
  onOpen: (f: MarkdownFile) => void
}

export function BacklinksPanel({ active, files, onOpen }: Props) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outbound, setOutbound] = useState<Outbound[]>([])

  useEffect(() => {
    let ignore = false
    const relNoExt = active.rel.replace(/\.md$/i, '')

    Promise.all([
      window.nodebook.backlinks(active.name),
      window.nodebook.backlinks(relNoExt),
      window.nodebook.outbound(active.path)
    ]).then(([byName, byRel, out]) => {
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
      setOutbound(out)
    })

    return () => {
      ignore = true
    }
  }, [active.path])

  // A triple object is a note name (navigable) or a literal value (e.g. a
  // `key:: value` field). Resolve it the same way wikilink navigation does.
  const resolveTarget = (name: string): MarkdownFile | undefined =>
    files.find((f) => f.name === name) ??
    files.find((f) => f.rel.replace(/\.md$/i, '') === name)

  const groupBy = <T,>(items: T[], key: (t: T) => string): [string, T[]][] => {
    const acc: Record<string, T[]> = {}
    for (const it of items) (acc[key(it)] ??= []).push(it)
    return Object.entries(acc)
  }

  const outboundGroups = groupBy(outbound, (o) => o.relation)
  const backlinkGroups = groupBy(backlinks, (b) => b.relation)

  return (
    <div className="backlinks">
      {outbound.length === 0 && backlinks.length === 0 ? (
        <>
          <h2>Connections</h2>
          <p className="backlinks-empty">
            No connections yet. Add a <code>[[link]]</code> or a{' '}
            <code>key:: value</code> field.
          </p>
        </>
      ) : (
        <>
          {outboundGroups.length > 0 && (
            <section>
              <h2>Links &amp; properties</h2>
              {outboundGroups.map(([relation, items]) => (
                <div key={relation}>
                  <div className="outbound-relation">{relation}</div>
                  {items.map((item) => {
                    const target = resolveTarget(item.object)
                    return (
                      <div
                        key={relation + '|' + item.object}
                        className={`outbound-item${target ? ' is-link' : ''}`}
                        title={target ? `Open ${item.object}` : undefined}
                        onClick={() => target && onOpen(target)}
                      >
                        {item.object}
                      </div>
                    )
                  })}
                </div>
              ))}
            </section>
          )}

          <section>
            <h2>Backlinks</h2>
            {backlinkGroups.length === 0 ? (
              <p className="backlinks-empty">No backlinks.</p>
            ) : (
              backlinkGroups.map(([relation, items]) => (
                <div key={relation}>
                  <div className="backlinks-relation">{relation}</div>
                  {items.map((item) => {
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
                        onClick={() => target && onOpen(target)}
                      >
                        {baseName}
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  )
}
