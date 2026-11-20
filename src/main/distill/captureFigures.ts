import { createHash } from 'crypto'
import { performance } from 'perf_hooks'
import type { CapturedFigure, FigureCoverage, FigureRef } from '../../shared/figures'
import { completeFigureImage, figureImageDimensions } from './figureImage'

export const MAX_FIGURE_BYTES = 8 * 1024 * 1024
const MAX_DOCUMENT_FIGURE_BYTES = 64 * 1024 * 1024
const MAX_DISTINCT_FIGURES = 256
const MAX_FIGURE_PLACEMENTS = 1024
const MAX_FIGURE_PIXELS = 32_000_000
const MAX_OCR_IMAGES = 48
const MAX_OCR_MS = 45_000

export function literalFigureText(text: string): string {
  return text.replace(/[\\[\]!`*_<>|]/g, '\\$&')
}

export function cleanFigureText(text: string, limit = 500): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function figureOcrMarkdown(ref: FigureRef): string {
  if (!ref.ocr) return ''
  const context = literalFigureText(`${ref.label}, ${ref.location}`)
  return `Figure OCR text (${context}): ${literalFigureText(ref.ocr)}`
}

export type FigurePlacement = Pick<FigureRef, 'label' | 'location' | 'caption'>

/** Bytes are budgeted and OCR is memoized per image, while each placement
 * keeps its own caption, alternative text, and location. */
export class FigureCapture {
  readonly figures: CapturedFigure[] = []
  private readonly assets = new Map<string, Pick<CapturedFigure, 'ext' | 'bytes' | 'ocr'>>()
  private bytes = 0
  private skipped = 0
  private uninspectedPages = 0
  private ocrCount = 0
  private ocrMs = 0

  constructor(readonly signal?: AbortSignal) {}

  get coverage(): FigureCoverage | undefined {
    return this.skipped || this.uninspectedPages
      ? { skipped: this.skipped, ...(this.uninspectedPages ? { uninspectedPages: this.uninspectedPages } : {}) }
      : undefined
  }

  skip(): undefined {
    this.skipped++
    return undefined
  }

  skipPage(): void {
    this.uninspectedPages++
  }

  get full(): boolean {
    return this.figures.length >= MAX_FIGURE_PLACEMENTS || this.bytes >= MAX_DOCUMENT_FIGURE_BYTES
  }

  async add(bytes: Uint8Array, placement: FigurePlacement): Promise<CapturedFigure | undefined> {
    this.signal?.throwIfAborted()
    if (this.full || !bytes.length || bytes.length > MAX_FIGURE_BYTES) return this.skip()
    const id = createHash('sha256').update(bytes).digest('hex')
    let asset = this.assets.get(id)
    if (!asset) {
      if (this.assets.size >= MAX_DISTINCT_FIGURES || this.bytes + bytes.length > MAX_DOCUMENT_FIGURE_BYTES) {
        return this.skip()
      }
      const shape = figureImageDimensions(bytes)
      if (!shape) return this.skip()
      const [ext, width, height] = shape
      if (Math.min(width, height) < 16) return undefined
      if (width * height > MAX_FIGURE_PIXELS || !completeFigureImage(bytes, ext)) return this.skip()
      let ocr = ''
      if (this.ocrCount < MAX_OCR_IMAGES && this.ocrMs < MAX_OCR_MS) {
        this.ocrCount++
        const started = performance.now()
        const timeout = AbortSignal.timeout(Math.ceil(MAX_OCR_MS - this.ocrMs))
        const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
        const { recognizeFigureText } = await import('./figureIntelligence')
        ocr = cleanFigureText((await recognizeFigureText(bytes, ext, signal)) ?? '', 4000)
        this.signal?.throwIfAborted()
        this.ocrMs += performance.now() - started
      }
      asset = { ext, bytes, ...(ocr ? { ocr } : {}) }
      this.assets.set(id, asset)
      this.bytes += bytes.length
    }
    const figure = { ...placement, ...asset, id }
    this.figures.push(figure)
    return figure
  }
}
