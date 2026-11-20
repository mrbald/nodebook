import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCanvas } from '@napi-rs/canvas'
import { strToU8, zipSync } from 'fflate'
import type { PDFPageProxy } from 'pdfjs-dist'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { figurePath } from '../../shared/figures'
import { FigureCapture } from './captureFigures'
import { convertDocumentWithCoverage } from './convert'
import { figureImageDimensions } from './figureImage'
import { recognizeFigureText } from './figureIntelligence'
import { PdfFigureCapture } from './pdfFigures'

vi.mock('./figureIntelligence', () => ({
  recognizeFigureText: vi.fn(async () => 'Workshop attendance Q1 Q2 Q3 Q4')
}))

function image(): Buffer {
  const canvas = createCanvas(124, 78)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f4f4f4'
  ctx.fillRect(0, 0, 124, 78)
  ctx.fillStyle = '#335599'
  ctx.fillRect(15, 30, 22, 38)
  ctx.fillRect(45, 14, 22, 54)
  ctx.fillRect(75, 43, 22, 25)
  return canvas.toBuffer('image/png')
}

const png = image()
const sha = createHash('sha256').update(png).digest('hex')

function wordWithImage(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="pic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:body><w:p><w:r><w:t>Workshop attendance.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart" descr="Word chart alternative"/>' +
      '<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="pic"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>Figure 2. The original Word caption.</w:t></w:r></w:p></w:body></w:document>'
    ),
    'word/media/chart.png': png
  })
}

const directories: string[] = []
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nodebook-figures-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.mocked(recognizeFigureText).mockClear()
})

