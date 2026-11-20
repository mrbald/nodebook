import type { Canvas } from '@napi-rs/canvas'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { CapturedFigure } from '../../shared/figures'
import { cleanFigureText, FigureCapture } from './captureFigures'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type Box = [number, number, number, number]
type Graphic = { index: number; raster: boolean; weight: number }
type Region = { box: Box; raster: boolean; weight: number }
export type PageCaption = { text: string; x: number; y: number }
type FigureTag = { alt: string; box?: Box }

const MAX_RENDERED_PAGES = 160
const MAX_INSPECTED_PAGES = 600
const MAX_INSPECTED_OPERATIONS = 2_000_000
const MAX_PAGE_PIXELS = 3_200_000
const MAX_PAGE_SIDE = 2400
const MAX_PAGE_OPERATIONS = 100_000
const MAX_GRAPHICS_PER_PAGE = 6000
const MAX_REGIONS_PER_PAGE = 512

interface RecordedBounds {
  isEmpty(index: number): boolean
  minX(index: number): number
  minY(index: number): number
  maxX(index: number): number
  maxY(index: number): number
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function near(a: Box, b: Box, gap: number): boolean {
  return a[0] <= b[2] + gap && a[2] + gap >= b[0] && a[1] <= b[3] + gap && a[3] + gap >= b[1]
}

function collectRegions(
  graphics: Graphic[],
  bounds: RecordedBounds,
  width: number,
  height: number,
  scale: number
): Region[] | undefined {
  const regions: Region[] = []
  for (const { index, raster, weight } of graphics) {
    if (bounds.isEmpty(index)) continue
    const left = bounds.minX(index) * width
    const top = bounds.minY(index) * height
    const right = bounds.maxX(index) * width
    const bottom = bounds.maxY(index) * height
    const w = right - left
    const h = bottom - top
    if (raster && (w < 32 * scale || h < 24 * scale)) continue
    if (!raster && w >= width * 0.96 && h >= height * 0.96) continue
    const merged: Region = { box: [left, top, right, bottom], raster, weight }
    // Paths for chart strokes and shapes arrive separately. Merge neighboring
    // paths and image overlays, keeping figures further apart distinct.
    for (let i = 0; i < regions.length;) {
      const existing = regions[i]
      if (!near(existing.box, merged.box, 22 * scale)) {
        i++
        continue
      }
      merged.box = union(merged.box, existing.box)
      merged.raster ||= existing.raster
      merged.weight += existing.weight
      regions.splice(i, 1)
      i = 0
    }
    regions.push(merged)
    if (regions.length > MAX_REGIONS_PER_PAGE) return undefined
  }
  return regions.filter(({ box: [x1, y1, x2, y2], raster, weight }) => {
    const w = (x2 - x1) / scale
    const h = (y2 - y1) / scale
    return (raster || weight >= 3) && w >= 45 && h >= 34 && w * h >= 2200
  }).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
}

/** Reject blank, flat-color, and near-empty renderings, including many watermarks. */
function hasContent(canvas: Canvas): boolean {
  const { width, height } = canvas
  // Sampling every few rows keeps transient RGBA buffers small even on large pages.
  const stepX = Math.max(1, Math.round(width / 96))
  const stepY = Math.max(1, Math.round(height / 96))
  const context = canvas.getContext('2d')
  let low = 255
  let high = 0
  let nonwhite = 0
  let samples = 0
  for (let y = 0; y < height; y += stepY) {
    const row = context.getImageData(0, y, width, 1).data
    for (let x = 0; x < width; x += stepX) {
      const light = Math.round((row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2]) / 3)
      low = Math.min(low, light)
      high = Math.max(high, light)
      if (light < 237) nonwhite++
      samples++
    }
  }
  return nonwhite >= samples * 0.004 && high - low > 20
}

