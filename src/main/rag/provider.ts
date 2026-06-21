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
}

/** Streams answer tokens for a grounded question. */
export interface ChatModel {
  readonly id: string
  chat(req: ChatRequest): AsyncIterable<string>
}

/** The three realistic ways to connect a model to the app. */
export type ProviderKind = 'local' | 'openai-compat' | 'anthropic' | 'mcp'

export interface ProviderConfig {
  kind: ProviderKind
  /** Model name/id for the chosen backend. */
  model?: string
  /** OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio, gateways, …). */
  baseUrl?: string
  apiKey?: string
}

/** Produces an embedder and/or chat model from its config (lazy, async). */
export interface ModelProvider {
  readonly kind: ProviderKind
  embedder?(cfg: ProviderConfig): Promise<Embedder>
  chat?(cfg: ProviderConfig): Promise<ChatModel>
}
