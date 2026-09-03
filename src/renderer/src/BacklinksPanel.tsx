import { useEffect, useState } from 'react'
import type { MarkdownFile, Backlink, Outbound } from '@shared/types'
import { parseCitations, type NoteCitation, type NoteDocument } from './citations'
import { noteGist, quoteLine, unionCitations, type NoteGist } from './twins'

interface Props {
  active: MarkdownFile
  files: MarkdownFile[]
  onOpen: (f: MarkdownFile) => void
  /** Provenance citations from the note's frontmatter (distilled notes). */
  citations?: NoteCitation[]
  /** Open a citation's source note at the cited span. */
  onOpenCitation?: (c: NoteCitation) => void
  /** Set when this note IS a converted document — drives "Open original". */
  document?: NoteDocument | null
  /** Open the file the document was converted from (main resolves the path). */
  onOpenOriginal?: () => void
  /** Bumped when the index changed, so a `same_as` ticked just now shows up
   *  without reopening the note. */
  reloadKey?: number
}

/** A twin note as this panel shows it: its name, what it says, what it cites. */
interface TwinView {
  path: string
  name: string
  gist: NoteGist
  citations: NoteCitation[]
}

export function BacklinksPanel({
  active,
  files,
  onOpen,
  citations,
  onOpenCitation,
  document,
  onOpenOriginal,
  reloadKey
}: Props) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outbound, setOutbound] = useState<Outbound[]>([])
  const [twins, setTwins] = useState<TwinView[]>([])

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
  }, [active.path, reloadKey])

  // What the note's confirmed twins say. Read fresh each time, because a twin is
  // an ordinary file the user can edit. The section is decoration: a twin that
  // will not read is skipped, never an error.
  useEffect(() => {
    let ignore = false
    setTwins([])

    void window.nodebook
      .sameAs(active.path)
      .then(async (list) => {
        if (ignore) return
        const views = await Promise.all(
          list.map(async (t): Promise<TwinView | null> => {
            const content = await window.nodebook.readFile(t.path).catch(() => null)
            if (content === null) return null
            return { ...t, gist: noteGist(content), citations: parseCitations(content) }
          })
        )
        if (ignore) return
        setTwins(views.filter((v): v is TwinView => v !== null))
      })
      .catch(() => {
        // No twins to show is the honest fallback — the panel never errors.
      })

    return () => {
      ignore = true
    }
  }, [active.path, reloadKey])

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

  // A `same_as` that landed on a twin has its own section below, so it is not
  // repeated among the ordinary links. One that resolved to nothing — a typo, a
  // note not written yet — stays listed, so the broken link is still visible.
  const twinPaths = new Set(twins.map((t) => t.path))
  const namesATwin = (name: string): boolean => {
    const f = resolveTarget(name)
    return f !== undefined && twinPaths.has(f.path)
  }
  const shownOutbound = outbound.filter(
    (o) => !(o.relation === 'same_as' && namesATwin(o.object))
  )
  const shownBacklinks = backlinks.filter(
    (b) => !(b.relation === 'same_as' && twinPaths.has(b.source_file))
  )

  const outboundGroups = groupBy(shownOutbound, (o) => o.relation)
  const backlinkGroups = groupBy(shownBacklinks, (b) => b.relation)

  // Both notes' provenance in one list: the note's own citations first, then
  // each twin's, labelled, and nothing said twice.
  const cites = unionCitations(citations ?? [], twins)

  return (
    <div className="backlinks">
      {document && (
        <section className="sources">
          <h2>Source document</h2>
          <p className="backlinks-empty source-document-path">
            {document.path ?? 'This note is a document brought in by Distill.'}
          </p>
          {document.hash && onOpenOriginal && (
            <button className="graph-ctl source-open-original" onClick={onOpenOriginal}>
              Open original
            </button>
          )}
        </section>
      )}
      {twins.length > 0 && (
        <section className="same-as">
          <h2>Same as</h2>
          {twins.map((twin) => {
            const target = files.find((f) => f.path === twin.path)
            return (
              <div key={twin.path} className="same-as-twin">
                <div
                  className={`outbound-item same-as-name${target ? ' is-link' : ''}`}
                  title={target ? `Open ${twin.name}` : undefined}
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
                  {twin.name}
                </div>
                {twin.gist.summary && <p className="same-as-summary">{twin.gist.summary}</p>}
                {twin.gist.quotes.map((q, i) => (
                  <div key={i} className="source-quote same-as-quote">
                    “{q}”
                  </div>
                ))}
              </div>
            )
          })}
        </section>
      )}
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
              <div>
                📄 {c.source}{' '}
                <span className="source-span">{c.where ?? `${c.start}–${c.end}`}</span>
                {c.from && <span className="source-from"> from {c.from}</span>}
              </div>
              {c.quote && <div className="source-quote">“{quoteLine(c.quote)}”</div>}
            </div>
          ))}
        </section>
      )}
      {shownOutbound.length === 0 &&
      shownBacklinks.length === 0 &&
      cites.length === 0 &&
      twins.length === 0 &&
      !document ? (
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