/** The PDF text layer's caption, when close to the preserved graphic. */
function nearbyCaption(
  box: Box,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  scale: number,
  captions: PageCaption[]
): string | undefined {
  let nearest = 58 * scale
  let caption: string | undefined
  for (const item of captions) {
    const [x, y] = viewport.convertToViewportPoint(item.x, item.y)
    if (x < box[0] - 50 * scale || x >= box[2] || y < box[1] - 46 * scale || y > box[3] + 50 * scale) continue
    const distance = Math.min(Math.abs(y - box[1]), Math.abs(y - box[3]))
    if (distance >= nearest) continue
    nearest = distance
    caption = item.text
  }
  return caption
}

/** PDF.js exposes alternative text and optional page-space figure geometry
 * from the accessible structure tree, though older typings omit these fields. */
async function taggedFigures(page: PDFPageProxy): Promise<FigureTag[]> {
  interface Node {
    role?: string
    alt?: string
    bbox?: number[]
    children?: Node[]
  }
  const tags: FigureTag[] = []
  const walk = (node: Node): void => {
    if ((node.role === 'Figure' || node.role === 'Formula') && typeof node.alt === 'string') {
      const alt = cleanFigureText(node.alt)
      const bbox = node.bbox
      if (alt) tags.push({ alt, ...(bbox?.length === 4 && bbox.every(Number.isFinite) ? { box: bbox as Box } : {}) })
    }
    node.children?.forEach(walk)
  }
  const tree = await page.getStructTree().catch(() => null)
  if (tree) walk(tree as Node)
  return tags
}

function matchAlt(
  box: Box,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  tags: FigureTag[],
  regionCount: number
): string | undefined {
  let best = 0
  let alt: string | undefined
  for (const tag of tags) {
    if (!tag.box) continue
    const [left, top, right, bottom] = tag.box
    const [x1, y1] = viewport.convertToViewportPoint(left, top)
    const [x2, y2] = viewport.convertToViewportPoint(right, bottom)
    const overlap = Math.max(0, Math.min(Math.max(x1, x2), box[2]) - Math.max(Math.min(x1, x2), box[0])) *
      Math.max(0, Math.min(Math.max(y1, y2), box[3]) - Math.max(Math.min(y1, y2), box[1]))
    if (overlap <= best) continue
    best = overlap
    alt = tag.alt
  }
  return alt ?? (tags.length === 1 && regionCount === 1 ? tags[0].alt : undefined)
}

function imageOps(ops: PdfJs['OPS']): Set<number> {
  return new Set([
    ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageXObjectRepeat,
    ops.paintInlineImageXObjectGroup, ops.paintImageMaskXObject, ops.paintImageMaskXObjectGroup,
    ops.paintImageMaskXObjectRepeat
  ])
}

/** Render candidate pages locally with PDF.js, then crop the actual graphic
 * bounds. The page rendering preserves vector shapes, chart labels and image
 * blends in the same visual coordinate space. */
export class PdfFigureCapture {
  private renderedPages = 0
  private inspectedPages = 0
  private inspectedOperations = 0

  constructor(private readonly pdfjs: PdfJs, private readonly capture: FigureCapture) {}

