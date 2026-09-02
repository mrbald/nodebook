import { describe, it, expect } from 'vitest'
import { withRetry, isRetryable, isAuthMessage, tagError } from './retry'

/** A sleep that records what it was asked to wait for instead of waiting. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
    }
  }
}

const httpError = (status: number): Error => tagError(new Error(`API ${status}`), { status })
const netError = (code: string): Error => tagError(new Error('socket'), { code })
const cliError = (exitCode: number, message = 'failed'): Error =>
  tagError(new Error(message), { exitCode })

describe('isRetryable', () => {
  it('retries a rate limit and any server fault', () => {
    for (const s of [429, 500, 502, 503, 529]) expect(isRetryable(httpError(s))).toBe(true)
  })

  it('never retries a client error other than 429', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryable(httpError(s))).toBe(false)
  })

  it('retries the transient network codes', () => {
    for (const c of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'])
      expect(isRetryable(netError(c))).toBe(true)
  })

  it('looks through the cause chain (fetch hides the code one level down)', () => {
    const wrapped = new Error('fetch failed', { cause: netError('ECONNRESET') })
    expect(isRetryable(wrapped)).toBe(true)
  })

  it('a cancellation anywhere in the chain wins over a retryable cause', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isRetryable(abort)).toBe(false)
    expect(isRetryable(new Error('wrapper', { cause: abort }))).toBe(false)
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(isRetryable(timeout)).toBe(false)
  })

  it('retries a CLI that exited non-zero, but never a sign-in failure', () => {
    expect(isRetryable(cliError(1, 'Claude CLI failed (exit 1): stream closed'))).toBe(true)
    expect(isRetryable(cliError(1, 'run "codex login" first'))).toBe(false) // sign-in → no
    expect(isRetryable(tagError(new Error('x'), { exitCode: 1, authFailure: true }))).toBe(false)
    expect(isRetryable(cliError(0))).toBe(false)
  })

  it('never retries an unrecognised error (a wrong prompt does not get better)', () => {
    expect(isRetryable(new Error('unparseable JSON'))).toBe(false)
    expect(isRetryable('a string')).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
  })

  it('honours an explicit verdict from the adapter', () => {
    expect(isRetryable(tagError(new Error('x'), { retryable: true }))).toBe(true)
    expect(isRetryable(tagError(new Error('x'), { retryable: false, status: 500 }))).toBe(false)
  })
})

describe('isAuthMessage', () => {
  it('recognises the sign-in wording the CLIs use', () => {
    for (const m of [
      'Not logged in — run `claude auth login`',
      'Please sign in to continue',
      '401 Unauthorized',
      'invalid api key',
      'your credentials have expired'
    ])
      expect(isAuthMessage(m)).toBe(true)
  })

  it('does not fire on an ordinary failure', () => {
    expect(isAuthMessage('stream closed unexpectedly')).toBe(false)
    expect(isAuthMessage('rate limit exceeded')).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const clock = fakeClock()
    let calls = 0
    const out = await withRetry(
      async () => {
        calls++
        return 'ok'
      },
      { sleep: clock.sleep }
    )
    expect(out).toBe('ok')
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('retries a transient failure and succeeds', async () => {
    const clock = fakeClock()
    let calls = 0
    const out = await withRetry(
      async () => {
        if (++calls === 1) throw httpError(503)
        return 'ok'
      },
      { sleep: clock.sleep }
    )
    expect(out).toBe('ok')
    expect(calls).toBe(2)
    expect(clock.waits).toEqual([1000])
  })

  it('backs off deterministically — no jitter, exact multiples', async () => {
    const clock = fakeClock()
    await expect(
      withRetry(
        async () => {
          throw httpError(429)
        },
        { tries: 4, baseMs: 500, factor: 3, sleep: clock.sleep }
      )
    ).rejects.toThrow('API 429')
    expect(clock.waits).toEqual([500, 1500, 4500])
  })

  it('rethrows the LAST error after the final attempt', async () => {
    const clock = fakeClock()
    let n = 0
    await expect(
      withRetry(
        async () => {
          throw httpError(500 + ++n)
        },
        { sleep: clock.sleep }
      )
    ).rejects.toThrow('API 503')
  })

  it('does not retry a permanent failure — one call, no wait', async () => {
    const clock = fakeClock()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw httpError(401)
        },
        { sleep: clock.sleep }
      )
    ).rejects.toThrow('API 401')
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('stops retrying once the run is cancelled, and reports the real error', async () => {
    const ctrl = new AbortController()
    const clock = fakeClock()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          ctrl.abort()
          throw httpError(503)
        },
        { sleep: clock.sleep, signal: ctrl.signal }
      )
    ).rejects.toThrow('API 503')
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('does not sit out a backoff after a cancel during the wait', async () => {
    const ctrl = new AbortController()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw httpError(503)
        },
        {
          signal: ctrl.signal,
          sleep: async () => {
            ctrl.abort()
          }
        }
      )
    ).rejects.toThrow('API 503')
    expect(calls).toBe(1)
  })

  it('accepts a caller-supplied classifier', async () => {
    const clock = fakeClock()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('nope')
        },
        { sleep: clock.sleep, isRetryable: () => true }
      )
    ).rejects.toThrow('nope')
    expect(calls).toBe(3)
  })
})
