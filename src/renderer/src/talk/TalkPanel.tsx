import { useState } from 'react'
import type { UseTalk } from './useTalk'

/**
 * How "talk to docs" is exposed under the search box: an honest invitation while
 * off (no dead toggles), a privacy-first setup card, then live status. See
 * docs/talk-to-docs.md.
 */
export function TalkPanel({ talk }: { talk: UseTalk }): React.JSX.Element | null {
  const [setupOpen, setSetupOpen] = useState(false)
  const { status, phase, progress, modelProgress } = talk
  if (!status) return null

  if (!status.enabled) {
    if (!setupOpen) {
      return (
        <button className="talk-cta" onClick={() => setSetupOpen(true)}>
          ✨ Search by meaning — set up AI <span className="talk-cta-note">(local &amp; private)</span>
        </button>
      )
    }
    return (
      <div className="talk-setup">
        <div className="talk-setup-title">✨ Search by meaning</div>
        <p className="talk-setup-body">
          Runs entirely on your machine — your notes never leave it. Downloads a small model once,
          then indexes your notes in the background.
        </p>
        <div className="talk-setup-actions">
          <button
            className="talk-enable"
            onClick={() => {
              setSetupOpen(false)
              void talk.enable()
            }}
          >
            Enable
          </button>
          <button className="talk-cancel" onClick={() => setSetupOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'loading-model') {
    // Determinate bar once we know the download size; indeterminate before that.
    const pct = modelProgress != null ? Math.round(modelProgress * 100) : null
    return (
      <div className="talk-status">
        <span>✨ Downloading model{pct != null ? ` ${pct}%` : '…'}</span>
        <div
          className="talk-progress"
          role="progressbar"
          aria-label="Downloading embedding model"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct != null ? { 'aria-valuenow': pct } : {})}
        >
          <div
            className={`talk-progress-bar${pct == null ? ' is-indeterminate' : ''}`}
            style={pct != null ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>
    )
  }
  if (phase === 'indexing')
    return (
      <div className="talk-status">
        ✨ Indexing {progress ? `${progress.done}/${progress.total}` : '…'}
      </div>
    )
  if (phase === 'error')
    return (
      <div className="talk-status talk-status-error">
        Couldn’t load the model.{' '}
        <button className="talk-link" onClick={() => void talk.enable()}>
          Retry
        </button>
      </div>
    )
  return (
    <div className="talk-status">
      <span className="talk-on">✨ Semantic search on</span>
      <button className="talk-link" onClick={() => void talk.disable()}>
        Turn off
      </button>
    </div>
  )
}
