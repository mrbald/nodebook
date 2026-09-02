import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseCitations, resolveCitationSpan, type NoteCitation } from './citations'
import { renderMarkdown } from './markdownRender'

/**
 * One note of a staged distill run, READ-ONLY — so you can see what a run
 * actually says before you merge it into your vault.
 *
 * Deliberately not the editor. A staged note is not a vault note: it has no
 * path the editor can save to, and giving it CodeMirror would drag the dirty/save
 * machinery (and the "is this file in the vault?" question) into staging. This is
 * the reading renderer over text main hands back, and nothing else.
 *
 * Its Sources panel resolves each citation against THE RUN'S OWN copy of the
 * document — the same copy the quotes were taken from — so a quote can be
 * checked before anything is written. Clicking one shows that passage with the
 * quote marked, in this same pane.
 */

/** Characters of the document shown either side of a cited passage. */
const CONTEXT = 1200

export function StagedNoteView({
  runId,
  name,
  onBack
}: {
  runId: string
  name: string
  /** Leave the note and go back to the run's map. */
  onBack: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [passage, setPassage] = useState<{
    source: string
    text: string
    start: number
    end: number
    exact: boolean
  } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setContent(null)
    setPassage(null)
    setNote(null)
    void window.nodebook
      .distillReadNote(runId, name)
      .then((r) => {
        if (!live) return
        setContent(r?.content ?? '')
        if (!r) setNote(`This run has no note called “${name}”.`)
      })
      .catch(() => live && setContent(''))
    return () => {
      live = false
    }
  }, [runId, name])

  const citations = useMemo<NoteCitation[]>(() => parseCitations(content ?? ''), [content])

  const openCitation = useCallback(
    (c: NoteCitation) => {
      void window.nodebook
        .distillReadNote(runId, c.source)
        .then((r) => {
          if (!r) {
            setPassage(null)
            setNote(`This run has no copy of “${c.source}” to check the quote against.`)
            return
          }
          const res = resolveCitationSpan(r.content, c)
          if (res.status === 'not-found') {
            setPassage(null)
            setNote(`Couldn't find that passage in “${c.source}”.`)
            return
          }
          setNote(null)
          setPassage({
            source: c.source,
            text: r.content,
            start: res.start,
            end: res.end,
            exact: res.status !== 'relocated'
          })
        })
        .catch(() => setNote("Couldn't read the run's copy of the document."))
    },
    [runId]
  )

  return (
    <div className="staged-note" key="staged-note">
      <div className="settings-header">
        <button className="settings-reset staged-note-back" onClick={onBack}>
          ← Back to map
        </button>
        <span className="settings-title staged-note-title">
          {passage ? passage.source : name}
          <span className="staged-note-badge">staged · read-only</span>
        </span>
      </div>
      {note && (
        <div className="staged-note-msg" role="status">
          {note}
        </div>
      )}
      <div className="staged-note-body">
        {passage ? (
          <>
            <button className="graph-ctl staged-note-back-note" onClick={() => setPassage(null)}>
              ← Back to “{name}”
            </button>
            {!passage.exact && (
              <div className="staged-note-msg">The passage moved; this is where it is now.</div>
            )}
            <Passage {...passage} />
          </>
        ) : content === null ? (
          <p className="staged-note-msg">Loading…</p>
        ) : (
          <div
            className="staged-note-rendered"
            // markdown-it runs with `html: false`, so the rendered string carries
            // no author HTML — the same renderer Print/Export-PDF already uses.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>
      {citations.length > 0 && !passage && (
        <section className="sources staged-note-sources">
          <h2>Sources</h2>
          {citations.map((c, i) => (
            <div
              key={i}
              className="outbound-item is-link source-cite"
              role="button"
              tabIndex={0}
              title={`Show this quote in the run's copy of ${c.source}`}
              onClick={() => openCitation(c)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openCitation(c)
                }
              }}
            >
              📄 {c.source}{' '}
              <span className="source-span">
                {c.start}–{c.end}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

/** The cited span with some document either side, the quote marked. Plain text
 *  in React nodes (so it is escaped by construction), wrapped at `pre-wrap`. */
function Passage({
  text,
  start,
  end
}: {
  text: string
  start: number
  end: number
}): React.JSX.Element {
  const from = Math.max(0, start - CONTEXT)
  const to = Math.min(text.length, end + CONTEXT)
  return (
    <div className="staged-source">
      {from > 0 && <span className="staged-source-cut">…</span>}
      {text.slice(from, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end, to)}
      {to < text.length && <span className="staged-source-cut">…</span>}
    </div>
  )
}
