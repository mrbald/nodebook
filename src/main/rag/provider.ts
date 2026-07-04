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
 * `'codex-cli'` runs the user's own installed OpenAI Codex CLI (`codex exec`)
 * under their ChatGPT sign-in — no API key. `'cli'` is the generic escape
 * hatch: any user-supplied command that reads a prompt on stdin and prints the
 * answer on stdout (see docs/cli-providers.md, including why Claude Code is
 * reached this way rather than as a named preset).
 */
export type ProviderKind =
  | 'local'
  | 'ollama'
  | 'openai-compat'
  | 'anthropic'
  | 'codex-cli'
  | 'cli'
  | 'mcp'

export interface ProviderConfig {
  kind: ProviderKind
  /** Model name/id for the chosen backend. Empty = the backend's own default. */
  model?: string
  /** OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio, gateways, …). */
  baseUrl?: string
  apiKey?: string
  /** CLI backends: the executable ('codex-cli' defaults to `codex`; required
   *  for 'cli'). A bare name is resolved against PATH plus the usual install
   *  dirs — GUI-launched Electron does not inherit the shell PATH. */
  command?: string
  /** 'cli' only: arguments placed before the stdin-fed prompt. */
  args?: string[]
}

/** Produces an embedder and/or chat model from its config (lazy, async). */
export interface ModelProvider {
  readonly kind: ProviderKind
  embedder?(cfg: ProviderConfig): Promise<Embedder>
  chat?(cfg: ProviderConfig): Promise<ChatModel>
}
