import { describe, expect, it, vi } from 'vitest'
import { figureMarkdown, figurePath, type FigureRef } from '../../shared/figures'
import { parseCitations } from '../../shared/markdown/noteCitations'
import { chunkMarkdown } from '../rag/chunk'
import { figureOcrMarkdown } from './captureFigures'
import { renderDocumentNote } from './emit'
import { distill, estimateDistill, figureOnlyResult } from './run'
import { chunkDistillSource } from './sourceEvidence'

const figure: FigureRef = {
  id: 'ab'.repeat(32),
  ext: 'png',
  label: 'Figure 1 on page 2',
  location: 'Page 2',
  ocr: 'Quarterly matrix 111 222 333 444'
}
const image = figureMarkdown(figure)
const ocr = figureOcrMarkdown(figure)
const embedder = { embed: vi.fn(async () => []) }

describe('authored distill evidence', () => {
  it('keeps caption and prose offsets exact, without passing image paths or OCR into the model', async () => {
    const caption = 'The original workshop caption describes the study period.'
    const sentence = 'An independent attendance review ran from January through December.'
    const source = {
      file: 'report.pdf',
      figures: [figure],
      text: `## Page 1 ${image}\n\n${caption}\n\n${image}\n\n${sentence}\n\n## Page 2\n\n${image}\n\n${ocr}`
    }
    const items = [
      { title: 'Attendance review', summary: sentence, kind: 'claim', evidence: [{ chunkId: 0, quote: sentence }] },
      { title: image, kind: 'concept', evidence: [{ chunkId: 0, quote: figurePath(figure) }] },
      { title: 'Quarterly totals', kind: 'claim', evidence: [{ chunkId: 2, quote: figure.ocr }] },
      { title: 'Crosses figure', kind: 'claim', evidence: [{ chunkId: 0, quote: `${caption}\n\n${image}\n\n${sentence}` }] }
    ]
    const prompt = vi.fn()
    const chat = {
      id: 'fake-attendance-extractor',
      async *chat(request: { messages: unknown[] }) {
        prompt(JSON.stringify(request.messages))
        yield JSON.stringify({ language: 'English', items })
      }
    }
    const estimate = estimateDistill(source.text, {}, source.figures)
    const result = await distill(source, { chat, embedder })
    expect(result.stats.chunks).toBe(estimate.chunks)
    expect(result.stats.calls).toBe(estimate.calls)
    expect(result.stats.droppedByReason.notFound).toBe(3)
    expect(result.notes.map((note) => note.name)).toEqual(['Attendance review'])
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt.mock.calls[0][0]).toContain(caption)
    expect(prompt.mock.calls[0][0]).toContain(sentence)
    expect(prompt.mock.calls[0][0]).not.toMatch(/figures\/|Figure 1|Quarterly matrix|111 222/)
    const [citation] = parseCitations(result.notes[0].content)
    expect(renderDocumentNote(source).content.slice(citation.start, citation.end)).toBe(sentence)
    expect(citation.quote).toBe(sentence)
    expect(citation.where).toBe('Page 1')
  })

  it('uses no chat or embedding for a figure-only source even when it has OCR', async () => {
    const source = {
      file: 'chart.pdf',
      text: `## Page 2\n\n[${image}](https://example.test/full(chart))\n\n${ocr}`,
      figures: [figure]
    }
    const chat = { id: 'unused-chat', chat: vi.fn(async function* () { yield '{}' }) }
    expect(estimateDistill(source.text, {}, source.figures)).toMatchObject({ chunks: 0, calls: 0 })
    expect(await distill(source, { chat, embedder })).toEqual(figureOnlyResult())
    expect(chat.chat).not.toHaveBeenCalled()
    expect(embedder.embed).not.toHaveBeenCalled()
  })

  it('keeps historical chunking and source offsets when a run has no figure inventory', () => {
    const text = `# A study\n\nAn authored paragraph.\n\n${image}\n\n${ocr}`
    expect(chunkDistillSource(text)).toEqual(chunkMarkdown(text))
  })
})
