import { useEffect, useState } from 'react'
import type { TelemetrySnapshot } from '@shared/types'

const PFW_URL = 'https://github.com/mrbald/pfw'

/** Poll the main process for telemetry snapshots while enabled. Measurement
 *  start/stop is owned by App (so it survives this widget unmounting between
 *  views); here we only read. */
function useTelemetry(enabled: boolean): TelemetrySnapshot | null {
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null)
  useEffect(() => {
    if (!enabled) {
      setSnap(null)
      return
    }
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.nodebook.telemetrySnapshot()
      if (alive) setSnap(s)
    }
    void tick()
    const id = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [enabled])
  return snap
}

function fmtLag(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function Spark({ values, kind }: { values: number[]; kind: string }): React.JSX.Element {
  const w = 38
  const h = 13
  if (values.length < 2) return <svg width={w} height={h} className={`spark spark-${kind}`} />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - 1 - ((v - min) / range) * (h - 2)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className={`spark spark-${kind}`} aria-hidden>
      <polyline points={pts} fill="none" strokeWidth="1" />
    </svg>
  )
}

function Histogram({ buckets, big }: { buckets: number[]; big?: boolean }): React.JSX.Element {
  const w = big ? 180 : 30
  const h = big ? 44 : 13
  const n = buckets.length
  const max = Math.max(...buckets, 1)
  const bw = w / n
  return (
    <svg width={w} height={h} className="histo" aria-hidden>
      {buckets.map((c, i) => {
        const bh = c ? Math.max(1, (c / max) * (h - 1)) : 0
        const slowest = i === n - 1
        return (
          <rect
            key={i}
            x={i * bw}
            y={h - bh}
            width={Math.max(1, bw - 0.6)}
            height={bh}
            className={slowest && c > 0 ? 'histo-bad' : 'histo-bar'}
          />
        )
      })}
    </svg>
  )
}

function Popover({ snap }: { snap: TelemetrySnapshot }): React.JSX.Element {
  const { lag } = snap
  const cpu = snap.cpu.at(-1) ?? 0
  const ram = snap.ram.at(-1) ?? 0
  const mins = Math.round(snap.windowMs / 60000)
  return (
    <div className="telemetry-popover" onClick={(e) => e.stopPropagation()}>
      <div className="telemetry-pop-title">Performance · last {mins} min</div>

      <div className="telemetry-row">
        <span className="telemetry-k">CPU</span>
        <Spark values={snap.cpu} kind="cpu" />
        <span className="telemetry-v">{cpu.toFixed(0)}%</span>
      </div>
      <div className="telemetry-row">
        <span className="telemetry-k">RAM</span>
        <Spark values={snap.ram} kind="ram" />
        <span className="telemetry-v">{ram.toFixed(0)} MB</span>
      </div>

      <div className="telemetry-pop-sub">Event-loop lag (ms)</div>
      <Histogram buckets={lag.buckets} big />
      <div className="telemetry-histo-labels">
        <span>&lt;1</span>
        <span>{lag.labels[Math.floor(lag.labels.length / 2)]}</span>
        <span>≥8192</span>
      </div>
      <div className="telemetry-stats">
        max {fmtLag(lag.max)} · p99 {fmtLag(lag.p99)} · mean {fmtLag(lag.mean)} · n {lag.count}
      </div>

      {lag.worst.length > 0 && (
        <>
          <div className="telemetry-pop-sub">Worst spikes</div>
          <ul className="telemetry-worst">
            {lag.worst.slice(0, 4).map((w, i) => (
              <li key={i}>
                <span className={w.ms >= 8192 ? 'bad' : ''}>{fmtLag(w.ms)}</span>
                <span className="telemetry-when">{new Date(w.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        className="telemetry-credit"
        onClick={() => void window.nodebook.openExternal(PFW_URL)}
        title="Inspired by the pfw metrics library"
      >
        measure everything — inspired by ufw/pfw ↗
      </button>
    </div>
  )
}

/** Tiny status-bar performance widget (event-loop lag + CPU/RAM). Renders only
 *  while telemetry is enabled. */
export function TelemetryWidget({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const snap = useTelemetry(enabled)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (!enabled || !snap) return null
  const maxLag = snap.lag.max
  return (
    <div className="telemetry">
      <button
        className="telemetry-mini"
        title="Performance — event-loop lag, CPU, RAM"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <Spark values={snap.cpu} kind="cpu" />
        <Histogram buckets={snap.lag.buckets} />
        <span className={`telemetry-lag ${maxLag >= 8192 ? 'bad' : ''}`}>{fmtLag(maxLag)}</span>
      </button>
      {open && <Popover snap={snap} />}
    </div>
  )
}
