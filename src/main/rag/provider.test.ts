import { describe, it, expect, afterEach } from 'vitest'
import {
  ContextLengthError,
  DEFAULT_INPUT_BUDGET,
  inputBudgetFor,
  isContextLengthMessage
} from './provider'
import { makeChatModel } from './chat'
import { isRetryable } from '../distill/retry'

describe('isContextLengthMessage', () => {
  it('recognises each provider family’s way of saying "too long"', () => {
    // Anthropic: a 400 whose body says the prompt is too long.
    expect(
      isContextLengthMessage(
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'
      )
    ).toBe(true)
    // OpenAI-style: an error code, or the prose that comes with it.
    expect(isContextLengthMessage('{"error":{"code":"context_length_exceeded"}}')).toBe(true)
    expect(
      isContextLengthMessage(
        "This model's maximum context length is 8192 tokens, however you requested 9000"
      )
    ).toBe(true)
    // Ollama / llama.cpp.
    expect(isContextLengthMessage('input length exceeds context length')).toBe(true)
    // A CLI printing its own wording.
    expect(isContextLengthMessage('Error: context window exceeded for this request')).toBe(true)
    expect(isContextLengthMessage('the prompt is too long for the model context')).toBe(true)
  })

  it('is case- and shape-insensitive', () => {
    expect(isContextLengthMessage('PROMPT IS TOO LONG')).toBe(true)
    expect(isContextLengthMessage('Context_Length_Exceeded')).toBe(true)
  })

  it('does not fire on other failures — splitting a window must not answer a 429', () => {
    expect(isContextLengthMessage('rate limit exceeded, please retry')).toBe(false)
    expect(isContextLengthMessage('429 Too Many Requests')).toBe(false)
    expect(isContextLengthMessage('401 invalid api key')).toBe(false)
    expect(isContextLengthMessage('the request took too long and timed out')).toBe(false)
    expect(isContextLengthMessage('quota exceeded for this month')).toBe(false)
    expect(isContextLengthMessage('')).toBe(false)
  })
})

describe('ContextLengthError', () => {
  it('is never retried — the same prompt would be rejected again', () => {
    expect(isRetryable(new ContextLengthError('prompt is too long'))).toBe(false)
  })

  it('is recognisable by name across a process boundary', () => {
    const e = new ContextLengthError('prompt is too long')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ContextLengthError')
  })
})

describe('inputBudgetFor', () => {
  it('gives cloud and CLI backends the same generous default', () => {
    for (const kind of ['anthropic', 'openai-compat', 'claude-cli', 'codex-cli', 'cli'] as const) {
      expect(inputBudgetFor({ kind })).toBe(DEFAULT_INPUT_BUDGET)
    }
  })

  it('gives a local Ollama model a smaller one (its default window is small)', () => {
    expect(inputBudgetFor({ kind: 'ollama' })).toBe(6_000)
    expect(inputBudgetFor({ kind: 'ollama' })).toBeLessThan(inputBudgetFor({ kind: 'anthropic' }))
  })

  it('lets contextTokens override it, counted as three weight units per token', () => {
    expect(inputBudgetFor({ kind: 'ollama', contextTokens: 32_000 })).toBe(96_000)
    expect(inputBudgetFor({ kind: 'anthropic', contextTokens: 1_000 })).toBe(3_000)
  })

  it('treats 0 and nonsense as "use the family default"', () => {
    expect(inputBudgetFor({ kind: 'ollama', contextTokens: 0 })).toBe(6_000)
    expect(inputBudgetFor({ kind: 'ollama', contextTokens: -5 })).toBe(6_000)
    expect(inputBudgetFor({ kind: 'ollama', contextTokens: NaN })).toBe(6_000)
  })
})

describe('makeChatModel', () => {
  it('declares its prompt budget, so distill never has to guess', () => {
    expect(makeChatModel({ kind: 'anthropic' }).inputBudget).toBe(DEFAULT_INPUT_BUDGET)
    expect(makeChatModel({ kind: 'ollama', model: 'llama3.2' }).inputBudget).toBe(6_000)
    expect(makeChatModel({ kind: 'anthropic', contextTokens: 2_000 }).inputBudget).toBe(6_000)
  })
})

describe('makeChatModel under the e2e door', () => {
  const saved = { e2e: process.env.NODEBOOK_E2E, live: process.env.NODEBOOK_E2E_LIVE_CHAT }
  afterEach(() => {
    if (saved.e2e === undefined) delete process.env.NODEBOOK_E2E
    else process.env.NODEBOOK_E2E = saved.e2e
    if (saved.live === undefined) delete process.env.NODEBOOK_E2E_LIVE_CHAT
    else process.env.NODEBOOK_E2E_LIVE_CHAT = saved.live
  })

  it('swaps in the stub under NODEBOOK_E2E, and keeps the real adapter when the live flag is set too', () => {
    process.env.NODEBOOK_E2E = '1'
    delete process.env.NODEBOOK_E2E_LIVE_CHAT
    expect(makeChatModel({ kind: 'claude-cli' }).id).toBe('stub')
    process.env.NODEBOOK_E2E_LIVE_CHAT = '1'
    expect(makeChatModel({ kind: 'claude-cli' }).id).toBe('claude-cli:default')
  })
})
