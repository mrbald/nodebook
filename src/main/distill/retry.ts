/**
 * Retrying a model call that failed for a reason that might not repeat.
 *
 * A distill run makes one call per window, sequentially. A single 429 or a
 * dropped socket used to end the whole run and throw away everything already
 * extracted, so a long book was at the mercy of the flakiest minute of the
 * provider's day. `withRetry` gives each call a few deterministic attempts.
 *
 * Two rules shape the classifier:
 *
 * - **Whitelist, never guess.** Only errors we can positively recognise as
 *   transient are retried (a rate limit, a server fault, a dropped connection,
 *   a CLI that exited non-zero for a non-auth reason). Anything unrecognised is
 *   treated as permanent — retrying a bad request three times just spends the
 *   user's quota three times.
 * - **A wrong key must fail fast.** Auth failures, 4xx other than 429 and every
 *   form of cancellation are never retried.
 *
 * Pure and dependency-free: no timers of its own (`sleep` is injected and
 * defaulted), no jitter, so a test with a fake clock sees exact delays. The
 * adapters in `rag/chat.ts` and `rag/cliChat.ts` tag their errors with
 * `tagError` so this module never has to parse an error message to decide.
 */

/** What an adapter attaches to an error so it can be classified without prose
 *  matching. Every field is optional; an untagged error is "unrecognised". */
export interface ErrorTags {
  /** HTTP status of a failed response. */
  status?: number
  /** Node's network error code (`ECONNRESET`, …). */
  code?: string
  /** Exit code of a CLI backend that failed. */
  exitCode?: number | null
  /** The failure is a sign-in / credentials problem — never retry it. */
  authFailure?: boolean
  /** The adapter already knows the verdict; skips every other rule. */
  retryable?: boolean
}

/** Attach classification tags to an error and return it (for `throw tagError(…)`). */
export function tagError<E extends Error>(err: E, tags: ErrorTags): E {
  return Object.assign(err, tags)
}

/** Transient at the socket level: the same request may well work next time. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'])

/** Cancellation, by any of the names the app's layers give it. `TimeoutError`
 *  is `AbortSignal.timeout`'s name — a deadline the caller set, not a fault to
 *  retry against. */
const ABORT_NAMES = new Set(['AbortError', 'DistillAborted', 'TimeoutError'])

/** Does this text read like "you are not signed in"? Used by the CLI adapters
 *  to tag an exit whose stderr says the user has to log in — that never gets
 *  better by trying again. */
export function isAuthMessage(text: string): boolean {
  return /\b(?:not (?:logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|forbidden|authenticat\w*|api[- ]?key|credentials?|token expired)\b/i.test(
    text
  )
}

type Verdict = 'retry' | 'never' | 'unknown'

function classifyOne(err: unknown): Verdict {
  if (typeof err !== 'object' || err === null) return 'unknown'
  const e = err as ErrorTags & { name?: unknown; message?: unknown }
  if (typeof e.name === 'string' && ABORT_NAMES.has(e.name)) return 'never'
  if (typeof e.retryable === 'boolean') return e.retryable ? 'retry' : 'never'
  if (e.authFailure === true) return 'never'
  // An HTTP status is decisive: 429 and 5xx are the provider asking us to wait;
  // any other 4xx is our request being wrong, and repeating it changes nothing.
  if (typeof e.status === 'number')
    return e.status === 429 || e.status >= 500 ? 'retry' : 'never'
  if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return 'retry'
  if (typeof e.exitCode === 'number' && e.exitCode !== 0)
    return typeof e.message === 'string' && isAuthMessage(e.message) ? 'never' : 'retry'
  return 'unknown'
}

/** `fetch` reports a dead socket as `TypeError: fetch failed` and hides the
 *  real code in `cause`, so the whole chain is inspected. Bounded, and a
 *  `never` anywhere in it wins over a `retry` further down. */
function* chain(err: unknown): Iterable<unknown> {
  let cur = err
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    yield cur
    cur = (cur as { cause?: unknown }).cause
  }
}

/** The default classifier: is this error worth another attempt? */
export function isRetryable(err: unknown): boolean {
  let verdict = false
  for (const e of chain(err)) {
    const v = classifyOne(e)
    if (v === 'never') return false
    if (v === 'retry') verdict = true
  }
  return verdict
}

export interface RetryOptions {
  /** Total attempts, including the first (default 3). */
  tries?: number
  /** Delay before the second attempt (default 1000 ms); ×`factor` after that. */
  baseMs?: number
  /** Backoff multiplier (default 2). */
  factor?: number
  /** Classifier (default `isRetryable`). */
  isRetryable?: (err: unknown) => boolean
  /** Injected clock — resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Cancellation: an abort stops the retrying immediately. */
  signal?: AbortSignal
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Call `fn`, retrying while the error looks transient. Rethrows the LAST error
 * — the caller's message is about what actually failed, not about the retrying.
 * A cancelled signal stops the loop at once (during the wait as well), so a
 * cancel never has to sit out a backoff.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 3)
  const baseMs = opts.baseMs ?? 1000
  const factor = opts.factor ?? 2
  const retryable = opts.isRetryable ?? isRetryable
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= tries || opts.signal?.aborted || !retryable(err)) throw err
      await sleep(baseMs * factor ** (attempt - 1), opts.signal)
      // Aborted while waiting: report what went wrong, don't call again.
      if (opts.signal?.aborted) throw err
    }
  }
}
