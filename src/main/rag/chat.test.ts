import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeChatModel } from './chat'
import type { ChatRequest, ProviderConfig } from './provider'

describe('HTTP figure requests', () => {
  const req: ChatRequest = {
    system: 'Interpret this figure.',
    messages: [{ role: 'user', content: 'Caption: attendance' }],
    image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }
  }
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it.each([
    {
      cfg: { kind: 'anthropic', apiKey: 'fake' } as ProviderConfig,
      endpoint: 'https://api.anthropic.com/v1/messages',
      attachment: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A figure.' } }
    },
    {
      cfg: { kind: 'openai-compat', model: 'vision', baseUrl: 'https://vision.invalid/v1' } as ProviderConfig,
      endpoint: 'https://vision.invalid/v1/chat/completions',
      attachment: { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      event: { choices: [{ delta: { content: 'A figure.' } }] }
    },
    {
      cfg: { kind: 'ollama', model: 'vision' } as ProviderConfig,
      endpoint: 'http://localhost:11434/v1/chat/completions',
      attachment: { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      event: { choices: [{ delta: { content: 'A figure.' } }] }
    }
  ])('uses image content blocks for $cfg.kind', async ({ cfg, endpoint, attachment, event }) => {
    vi.stubEnv('NODEBOOK_E2E', '')
    const fetchStub = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () =>
      new Response(`data: ${JSON.stringify(event)}\n`))
    vi.stubGlobal('fetch', fetchStub)
    const chunks = []
    for await (const token of makeChatModel(cfg).chat(req)) chunks.push(token)
    expect(chunks).toEqual(['A figure.'])
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, options] = fetchStub.mock.calls[0]
    expect(url).toBe(endpoint)
    expect(options.redirect).toBe('error')
    expect(JSON.parse(options.body as string).messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Caption: attendance' }, attachment]
    })
  })
})
