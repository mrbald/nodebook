/**
 * The model-provider abstraction for "talk to docs". One small surface that
 * embeddings and chat go through, so the backend (in-process local model, a
 * remote OpenAI-compatible endpoint, Anthropic, or MCP) is a config choice —
 * see docs/talk-to-docs.md "Connecting models".
 *
 * Nothing here imports a model runtime; adapters (local/openai-compat/…) live in
 * their own files and are loaded lazily only when the feature is enabled.
 */

/** Turns text into vectors. `dims` must match the sqlite-vec column width. */
export interface Embedder {
  readonly id: string
  readonly dims: number
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  /** Grounding instruction + the retrieved note chunks as context. */
  system?: string
  messages: ChatTurn[]
  /** Optional cancellation — adapters pass it through to `fetch`. */
  signal?: AbortSignal
}

/** Streams answer tokens for a grounded question. */
export interface ChatModel {
  readonly id: string
  chat(req: ChatRequest): AsyncIterable<string>
  /** Optional cheap health check (binary found, signed in). When present,
   *  `probeChat` uses it instead of a real model round-trip — CLI backends
   *  bill every chat call against the user's subscription quota, so the
   *  pre-flight must not spend it. */
  probe?(signal?: AbortSignal): Promise<void>
  /** How much prompt this backend will accept, in the chunker's weight units
   *  (`weightOf`: a Latin character = 1, a CJK code point = 3). The model side
   *  DECLARES it; distill's window planner sizes its reading windows from it
   *  (see `distill/windows.ts`) instead of guessing. Absent = the caller's own
   *  default (`DEFAULT_INPUT_BUDGET`). It is a budget, not a guarantee — a
   *  backend may still reject a prompt it declared room for, which is what
   *  `ContextLengthError` and distill's lossless split are for. */
  inputBudget?: number
}

/**
 * The prompt was rejected for being too long — the one failure that is fixed
 * by sending LESS, not by sending it again. Adapters map their provider's
 * context-length rejection onto this (see `isContextLengthMessage`); distill
 * answers it by splitting the window in two and reading both halves, so no
 * text is lost. Tagged `retryable: false` so `withRetry` never spends a second
 * attempt on a prompt that cannot fit.
 */
export class ContextLengthError extends Error {
  readonly retryable = false
  constructor(message: string) {
    super(message)
    this.name = 'ContextLengthError'
  }
}

/**
 * Pure: does this provider message mean "your prompt is too long"? Every
 * backend words it differently — Anthropic returns a 400 whose body says
 * "prompt is too long", OpenAI-style APIs use the `context_length_exceeded`
 * code or "maximum context length", Ollama reports the input exceeding the
 * context, and a CLI prints whatever its own wrapper says. Recognising the
 * family instead of one vendor's string keeps this one small predicate:
 * anything that mentions the CONTEXT and says it was exceeded (or too
 * long/large) counts. Deliberately narrow — "rate limit exceeded" must not
 * match, or a 429 would be answered by splitting the window instead of waiting.
 */
export function isContextLengthMessage(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('context_length_exceeded')) return true
  if (t.includes('prompt is too long')) return true
  if (t.includes('maximum context length')) return true
  return /\bcontext\b/.test(t) && /(too long|too large|too many tokens|exceed)/.test(t)
}

/** Prompt budget when nothing declares one (weight units, see `ChatModel`). */
export const DEFAULT_INPUT_BUDGET = 16_000

/** Per-family prompt budgets, in weight units. Cloud and CLI backends all sit
 *  on models with ≥100k-token windows, so 16 000 weight (≈5k tokens of Latin
 *  text) is a conservative slice of what they accept; Ollama's defaults are a
 *  2k-token window, so a local model gets a smaller one. These are starting
 *  points a user can override with `[talk.chat] contextTokens`. */
const FAMILY_INPUT_BUDGET: Record<ProviderKind, number> = {
  local: DEFAULT_INPUT_BUDGET,
  ollama: 6_000,
  'openai-compat': DEFAULT_INPUT_BUDGET,
  anthropic: DEFAULT_INPUT_BUDGET,
  'codex-cli': DEFAULT_INPUT_BUDGET,
  'claude-cli': DEFAULT_INPUT_BUDGET,
  cli: DEFAULT_INPUT_BUDGET,
  mcp: DEFAULT_INPUT_BUDGET
}

/** Pure: the prompt budget for a provider config — `contextTokens` × 3 when
 *  the user set one (a token is ~3 Latin characters, the unit `weightOf`
 *  counts), else the family default. */
export function inputBudgetFor(cfg: Pick<ProviderConfig, 'kind' | 'contextTokens'>): number {
  const tokens = cfg.contextTokens ?? 0
  if (Number.isFinite(tokens) && tokens > 0) return Math.round(tokens * 3)
  return FAMILY_INPUT_BUDGET[cfg.kind] ?? DEFAULT_INPUT_BUDGET
}

/**
 * How a *model* backend is reached. Scope discipline: this abstraction is for
 * embedders + chat models ONLY. Document conversion (book → markdown) is a
 * separate `DocumentConverter` subsystem, and exposing Nodebook *as* an MCP
 * server is a separate outbound feature — neither is a `ProviderKind`. `'mcp'`
 * here means Nodebook as an MCP *client* of a model/tool server.
 *
 * `'ollama'` is a zero-config convenience over `'openai-compat'`: a local Ollama
 * server at its default URL, no key. (`'local'` is reserved for a future
 * in-process model — not the same thing as talking to a local server.)
 *
 * `'codex-cli'` and `'claude-cli'` run the user's own installed CLI — OpenAI
 * Codex under their ChatGPT sign-in, Anthropic's Claude Code under their Claude
 * sign-in — with no API key. `'cli'` is the generic escape hatch: any
 * user-supplied command that reads a prompt on stdin and prints the answer on
 * stdout (see docs/cli-providers.md).
 */
export type ProviderKind =
  | 'local'
  | 'ollama'
  | 'openai-compat'
  | 'anthropic'
  | 'codex-cli'
  | 'claude-cli'
  | 'cli'
  | 'mcp'

export interface ProviderConfig {
  kind: ProviderKind
  /** Model name/id for the chosen backend. Empty = the backend's own default. */
  model?: string
  /** OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio, gateways, …). */
  baseUrl?: string
  apiKey?: string
  /** CLI backends: the executable ('codex-cli' defaults to `codex`, 'claude-cli'
   *  to `claude`; required for 'cli'). A bare name is resolved against PATH plus
   *  the usual install dirs — GUI-launched Electron does not inherit the shell
   *  PATH. */
  command?: string
  /** 'cli' only: arguments placed before the stdin-fed prompt. */
  args?: string[]
  /** How many tokens of prompt this model accepts. 0/absent = the family
   *  default (see `inputBudgetFor`). Set it when the family default is wrong
   *  for your model — a 128k-context local model, or a small one. */
  contextTokens?: number
}

/** Produces an embedder and/or chat model from its config (lazy, async). */
export interface ModelProvider {
  readonly kind: ProviderKind
  embedder?(cfg: ProviderConfig): Promise<Embedder>
  chat?(cfg: ProviderConfig): Promise<ChatModel>
}
