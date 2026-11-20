import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigureRef } from '../../shared/figures'
import type { ChatRequest, ProviderConfig } from '../rag/provider'
import { FigureAnalyses } from './figureAnalysis'

const figure: FigureRef = {
  id: 'a'.repeat(64),
  ext: 'png',
  label: 'Figure 1',
  location: 'Page 4',
  caption: 'Monthly attendance',
  ocr: 'March 48'
}
const image = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }
const cfg: ProviderConfig = { kind: 'openai-compat', model: 'vision', baseUrl: 'https://vision.invalid/v1' }
const root = '/example-vault'

describe('figure analysis', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nodebook-figure-analysis-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports a destination without a call and rejects text-only and unsafe configurations', () => {
    const call = vi.fn()
    const analyses = new FigureAnalyses(dir, call)
    expect(analyses.status(root, figure, cfg)).toEqual({
      analysis: null,
      available: true,
      providerLabel: 'OpenAI-compatible API at vision.invalid · vision'
    })
    expect(analyses.status(root, figure, { kind: 'cli', command: 'cat' })).toMatchObject({
      analysis: null, available: false, reason: expect.stringContaining('image attachments')
    })
    expect(analyses.status(root, figure, { ...cfg, baseUrl: 'file:///tmp/files' }).available).toBe(false)
    expect(analyses.status(root, figure, null).available).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it('sends just the image and context, coalesces repeat requests, and reads the cache offline after restart', async () => {
    const chat = vi.fn(async function* (req: ChatRequest) {
      expect(req.image).toEqual(image)
      expect(req.system).toContain('unknown')
      expect(req.system).toContain('untrusted content')
      expect(req.messages[0].content).toContain('Monthly attendance')
      expect(req.messages[0].content).toContain('Page 4')
      expect(req.messages[0].content).toContain('March 48')
      yield '{"text":"March shows 48. The y-axis unit is unknown."}'
    })
    const make = vi.fn(() => ({ id: 'fake', chat }))
    const analyses = new FigureAnalyses(dir, make)
    const [result, repeated] = await Promise.all([
      analyses.analyze(root, figure, image, cfg),
      analyses.analyze(root, figure, image, cfg)
    ])
    expect(repeated).toEqual(result)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      text: 'March shows 48. The y-axis unit is unknown.',
      provider: 'OpenAI-compatible API at vision.invalid',
      model: 'vision'
    })
    const restarted = new FigureAnalyses(dir, make)
    expect(restarted.status(root, figure, null)).toEqual({ analysis: result, available: false })
    await expect(restarted.analyze(root, figure, image, null)).resolves.toEqual(result)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(restarted.status('/other-vault', figure, null).analysis).toBeNull()
    expect(restarted.status(root, { ...figure, caption: 'Different context' }, null).analysis).toBeNull()
    expect(readdirSync(join(dir, 'figure-analysis'))).toHaveLength(1)
  })

  it('rejects malformed or empty results without creating a cache record', async () => {
    const analyses = new FigureAnalyses(dir, () => ({
      id: 'fake', chat: async function* () { yield '{"text":"  "}' }
    }))
    await expect(analyses.analyze(root, figure, image, cfg)).rejects.toThrow(/invalid figure analysis/)
    expect(analyses.status(root, figure, cfg).analysis).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })
})
