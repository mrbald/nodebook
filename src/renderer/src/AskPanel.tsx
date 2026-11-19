import { useEffect, useRef, useState } from 'react'
import type { AskResult, Citation } from '@shared/types'
import { renderAskMarkdown } from './markdownRender'

interface Props {
  ask: (question: string, onToken: (t: string) => void, signal: AbortSignal) => Promise<AskResult>
  onOpenPassage: (citation: Citation) => void
  /** Open an external URL in the answer. */
  openExternal: (url: string) => void
  onClose: () => void
}

/**
 * The "Ask" panel: a question → a streamed, note-grounded answer + the source
 * notes it drew on (clickable). Only the retrieved passages are sent to the
 * model; the answer streams in token-by-token.
 */
export function AskPanel({ ask, onOpenPassage, openExternal, onClose }: Props) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [citations, setCitations] = useState<Citation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const rendered = busy ? null : renderAskMarkdown(answer, citations)

  // The rendered answer is markdown (html:false → safe). Delegate clicks:
  // a [[wikilink]] citation opens the note; an external link opens in the OS.
  const onAnswerClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    if (a.classList.contains('ask-citation')) {
      const citation = citations.find((c) => c.id === a.getAttribute('data-target'))
      if (citation) onOpenPassage(citation)
    } else {
      const href = a.getAttribute('href')
      if (href) openExternal(href)
    }
  }

  const submit = async (): Promise<void> => {
    const q = question.trim()
    if (!q || request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setAsked(q)
    setAnswer('')
    setCitations([])
    setError(null)
    try {
      const res = await ask(q, (t) => {
        if (!controller.signal.aborted) setAnswer((a) => a + t)
      }, controller.signal)
      if (controller.signal.aborted) return
      setAnswer(res.answer)
      setCitations(res.citations)
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Ask failed.')
    } finally {
      request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className="ask-pane">
      <div className="ask-header">
        <span className="ask-title">Ask your notes</span>
        <button className="settings-reset" onClick={onClose}>
          Close
        </button>
      </div>

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          className="ask-input"
          placeholder="Ask a question about your notes…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />
        <button className="ask-send" type="submit" disabled={busy || !question.trim()}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>

      <div className="ask-body">
        {asked && <div className="ask-question">{asked}</div>}
        {error ? (
          <div className="ask-error" role="alert">
            {error}
          </div>
        ) : (
          <>
            {busy ? (
              // Live streaming: plain text (a half-formed markdown fence would
              // render badly mid-stream). Settles into rendered markdown on done.
              <div className="ask-answer">{answer || '…'}</div>
            ) : (
              rendered && answer && (
                <div
                  className="ask-answer ask-answer-rendered md-rendered"
                  onClick={onAnswerClick}
                  dangerouslySetInnerHTML={{
                    __html: rendered.html
                  }}
                />
              )
            )}
            {(() => {
              const renderSource = (c: Citation): React.ReactNode => (
                  <button
                    key={c.id}
                    className="ask-source"
                    onClick={() => onOpenPassage(c)}
                  >
                    {c.title}
                  </button>
              )
              const cited = citations.filter((c) => rendered?.cited.has(c.id))
              const other = citations.filter((c) => !rendered?.cited.has(c.id))
              return (
                <>
                  {cited.length > 0 && (
                    <div className="ask-sources">
                      <div className="ask-sources-label">Cited</div>
                      {cited.map(renderSource)}
                    </div>
                  )}
                  {other.length > 0 && (
                    <div className="ask-sources ask-sources-other">
                      <div className="ask-sources-label">Also sent to the model</div>
                      {other.map(renderSource)}
                    </div>
                  )}
                </>
              )
            })()}
          </>
        )}
        {!asked && (
          <p className="ask-hint">
            Ask sends relevant passages to the configured chat provider. Click a citation
            to see its passage in the note.
          </p>
        )}
      </div>
    </div>
  )
}
