import { FigureSources, OpenFigure } from './Figures'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReadingCopy, ReadingCopyPreview } from '../../shared/readingCopy'
import { IMPORT_TEXT_ENCODINGS, importTextEncodingLabel } from '../../shared/textEncodings'
import { parseCitations, resolveCitationSpan, type NoteCitation } from './citations'
import { EncodingPreview } from './EncodingPreview'
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
  path,
  name,
  backLabel,
  onBack,
  onOpenBook,
  onOpenTheme
}: {
  runId: string
  path: string
  name: string
  backLabel: string
  onBack: () => void
  onOpenBook: (trigger: HTMLButtonElement) => void
  onOpenTheme: (theme: { id: string; label: string }, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [file, setFile] = useState<Awaited<ReturnType<typeof window.nodebook.distillReadNote>> | undefined>(undefined)
  const [passage, setPassage] = useState<{
    source: string
    text: string
    start: number
    end: number
    exact: boolean
    damaged: boolean
  } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [showHistorical, setShowHistorical] = useState(false)
  const citationOrigin = useRef<HTMLButtonElement | null>(null)
  const passageBack = useRef<HTMLButtonElement>(null)
  const citationRequest = useRef({ revision: 0 })

  useEffect(() => {
    let live = true
    const requests = citationRequest.current
    void window.nodebook
      .distillReadNote(runId, path)
      .then((r) => {
        if (!live) return
        setFile(r)
        if (!r) setMessage(`This run has no note called “${name}”.`)
      })
      .catch(() => {
        if (!live) return
        setFile(null)
        setMessage('Couldn’t read this staged note.')
      })
    return () => {
      live = false
      requests.revision++
    }
  }, [runId, path, name])

  const openFigure = useContext(OpenFigure)
  const content = file?.content ?? ''
  const reading = file?.reading
  const copy = reading?.kind === 'source' ? reading.copy : null
  const display = !showHistorical && copy ? copy.text : content
  const citations = useMemo<NoteCitation[]>(() => parseCitations(content), [content])
  const markup = useMemo(() => renderMarkdown(display, { path, runId }), [display, path, runId])
  const viewImage = (event: React.SyntheticEvent): void => {
    const target = event.target
    if (target instanceof HTMLImageElement && target.dataset.figureId) {
      event.preventDefault()
      openFigure({ path, runId, id: target.dataset.figureId, label: target.alt || 'Figure', occurrence: Number(target.dataset.occurrence ?? 0) })
    }
  }

  useLayoutEffect(() => {
    if (passage) passageBack.current?.focus({ preventScroll: true })
    else citationOrigin.current?.focus({ preventScroll: true })
  }, [passage])

  const openCitation = async (c: NoteCitation, trigger: HTMLButtonElement): Promise<void> => {
    const requests = citationRequest.current
    const request = ++requests.revision
    try {
      const source = await window.nodebook.distillReadNote(runId, c.source)
      if (requests.revision !== request) return
      if (!source) {
        setMessage(`This run has no copy of “${c.source}” to check the quote against.`)
        return
      }
      const location = resolveCitationSpan(source.content, c)
      if (location.status === 'not-found') {
        setMessage(source.reading?.kind === 'source'
          ? `Couldn’t find that passage in the damaged run copy of “${c.source}”.`
          : `Couldn’t find that passage in “${c.source}”.`)
        return
      }
      citationOrigin.current = trigger
      setMessage(null)
      setPassage({
        source: c.source,
        text: source.content,
        start: location.start,
        end: location.end,
        exact: location.status !== 'relocated',
        damaged: source.reading?.kind === 'source'
      })
    } catch {
      if (requests.revision === request) setMessage('Couldn’t read the run’s copy of the document.')
    }
  }

  return (
    <div className="staged-note" key="staged-note">
      <div className="settings-header">
        {!passage && (
          <button className="settings-reset staged-note-back" onClick={onBack} data-book-entry>
            ← {backLabel}
          </button>
        )}
        <span className="settings-title staged-note-title">
          {passage ? passage.source : name}
          <span className="staged-note-badge">staged · read-only</span>
        </span>
        {!passage && (
          <div className="staged-note-jumps">
            <button className="graph-ctl" onClick={(event) => onOpenBook(event.currentTarget)}>Go to book</button>
            {file?.themeId && file.themeLabel && (
              <button
                className="graph-ctl"
                onClick={(event) => onOpenTheme({ id: file.themeId!, label: file.themeLabel! }, event.currentTarget)}
              >Go to theme: {file.themeLabel}</button>
            )}
          </div>
        )}
      </div>
      {message && (
        <div className="staged-note-msg" role="status">
          {message}
        </div>
      )}
      {passage && (
        <div className="staged-note-body" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setPassage(null)
          }
        }}>
          <button className="graph-ctl staged-note-back-note" ref={passageBack} onClick={() => setPassage(null)} data-book-entry>
            ← Back to “{name}”
          </button>
          {passage.damaged && <p className="staged-reading-notice">This passage comes from the damaged source saved with the run.</p>}
          {!passage.exact && <div className="staged-note-msg">The passage moved. The match is highlighted below.</div>}
          <Passage {...passage} />
        </div>
      )}
      <div className="staged-note-body" hidden={!!passage}>
        {reading?.kind === 'source' && (
          <ReadingCopyControls
            key={`${runId}/${path}`}
            runId={runId}
            path={path}
            copy={copy}
            showHistorical={showHistorical}
            onToggle={() => setShowHistorical(!showHistorical)}
            onSave={(next) => {
              setShowHistorical(false)
              setFile((current) => current && { ...current, reading: { kind: 'source', copy: next } })
            }}
          />
        )}
        {reading?.kind === 'historical-note' && (
          <p className="staged-reading-notice">This note was extracted from damaged text. Its citations point to the source saved with the run.</p>
        )}
        {file === undefined ? (
          <p className="staged-note-msg">Loading…</p>
        ) : (
          <div
            className="staged-note-rendered"
            onClick={viewImage}
            onKeyDown={(e) => {
              if (e.target instanceof HTMLImageElement && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                viewImage(e)
              }
            }}
            // markdown-it runs with `html: false`, so the rendered string carries
            // no author HTML — the same renderer Print/Export-PDF already uses.
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        )}
      </div>
      {!passage && <FigureSources path={path} runId={runId} />}
      {citations.length > 0 && (
        <section className="sources staged-note-sources" hidden={!!passage}>
          <h2>Sources</h2>
          {citations.map((c, i) => (
            <button
              key={i}
              className="outbound-item is-link source-cite"
              type="button"
              title={`Show this quote in the run's copy of ${c.source}`}
              onClick={(event) => { void openCitation(c, event.currentTarget) }}
            >
              <span>
                📄 {c.source}{' '}
                <span className="source-span">{c.where ?? `Passage ${i + 1}`}</span>
              </span>
              {c.quote && <span className="source-quote">{c.quote}</span>}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}

const encodingOptions = IMPORT_TEXT_ENCODINGS.map(({ id, label }) => ({ name: id, label }))

function ReadingCopyControls({
  runId,
  path,
  copy,
  showHistorical,
  onToggle,
  onSave
}: {
  runId: string
  path: string
  copy: ReadingCopy | null
  showHistorical: boolean
  onToggle: () => void
  onSave: (copy: ReadingCopy) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<ReadingCopyPreview | null>(null)
  const [encoding, setEncoding] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef({ revision: 0, previewId: '' })
  const locateButton = useRef<HTMLButtonElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const hasPreview = preview !== null

  useEffect(() => {
    const active = request.current
    return () => {
      active.revision++
      if (active.previewId) discardPreview(active.previewId)
    }
  }, [])

  async function updatePreview(action: () => Promise<ReadingCopyPreview | null>): Promise<void> {
    const active = request.current
    const revision = ++active.revision
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (active.revision !== revision) {
        if (next) discardPreview(next.id)
        return
      }
      active.previewId = next?.id ?? ''
      setPreview(next)
    } catch (err) {
      if (active.revision !== revision) return
      setPreview(null)
      setError(recoveryMessage(err))
    } finally {
      if (active.revision === revision) setBusy(false)
    }
  }

  useLayoutEffect(() => {
    if (hasPreview) previewHeading.current?.focus({ preventScroll: true })
  }, [hasPreview])

  async function savePreview(id: string): Promise<void> {
    const active = request.current
    const revision = ++active.revision
    setBusy(true)
    setError('')
    try {
      const next = await window.nodebook.distillSaveReadingCopy(id)
      if (active.revision !== revision) return
      active.previewId = ''
      setPreview(null)
      onSave(next)
    } catch (err) {
      if (active.revision === revision) setError(recoveryMessage(err))
    } finally {
      if (active.revision === revision) setBusy(false)
    }
  }

  useLayoutEffect(() => {
    // Once saved, the preview controls disappear. Keep keyboard focus in view.
    if (copy && request.current.revision > 0) toggleButton.current?.focus({ preventScroll: true })
  }, [copy])

  function cancel(): void {
    const active = request.current
    active.revision++
    if (active.previewId) discardPreview(active.previewId)
    active.previewId = ''
    setPreview(null)
    setBusy(false)
    setError('')
    locateButton.current?.focus()
    toggleButton.current?.focus()
  }

  return (
    <section className="staged-reading" aria-label="Reading copy">
      <div className="staged-reading-toolbar">
        <p className="staged-reading-notice">
          {copy ? (
            <>{showHistorical ? 'Showing damaged run text.' : `Reading copy from ${importTextEncodingLabel(copy.encoding)}.`}{' '}
              The run’s notes and citations use the damaged source.</>
          ) : 'This staged source contains damaged text. Locate the original to make a reading copy.'}
        </p>
        <div className="staged-reading-actions">
          {copy && (
            <button type="button" className="graph-ctl" ref={toggleButton} onClick={onToggle}>
              {showHistorical ? 'Show reading copy' : 'Show run text'}
            </button>
          )}
          {!preview && (
            <button type="button" className="graph-ctl" ref={locateButton} disabled={busy} onClick={() => {
              setEncoding('')
              void updatePreview(() => window.nodebook.distillLocateReadingCopy(runId, path))
            }}>
              Locate original…
            </button>
          )}
        </div>
      </div>
      {preview && (
        <div className="staged-reading-preview">
          <h2 ref={previewHeading} tabIndex={-1}>Reading copy preview</h2>
          <EncodingPreview
            options={encodingOptions}
            selection={encoding}
            onChange={(value) => {
              setEncoding(value)
              void updatePreview(() => window.nodebook.distillChooseReadingCopy(preview.id, value || undefined))
            }}
            detectedLabel={preview.encoding && importTextEncodingLabel(preview.encoding)}
            preview={preview.preview}
            uncertain={preview.uncertain}
            pending={busy}
            disabled={busy}
            error={preview.error}
          />
          <div className="staged-reading-actions">
            <button type="button" className="graph-ctl" disabled={busy} onClick={cancel}>Cancel</button>
            <button type="button" className="graph-ctl" disabled={busy || !preview.encoding} onClick={() => {
              void savePreview(preview.id)
            }}>Use reading copy</button>
          </div>
        </div>
      )}
      {error && <p className="staged-reading-notice" role="alert">{error}</p>}
    </section>
  )
}

function discardPreview(id: string): void {
  void window.nodebook.distillDiscardReadingCopy(id).catch(() => undefined)
}

function recoveryMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Couldn’t prepare a reading copy.'
  // Electron prefixes rejected handlers with the channel and Error class.
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
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
