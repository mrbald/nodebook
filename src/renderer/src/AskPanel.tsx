import { useState } from 'react'
import type { AskResult, Citation, MarkdownFile } from '@shared/types'

interface Props {
  ask: (question: string, onToken: (t: string) => void) => Promise<AskResult>
  files: MarkdownFile[]
  onOpen: (f: MarkdownFile) => void
  onClose: () => void
}

/**
 * The "Ask" panel: a question → a streamed, note-grounded answer + the source
 * notes it drew on (clickable). Only the retrieved passages are sent to the
 * model; the answer streams in token-by-token.
 */
export function AskPanel({ ask, files, onOpen, onClose }: Props) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [citations, setCitations] = useState<Citation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    setAsked(q)
    setAnswer('')
    setCitations([])
    setError(null)
    try {
      const res = await ask(q, (t) => setAnswer((a) => a + t))
      setCitations(res.citations)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ask failed.')
    } finally {
      setBusy(false)
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
            {(answer || busy) && <div className="ask-answer">{answer || '…'}</div>}
            {citations.length > 0 && (
              <div className="ask-sources">
                <div className="ask-sources-label">Sources</div>
                {citations.map((c) => {
                  const f = files.find((x) => x.path === c.path)
                  return (
                    <button
                      key={c.path}
                      className="ask-source"
                      disabled={!f}
                      onClick={() => f && onOpen(f)}
                    >
                      {c.title}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
        {!asked && (
          <p className="ask-hint">
            Answers are grounded in your notes — only the most relevant passages are sent
            to the model, and the notes it used are listed as sources.
          </p>
        )}
      </div>
    </div>
  )
}
