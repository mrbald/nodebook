import type { ChatModel, ChatRequest, ProviderConfig } from './provider'

/**
 * Chat adapters for "Ask" — each turns a grounded request into a token stream.
 * Lazily selected from the provider config; nothing here runs unless chat is on.
 * In e2e (`NODEBOOK_E2E`) a deterministic stub stands in for the network so the
 * Ask flow is testable without a key.
 */

/** Parse a Server-Sent-Events response, yielding each `data:` payload line. */
async function* sseData(res: Response): AsyncIterable<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

interface DeltaEvent {
  type?: string
  delta?: { type?: string; text?: string }
  choices?: Array<{ delta?: { content?: string } }>
}

function anthropicChat(cfg: ProviderConfig): ChatModel {
  return {
    id: `anthropic:${cfg.model}`,
    async *chat(req: ChatRequest): AsyncIterable<string> {
      if (!cfg.apiKey) throw new Error('No API key — set ANTHROPIC_API_KEY or [talk.chat] apiKey.')
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1024,
          system: req.system,
          messages: req.messages.filter((m) => m.role !== 'system'),
          stream: true
        })
      })
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`)
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        try {
          const ev = JSON.parse(data) as DeltaEvent
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            yield ev.delta.text ?? ''
          }
        } catch {
          /* ignore keep-alive / non-JSON lines */
        }
      }
    }
  }
}

/** Any OpenAI-compatible /chat/completions endpoint (OpenAI, Groq, Ollama, …). */
function openaiCompatChat(cfg: ProviderConfig): ChatModel {
  return {
    id: `openai-compat:${cfg.model}`,
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const base = (cfg.baseUrl ?? '').replace(/\/+$/, '')
      if (!base) throw new Error('openai-compat needs a baseUrl (e.g. http://localhost:11434/v1).')
      const messages = req.system
        ? [{ role: 'system', content: req.system }, ...req.messages]
        : req.messages
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify({ model: cfg.model, messages, stream: true })
      })
      if (!res.ok) throw new Error(`Chat API ${res.status}: ${(await res.text()).slice(0, 200)}`)
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        try {
          const ev = JSON.parse(data) as DeltaEvent
          const delta = ev.choices?.[0]?.delta?.content
          if (typeof delta === 'string') yield delta
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Deterministic, network-free chat for e2e. For "Ask" it echoes a short grounded
 *  answer with an inline `[[wikilink]]` citation; for a distill extraction prompt
 *  it returns valid JSON quoting the first chunk shown, so the whole distill
 *  vertical is testable without a key or network. */
function stubChat(): ChatModel {
  return {
    id: 'stub',
    async *chat(req: ChatRequest): AsyncIterable<string> {
      if ((req.system ?? '').includes('extract structured knowledge')) {
        const user = req.messages.map((m) => m.content).join('\n')
        const m = /\[chunk (\d+)[^\]]*\]\n([^\n]+)/.exec(user)
        if (m) {
          const quote = m[2].split(/\s+/).slice(0, 5).join(' ')
          yield JSON.stringify({
            items: [
              { kind: 'concept', title: quote, summary: 'Stubbed.', evidence: [{ chunkId: Number(m[1]), quote }], links: [] }
            ]
          })
        } else {
          yield '{"items":[]}'
        }
        return
      }
      const q = req.messages[req.messages.length - 1]?.content ?? ''
      for (const tok of [
        'Based on your notes, ',
        `the answer to "${q}" `,
        'is here. See [[welcome]].'
      ])
        yield tok
    }
  }
}

/** Ollama's default local OpenAI-compatible endpoint. */
const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1'

export function makeChatModel(cfg: ProviderConfig): ChatModel {
  if (process.env.NODEBOOK_E2E) return stubChat()
  if (cfg.kind === 'anthropic') return anthropicChat(cfg)
  if (cfg.kind === 'openai-compat') return openaiCompatChat(cfg)
  // Ollama is openai-compat pointed at the local server by default (no key).
  if (cfg.kind === 'ollama')
    return openaiCompatChat({ ...cfg, baseUrl: cfg.baseUrl ?? OLLAMA_DEFAULT_URL })
  throw new Error(`Unsupported chat provider: ${cfg.kind}`)
}
