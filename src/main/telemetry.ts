import { performance } from 'perf_hooks'
import { app } from 'electron'
import type { TelemetrySnapshot } from '../shared/types'

/**
 * "Measure everything" — lightweight, always-cheap telemetry for the main
 * process. Event-loop lag is sampled by a self-scheduled probe (the delay a
 * fixed-interval timer actually incurs is the loop's lag); whole-app CPU/RAM
 * come from `app.getAppMetrics()`. Everything is kept in a rolling 5-minute
 * window. In the spirit of (and a quiet nod to) the pfw metrics library:
 * a log-bucketed latency histogram + worst-N exemplars, the goal being to
 * *never* land a sample in the slowest bucket.
 */

/** Octave (power-of-two ms) lag buckets: <1, 1, 2, 4, … 4096, ≥8192. */
export const LAG_BUCKETS = 15

/** Map a lag in ms to its octave bucket index [0, LAG_BUCKETS). */
export function lagBucket(ms: number): number {
  if (ms < 1) return 0
  return Math.min(LAG_BUCKETS - 1, Math.floor(Math.log2(ms)) + 1)
}

/** Human label for a bucket: '<1', '1', '2', … '4096', '≥8192' (ms). */
export function lagBucketLabel(i: number): string {
  if (i <= 0) return '<1'
  if (i >= LAG_BUCKETS - 1) return '≥8192'
  return String(2 ** (i - 1))
}

export const LAG_BUCKET_LABELS: string[] = Array.from({ length: LAG_BUCKETS }, (_, i) =>
  lagBucketLabel(i)
)

export interface LagAggregate {
  buckets: number[]
  count: number
  max: number
  mean: number
  p99: number
}

/** Pure: fold lag samples (ms) into the octave histogram + summary stats. */
export function aggregateLag(samplesMs: number[]): LagAggregate {
  const buckets = new Array<number>(LAG_BUCKETS).fill(0)
  let max = 0
  let sum = 0
  for (const ms of samplesMs) {
    buckets[lagBucket(ms)]++
    if (ms > max) max = ms
    sum += ms
  }
  const count = samplesMs.length
  let p99 = 0
  if (count > 0) {
    const sorted = [...samplesMs].sort((a, b) => a - b)
    p99 = sorted[Math.min(count - 1, Math.floor(count * 0.99))]
  }
  return { buckets, count, max, mean: count ? sum / count : 0, p99 }
}

interface Stamped {
  v: number
  at: number
}

const WORST_N = 6

export class Telemetry {
  private lag: Stamped[] = []
  private cpu: Stamped[] = []
  private ram: Stamped[] = []
  private probe: ReturnType<typeof setInterval> | null = null
  private metrics: ReturnType<typeof setInterval> | null = null
  private lastTick = 0
  private readonly probeMs = 100
  private readonly windowMs = 5 * 60_000

  get running(): boolean {
    return this.probe !== null
  }

  start(): void {
    if (this.probe) return
    this.lastTick = performance.now()
    // The lag a fixed-interval timer actually incurs *is* the event-loop lag.
    this.probe = setInterval(() => {
      const now = performance.now()
      const lag = Math.max(0, now - this.lastTick - this.probeMs)
      this.lastTick = now
      this.push(this.lag, lag)
    }, this.probeMs)
    // Don't keep the app alive just for telemetry.
    this.probe.unref?.()
    this.metrics = setInterval(() => this.sampleMetrics(), 2000)
    this.metrics.unref?.()
    this.sampleMetrics()
  }

  stop(): void {
    if (this.probe) clearInterval(this.probe)
    if (this.metrics) clearInterval(this.metrics)
    this.probe = this.metrics = null
    this.lag = []
    this.cpu = []
    this.ram = []
  }

  private sampleMetrics(): void {
    let cpu = 0
    let ramKb = 0
    for (const m of app.getAppMetrics()) {
      cpu += m.cpu.percentCPUUsage
      ramKb += m.memory.workingSetSize // KB
    }
    this.push(this.cpu, cpu)
    this.push(this.ram, ramKb / 1024) // MB
  }

  private push(ring: Stamped[], v: number): void {
    const now = Date.now()
    ring.push({ v, at: now })
    const cutoff = now - this.windowMs
    while (ring.length && ring[0].at < cutoff) ring.shift()
  }

  snapshot(): TelemetrySnapshot {
    const agg = aggregateLag(this.lag.map((s) => s.v))
    const worst = [...this.lag]
      .sort((a, b) => b.v - a.v)
      .slice(0, WORST_N)
      .map((s) => ({ ms: s.v, at: s.at }))
    return {
      windowMs: this.windowMs,
      lag: { ...agg, labels: LAG_BUCKET_LABELS, worst },
      cpu: this.cpu.map((s) => s.v),
      ram: this.ram.map((s) => s.v)
    }
  }
}
