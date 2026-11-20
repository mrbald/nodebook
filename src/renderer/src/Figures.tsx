import { matchesFigure } from '@shared/figureSearch'
import { figureUrl } from '@shared/figureUrl'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { FigureRef } from '@shared/figures'
import { useModal } from './useModal'
import './figures.css'

export interface FigureTarget {
  path: string
  runId?: string
  id: string
  label: string
  occurrence?: number
  ref?: FigureRef
}

export const OpenFigure = createContext<(target: FigureTarget) => void>(() => {})

export function FigureSources({ path, runId, revision }: {
  path: string
  runId?: string
  revision?: number
}): React.JSX.Element | null {
  const open = useContext(OpenFigure)
  const [result, setResult] = useState<{ path: string; runId?: string; refs: FigureRef[] } | null>(null)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(8)
  useEffect(() => {
    let live = true
    void window.nodebook.noteFigures(path, runId).then(
      (refs) => { if (live) setResult({ path, runId, refs }) },
      () => { if (live) setResult(null) }
    )
    return () => { live = false }
  }, [path, runId, revision])
  if (!result || result.path !== path || result.runId !== runId || !result.refs.length) return null
  const hits = result.refs.filter((figure) => matchesFigure(figure, filter))
  const rows = hits.slice(0, limit)
  const items = rows.map((ref, i) => (
    <button className="figure-source-link" type="button" key={`${ref.id}-${i}`}
      onClick={() => open({ path, runId, id: ref.id, label: ref.label, ref })}>
      {ref.label}
      {ref.location && ref.location !== ref.label && <small>{ref.location}</small>}
    </button>
  ))
  return (
    <section className="figure-sources" aria-label="Source figures">
      <h2>Figures</h2>
      {result.refs.length > 1 && <input type="search" aria-label="Find a figure" placeholder="Find a figure"
        value={filter} onChange={(e) => { setFilter(e.target.value); setLimit(8) }} />}
      {items}
      {!hits.length && <p>No matching figures.</p>}
      {hits.length > limit && <button className="graph-ctl" onClick={() => setLimit(limit + 8)}>Show more figures</button>}
    </section>
  )
}

type AnalysisStatus = Awaited<ReturnType<typeof window.nodebook.figureAnalysisStatus>>

export function FigureDialog({ target, onClose }: { target: FigureTarget; onClose: () => void }): React.JSX.Element {
  const modal = useModal()
  const { path, runId, id, label } = target
  const [figure, setFigure] = useState(target.ref)
  const [status, setStatus] = useState<AnalysisStatus | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const [naturalSize, setNaturalSize] = useState(false)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (target.ref) return
    let live = true
    void window.nodebook.noteFigures(path, runId).then((refs) => {
      if (!live) return
      const matches = refs.filter((ref) => ref.id === id)
      setFigure(matches[target.occurrence ?? 0] ?? matches.find((ref) => ref.label === label))
    }, () => { if (live) setError('Could not load this figure.') })
    return () => { live = false }
  }, [target.ref, target.occurrence, path, id, label, runId])
  useEffect(() => {
    if (!figure) return
    let live = true
    void window.nodebook.figureAnalysisStatus(path, id, runId, figure).then(
      (next) => { if (live) setStatus(next) },
      () => { if (live) setError('Could not load figure analysis.') }
    )
    return () => { live = false }
  }, [path, id, runId, figure])
  const analyze = async (): Promise<void> => {
    if (inFlight.current || !figure || !status?.available) return
    inFlight.current = true
    setAnalyzing(true)
    setError('')
    try {
      const analysis = await window.nodebook.analyzeFigure(path, id, runId, figure)
      if (mounted.current) setStatus({ ...status, analysis })
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      if (mounted.current) setAnalyzing(false)
    }
  }
  return (
    <div className="modal-overlay figure-overlay" onClick={onClose}>
      <section className="figure-dialog" role="dialog" aria-modal="true" aria-labelledby="figure-heading"
        ref={modal} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <header>
          <div><h2 id="figure-heading">{figure?.label ?? label}</h2>
            {figure?.location && figure.location !== figure.label && <span>{figure.location}</span>}
          </div>
          <button className="graph-ctl" onClick={onClose}>Close figure</button>
        </header>
        <div className={'figure-image' + (naturalSize ? ' natural-size' : '')}>
          {imageFailed ? <p role="status">This figure is unavailable in the vault.</p> :
            <img alt={figure?.label ?? label} src={figureUrl(path, id, runId)} onError={() => setImageFailed(true)} />}
        </div>
        <div className="figure-details">
          {figure?.caption && figure.caption !== figure.label && <p>{figure.caption}</p>}
          {!imageFailed && <button className="graph-ctl" aria-pressed={naturalSize}
            onClick={() => setNaturalSize(!naturalSize)}>{naturalSize ? 'Fit figure' : 'Actual size'}</button>}
          {figure?.ocr && <details><summary>Text recognized in figure</summary><p dir="auto">{figure.ocr}</p></details>}
          {status?.analysis ? <section className="figure-analysis">
            <h3>AI interpretation</h3><small>{status.analysis.provider} · {status.analysis.model}</small>
            <p dir="auto">{status.analysis.text}</p>
          </section> : status?.available && !imageFailed ? (
            <button className="graph-ctl" title="Send this figure and its labels to the selected model for interpretation" disabled={analyzing} onClick={() => void analyze()}>
              {analyzing ? 'Analyzing figure…' : `Analyze figure${status.providerLabel ? ' with ' + status.providerLabel : ''}`}
            </button>
          ) : status?.reason ? <small>{status.reason}</small> : null}
          {error && <p role="alert">{error}</p>}
        </div>
      </section>
    </div>
  )
}
