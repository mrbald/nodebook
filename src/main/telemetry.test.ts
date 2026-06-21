import { describe, it, expect } from 'vitest'
import { lagBucket, lagBucketLabel, aggregateLag, LAG_BUCKETS } from './telemetry'

describe('lagBucket', () => {
  it('puts sub-ms lag in bucket 0 and powers of two on octave boundaries', () => {
    expect(lagBucket(0)).toBe(0)
    expect(lagBucket(0.4)).toBe(0)
    expect(lagBucket(1)).toBe(1) // [1,2)
    expect(lagBucket(1.9)).toBe(1)
    expect(lagBucket(2)).toBe(2) // [2,4)
    expect(lagBucket(4096)).toBe(13) // [4096,8192)
  })

  it('saturates the slowest bucket at ≥8192 ms', () => {
    expect(lagBucket(8192)).toBe(LAG_BUCKETS - 1)
    expect(lagBucket(60_000)).toBe(LAG_BUCKETS - 1)
  })

  it('labels read as the bucket lower bound, with <1 and ≥8192 ends', () => {
    expect(lagBucketLabel(0)).toBe('<1')
    expect(lagBucketLabel(1)).toBe('1')
    expect(lagBucketLabel(13)).toBe('4096')
    expect(lagBucketLabel(LAG_BUCKETS - 1)).toBe('≥8192')
  })
})

describe('aggregateLag', () => {
  it('is all-zero for no samples', () => {
    const a = aggregateLag([])
    expect(a.count).toBe(0)
    expect(a.max).toBe(0)
    expect(a.mean).toBe(0)
    expect(a.p99).toBe(0)
    expect(a.buckets.every((b) => b === 0)).toBe(true)
  })

  it('histograms samples and reports max/mean/p99', () => {
    const a = aggregateLag([0.2, 0.5, 1.5, 3, 5000])
    expect(a.count).toBe(5)
    expect(a.max).toBe(5000)
    expect(a.mean).toBeCloseTo(1001.04, 1)
    expect(a.buckets[0]).toBe(2) // 0.2, 0.5
    expect(a.buckets[1]).toBe(1) // 1.5
    expect(a.buckets[2]).toBe(1) // 3
    expect(a.buckets[13]).toBe(1) // 5000 → [4096,8192)
    expect(a.buckets.reduce((s, b) => s + b, 0)).toBe(5)
  })

  it('keeps a healthy loop entirely out of the slowest bucket', () => {
    const healthy = Array.from({ length: 1000 }, () => Math.random() * 0.5)
    const a = aggregateLag(healthy)
    expect(a.buckets[LAG_BUCKETS - 1]).toBe(0)
    expect(a.buckets[0]).toBe(1000)
  })
})
