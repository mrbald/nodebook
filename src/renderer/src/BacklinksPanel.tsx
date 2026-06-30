import { useEffect, useState } from 'react'
import type { MarkdownFile, Backlink, Outbound } from '@shared/types'
import type { NoteCitation } from './citations'

interface Props {
  active: MarkdownFile
  files: MarkdownFile[]
  onOpen: (f: MarkdownFile) => void
  /** Provenance citations from the note's frontmatter (distilled notes). */
  citations?: NoteCitation[]
  /** Open a citation's source note at the cited span. */
  onOpenCitation?: (c: NoteCitation) => void
}

export function BacklinksPanel({ active, files, onOpen, citations, onOpenCitation }: Props) {
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
        // Drop self-references — a note linking to itself is noise, not navigation.
        if (item.source_file === active.path) continue
        const key = item.source_file + '|' + item.relation
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(item)
        }
      }
      setBacklinks(merged)
      // …and a self-link in the body (`[[Self]]`) or a self-targeting field.
      setOutbound(out.filter((o) => o.object !== active.name && o.object !== relNoExt))
    })

    return () => {
      ignore = true
    }
    // active.name/.rel are derived from active.path, so path alone is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const cites = citations ?? []

  return (
    <div className="backlinks">
      {cites.length > 0 && (
        <section className="sources">
          <h2>Sources</h2>
          {cites.map((c, i) => (
            <div
              key={i}
              className="outbound-item is-link source-cite"
              role="button"
              tabIndex={0}
              title={`Open ${c.source} at characters ${c.start}–${c.end}`}
              onClick={() => onOpenCitation?.(c)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenCitation?.(c)
                }
              }}
            >
              📄 {c.source} <span className="source-span">{c.start}–{c.end}</span>
            </div>
          ))}
        </section>
      )}
      {outbound.length === 0 && backlinks.length === 0 && cites.length === 0 ? (
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
                        role={target ? 'button' : undefined}
                        tabIndex={target ? 0 : undefined}
                        onClick={() => target && onOpen(target)}
                        onKeyDown={(e) => {
                          if (target && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault()
                            onOpen(target)
                          }
                        }}
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
                        role={target ? 'button' : undefined}
                        tabIndex={target ? 0 : undefined}
                        onClick={() => target && onOpen(target)}
                        onKeyDown={(e) => {
                          if (target && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault()
                            onOpen(target)
                          }
                        }}
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