  async page(page: PDFPageProxy, captions: PageCaption[]): Promise<CapturedFigure[]> {
    const { capture, pdfjs: { OPS, AnnotationMode } } = this
    const figures: CapturedFigure[] = []
    capture.signal?.throwIfAborted()
    if (capture.full || this.renderedPages >= MAX_RENDERED_PAGES ||
        this.inspectedPages >= MAX_INSPECTED_PAGES || this.inspectedOperations >= MAX_INSPECTED_OPERATIONS) {
      capture.skipPage()
      return figures
    }
    try {
      const annotationMode = AnnotationMode.DISABLE
      this.inspectedPages++
      const list = await page.getOperatorList({ annotationMode })
      capture.signal?.throwIfAborted()
      this.inspectedOperations += list.fnArray.length
      if (list.fnArray.length > MAX_PAGE_OPERATIONS) {
        capture.skipPage()
        return figures
      }
      const rasterOps = imageOps(OPS)
      const graphics: Graphic[] = []
      for (let i = 0; i < list.fnArray.length; i++) {
        const op = list.fnArray[i]
        if (rasterOps.has(op)) graphics.push({ index: i, raster: true, weight: 0 })
        if (op === OPS.constructPath && list.argsArray[i]?.[0] !== OPS.endPath && list.argsArray[i]?.[2]) {
          const path = list.argsArray[i][1]?.[0]
          // A single complicated filled shape can itself be a drawing.
          graphics.push({ index: i, raster: false, weight: path?.length >= 25 ? 3 : 1 })
        }
      }
      if (!graphics.length) return []
      if (graphics.length > MAX_GRAPHICS_PER_PAGE) {
        capture.skipPage()
        return figures
      }
      const unit = page.getViewport({ scale: 1 })
      const scale = Math.min(2, MAX_PAGE_SIDE / Math.max(unit.width, unit.height),
        Math.sqrt(MAX_PAGE_PIXELS / (unit.width * unit.height)))
      const viewport = page.getViewport({ scale })
      const width = Math.ceil(viewport.width)
      const height = Math.ceil(viewport.height)
      if (!Number.isFinite(width + height) || width < 16 || height < 16) {
        capture.skipPage()
        return []
      }
      this.renderedPages++
      const { createCanvas } = await import('@napi-rs/canvas')
      capture.signal?.throwIfAborted()
      const canvas = createCanvas(width, height)
      // PDF.js's node canvas factory uses this same prebuilt N-API canvas.
      const task = page.render({
        canvas: canvas as unknown as HTMLCanvasElement, viewport, annotationMode, recordOperations: true
      })
      const cancel = (): void => task.cancel()
      capture.signal?.addEventListener('abort', cancel, { once: true })
      try {
        await task.promise
      } finally {
        capture.signal?.removeEventListener('abort', cancel)
      }
      capture.signal?.throwIfAborted()
      const bounds: RecordedBounds | undefined = page.recordedBBoxes
      // Some PDF constructs do not report crop geometry. Preserve the page
      // image if the renderer still painted it, within the same pixel budget.
      const regions = (bounds && graphics.some(({ index }) => !bounds.isEmpty(index))
        ? collectRegions(graphics, bounds, width, height, scale) : undefined) ??
        [{ box: [0, 0, width, height] as Box, raster: true, weight: 0 }]
      const tags = regions.length ? await taggedFigures(page) : []
      for (const { box } of regions) {
        capture.signal?.throwIfAborted()
        if (capture.full) {
          capture.skip()
          break
        }
        const caption = nearbyCaption(box, viewport, scale, captions)
        const alt = matchAlt(box, viewport, tags, regions.length)
        const pad = Math.ceil(13 * scale)
        const x = Math.max(0, Math.floor(box[0]) - pad)
        const y = Math.max(0, Math.floor(box[1]) - pad)
        const w = Math.min(width, Math.ceil(box[2]) + pad) - x
        const h = Math.min(height, Math.ceil(box[3]) + pad) - y
        const cropped = x === 0 && y === 0 && w === width && h === height ? canvas : createCanvas(w, h)
        if (cropped !== canvas) cropped.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h)
        if (!hasContent(cropped)) continue
        const location = `Page ${page.pageNumber}`
        const bytes = await cropped.encode('png')
        const figure = await capture.add(bytes, {
          label: alt || caption || `Figure ${figures.length + 1} on page ${page.pageNumber}`,
          location,
          ...(caption ? { caption: cleanFigureText(caption) } : {})
        })
        if (figure) figures.push(figure)
      }
      return figures
    } catch {
      capture.signal?.throwIfAborted()
      capture.skipPage()
      return figures
    }
  }
}
