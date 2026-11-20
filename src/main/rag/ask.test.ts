import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { figureMarkdown, figurePath, type CapturedFigure } from '../../shared/figures'
import { mergeRun, writeRunArtifact } from '../distill/artifact'
import { figureOcrMarkdown } from '../distill/captureFigures'
import { prepareSource, publishSource } from '../distill/sources'
import { VaultIndex } from '../indexer'
import { authoredAskPassages, packAskContext } from './ask'

const CAPTION = 'The Authoredstudy caption names the field review.'
const OCR_ONLY = 'Hiddenchartword705'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmioAAAAASUVORK5CYII=', 'base64')
const id = createHash('sha256').update(pixel).digest('hex')
const mixed: CapturedFigure = { id, bytes: pixel, ext: 'png', label: 'Field chart figure', location: 'Page 1', ocr: 'Read visually from chart' }
const only: CapturedFigure = { id, bytes: pixel, ext: 'png', label: 'Data screenshot figure', location: 'Page 2', ocr: `${'chart cells '.repeat(131)}${OCR_ONLY}` }
const roots: string[] = []
const indexes: VaultIndex[] = []

afterEach(() => {
  for (const index of indexes.splice(0)) index.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nodebook-ask-evidence-'))
  roots.push(root)
  const original = join(root, 'Report.pdf')
  writeFileSync(original, 'original placeholder')
  const text = `## Page 1\n\n${CAPTION}\n\n${figureMarkdown(mixed)}\n\n${figureOcrMarkdown(mixed)}\n\n## Page 2\n\n${figureMarkdown(only)}\n\n${figureOcrMarkdown(only)}`
  const approved = publishSource(root, await prepareSource(root, original, async () => ({ text, figures: [mixed, only] })))
  writeRunArtifact(root, 'report', {
    file: 'Report.pdf', text, hash: approved.hash, originalPath: original,
    figures: approved.record.figures
  }, [])
  mergeRun(root, 'report')
  rmSync(original)
  rmSync(join(root, 'Sources', figurePath(mixed)))
  const book = join(root, 'Sources', 'Report.md')
  const bookText = readFileSync(book, 'utf8')
  const index = new VaultIndex(join(root, '.nodebook', 'index.db'))
  indexes.push(index)
  index.indexFile(book, bookText)
  return { root, book, bookText, index }
}

describe('Ask evidence for merged figures', () => {
  it('keeps OCR keyword-searchable but removes OCR-only hits and preserves authored citation offsets', async () => {
    const { root, book, bookText, index } = await fixture()
    expect(index.talkSearch(OCR_ONLY, null).map((hit) => hit.path)).toContain(book)
    const raw = index.talkRetrieve(OCR_ONLY, null)
    expect(raw[0]?.text).toContain(OCR_ONLY)
    expect(authoredAskPassages(root, raw)).toEqual([])

    const authored = index.talkRetrieve('Authoredstudy', null)
    expect(authored[0]?.text).toContain(figurePath(mixed))
    const { prompt, citations } = packAskContext('Authoredstudy', root, authoredAskPassages(root, authored), 4000)
    expect(prompt).toContain(CAPTION)
    expect(prompt).not.toMatch(/figures\/|Figure OCR text|Read visually/)
    expect(citations).toHaveLength(1)
    const [cite] = citations
    expect(bookText.slice(cite.start, cite.end)).toBe(CAPTION)
  })

  it('filters vector hits on fragmented OCR and leaves ordinary notes untouched', async () => {
    const { root, index, book } = await fixture()
    const ordinary = join(root, 'Sources', 'Ordinary.md')
    const ordinaryText = `# Ordinary\n\n${figureOcrMarkdown(mixed)}`
    writeFileSync(ordinary, ordinaryText)
    index.enableTalk()
    index.setEmbedDims(2, 'fixed-test-vectors')
    index.chunkIndexedFile(book)
    index.indexFile(ordinary, ordinaryText)
    const generation = index.talkGeneration!
    index.putEmbeddings(generation, index.talkPending(generation).map(({ id, text }) => ({
      id, vector: Float32Array.from(text.includes(OCR_ONLY) ? [1, 0] : [0, 1])
    })))
    const raw = index.talkRetrieve('semanticprobe710', Float32Array.from([1, 0]), 1)
    expect(raw[0]?.file).toBe(book)
    expect(raw[0]?.text).toContain(OCR_ONLY)
    expect(raw[0]?.text).not.toContain('Figure OCR text')
    expect(authoredAskPassages(root, raw)).toEqual([])

    const ordinaryHits = index.talkRetrieve('visually', null).filter((chunk) => chunk.file === ordinary)
    expect(ordinaryHits).toHaveLength(1)
    expect(authoredAskPassages(root, ordinaryHits)).toEqual(ordinaryHits)
  })
})