describe('embedded figures', () => {
  it('captures the raster-only second page of the actual attendance PDF without changing text coverage', async () => {
    const file = join(__dirname, '../../../e2e/fixtures/distill/attendance-chart.pdf')
    const doc = await convertDocumentWithCoverage(file)
    expect(doc.pdf).toEqual({ pages: 2, missing: [2] })
    expect(doc.figures).toHaveLength(1)
    const figure = doc.figures![0]
    expect(figure).toMatchObject({ ext: 'png', location: 'Page 2' })
    expect(figure.id).toBe(createHash('sha256').update(figure.bytes).digest('hex'))
    expect(figureImageDimensions(figure.bytes)).toEqual(['png', expect.any(Number), expect.any(Number)])
    expect(doc.text).toContain(`## Page 2\n\n![Figure 1 on page 2](${figurePath(figure)})`)
    expect(doc.text).toContain('Figure OCR text (Figure 1 on page 2, Page 2): Workshop attendance Q1 Q2 Q3 Q4')
    expect(doc.figureCoverage).toBeUndefined()
  })

  it('crops a vector chart from a text-bearing page and associates its original caption', async () => {
    const stream = [
      'BT /F1 14 Tf 42 308 Td (Opening text outside the graphic.) Tj ET',
      '.2 .4 .7 rg 72 99 35 85 re f',
      '.2 .5 .5 rg 123 99 35 120 re f',
      '.7 .3 .3 rg 174 99 35 61 re f',
      '0 0 0 RG 2 w 61 99 m 224 99 l S',
      'BT /F1 12 Tf 68 65 Td (Figure 1. The original vector chart caption.) Tj ET'
    ].join('\n')
    const pdf = `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 340]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>
endobj
4 0 obj
<</Length ${stream.length}>>
stream
${stream}
endstream
endobj
5 0 obj
<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>
endobj
trailer
<</Root 1 0 R/Size 6>>
%%EOF
`
    const doc = await convertDocumentWithCoverage('chart.pdf', undefined, () => strToU8(pdf))
    expect(doc.pdf).toEqual({ pages: 1, missing: [] })
    expect(doc.figures).toHaveLength(1)
    const figure = doc.figures![0]
    expect(figure).toMatchObject({
      label: 'Figure 1. The original vector chart caption.',
      caption: 'Figure 1. The original vector chart caption.',
      location: 'Page 1'
    })
    const [, width, height] = figureImageDimensions(figure.bytes)!
    expect(width).toBeLessThan(420 * 2)
    expect(height).toBeLessThan(340 * 2)
    expect(doc.text).toContain('Opening text outside the graphic.')
    expect(doc.text).toContain(figurePath(figure))
  })

  it('preserves EPUB archive bytes, chapter provenance, and the caption of an image-only section', async () => {
    const data = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfile full-path="Book/content.opf"/></container>'),
      'Book/content.opf': strToU8(
        '<package><manifest><item id="chapter" href="text/chapter.xhtml"/></manifest>' +
        '<spine><itemref idref="chapter"/></spine></package>'
      ),
      'Book/text/chapter.xhtml': strToU8(
        '<html><body><h1>Workshop data</h1><figure><img src="../figures/chart%20a.png#graph" alt="Four quarters"/>' +
        '<figcaption>Source: workshop records.</figcaption></figure>' +
        '<div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 124 78">' +
        '<image xlink:href="../figures/chart%20a.png" width="124" height="78"/></svg></div></body></html>'
      ),
      'Book/figures/chart a.png': png
    })
    const doc = await convertDocumentWithCoverage('book.epub', undefined, () => data)
    const [figure, svgFigure] = doc.figures!
    expect(figure).toMatchObject({
      id: sha, ext: 'png', label: 'Four quarters', location: 'Section 1 › Workshop data',
      caption: 'Source: workshop records.'
    })
    expect(Buffer.from(figure.bytes)).toEqual(png)
    expect(svgFigure.id).toBe(sha)
    expect(doc.text).toContain(figurePath(svgFigure))
    expect(doc.text).toContain(`![Four quarters](figures/${sha}.png)\n\nSource: workshop records.`)
  })

  it('preserves DOCX asset bytes, alternative text, and nearby Word caption text', async () => {
    const doc = await convertDocumentWithCoverage('report.docx', undefined, wordWithImage)
    const [figure] = doc.figures!
    expect(figure).toMatchObject({
      id: sha, ext: 'png', label: 'Word chart alternative', location: 'Document',
      caption: 'Figure 2. The original Word caption.'
    })
    expect(figure.bytes).toEqual(png)
    expect(doc.text).toContain(`![Word chart alternative](figures/${sha}.png)`)
    expect(doc.text).not.toMatch(/data:image|word-figure-/)
  })

  it('keeps data and adjacent HTML figures portable and rejects URL, traversal, and escaping symlink sources', async () => {
    const directory = tempDirectory()
    const outside = join(tempDirectory(), 'secret.png')
    writeFileSync(outside, png)
    writeFileSync(join(directory, 'chart graphic.png'), png)
    symlinkSync(outside, join(directory, 'symlink.png'))
    const file = join(directory, 'workshop.html')
    const encoded = png.toString('base64')
    const html = [
      '<h1>Workshop record</h1>',
      '<h2>First location</h2><img src="./chart%20graphic.png?size=2" alt="First chart">',
      `<h2>Second location</h2><a href="data:image/png;base64,${encoded}"><img src="data:image/png;base64,${encoded}" alt="Same chart"></a>`,
      '<img src="https://example.test/remote.png" alt="External reference">',
      '<img src="%2e%2e/secret.png" alt="Outside folder">',
      '<img src="symlink.png" alt="Outside symlink">',
      '<img src="chart%20graphic.png" width="5" height="5" alt="Decoration">'
    ].join('\n')
    writeFileSync(file, html)
    const doc = await convertDocumentWithCoverage(file)
    expect(doc.figures?.map(({ id, label, location }) => [id, label, location])).toEqual([
      [sha, 'First chart', 'Workshop record › First location'],
      [sha, 'Same chart', 'Workshop record › Second location']
    ])
    expect(doc.figures?.[0].bytes).toEqual(doc.figures?.[1].bytes)
    expect(doc.externalImages).toBe(true)
    expect(doc.figureCoverage).toEqual({ skipped: 3 })
    expect(recognizeFigureText).toHaveBeenCalledTimes(1)
    expect(doc.text).toContain(`![Same chart](figures/${sha}.png)`)
    expect(doc.text).toContain('External reference')
    expect(doc.text).not.toMatch(/data:image|https:\/\/example|secret\.png|symlink\.png|Decoration/)
    expect(readFileSync(file, 'utf8')).toBe(html)
  })

  it('stops before reading a source when conversion is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const read = vi.fn(() => png)
    await expect(convertDocumentWithCoverage('report.pdf', undefined, read, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('skips a truncated PNG even when its dimensions are readable', async () => {
    const truncated = png.subarray(0, png.length - 12)
    expect(figureImageDimensions(truncated)).toEqual(['png', 124, 78])
    const html = `<p>Published report.</p><img alt="Incomplete scan" src="data:image/png;base64,${truncated.toString('base64')}">`
    const doc = await convertDocumentWithCoverage('report.html', undefined, () => strToU8(html))
    expect(doc.text).toContain('Published report.')
    expect(doc.text).not.toMatch(/figures\/|data:image/)
    expect(doc.figures).toBeUndefined()
    expect(doc.figureCoverage).toEqual({ skipped: 1 })
    expect(recognizeFigureText).not.toHaveBeenCalled()
  })

  it('stops compiling PDF operator lists at the inspection budget and reports unknown visual coverage', async () => {
    const figureCapture = new FigureCapture()
    const pdf = new PdfFigureCapture(await import('pdfjs-dist/legacy/build/pdf.mjs'), figureCapture)
    const getOperatorList = vi.fn(async () => ({ fnArray: [], argsArray: [] }))
    const page = { getOperatorList } as unknown as PDFPageProxy
    for (let p = 0; p < 601; p++) expect(await pdf.page(page, [])).toEqual([])
    expect(getOperatorList).toHaveBeenCalledTimes(600)
    expect(figureCapture.coverage).toEqual({ skipped: 0, uninspectedPages: 1 })
  })
})
