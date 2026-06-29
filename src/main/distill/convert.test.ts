import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { zipSync, strToU8 } from 'fflate'
import { pdfToMarkdown, epubToMarkdown, convertDocument } from './convert'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A minimal valid EPUB: one chapter, in-memory. */
function makeEpub(): Uint8Array {
  const container =
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const opf =
    '<?xml version="1.0"?><package><manifest><item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  const chap1 = '<html><body><h1>Faction</h1><p>Faction arises from the unequal distribution of property.</p></body></html>'
  const chap2 = '<html><body><h1>Republic</h1><p>A republic refines public views through representatives.</p></body></html>'
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'content.opf': strToU8(opf),
    'chap1.xhtml': strToU8(chap1),
    'chap2.xhtml': strToU8(chap2)
  })
}

// A minimal, text-bearing PDF: one page that shows "Hello Faction world".
const PDF = `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>
endobj
4 0 obj
<</Length 52>>
stream
BT /F1 18 Tf 20 100 Td (Hello Faction world) Tj ET
endstream
endobj
5 0 obj
<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>
endobj
trailer
<</Root 1 0 R/Size 6>>
%%EOF
`

// The same structure with an empty content stream → no extractable text (a stand-in
// for a scanned page).
const PDF_NO_TEXT = PDF.replace('<</Length 52>>\nstream\nBT /F1 18 Tf 20 100 Td (Hello Faction world) Tj ET\nendstream', '<</Length 0>>\nstream\n\nendstream')

let tmp = ''
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

describe('pdfToMarkdown', () => {
  it('extracts text with a per-page heading (page = provenance)', async () => {
    const md = await pdfToMarkdown(enc(PDF))
    expect(md).toContain('## Page 1')
    expect(md).toContain('Hello Faction world')
  })

  it('throws a friendly error for a scanned PDF (no text layer)', async () => {
    await expect(pdfToMarkdown(enc(PDF_NO_TEXT))).rejects.toThrow(/scanned|OCR/i)
  })
})

describe('epubToMarkdown', () => {
  it('reads chapters in spine order and converts them to markdown', async () => {
    const md = await epubToMarkdown(makeEpub())
    expect(md).toContain('Faction arises from the unequal distribution of property.')
    expect(md).toContain('A republic refines public views through representatives.')
    // Spine order (c1 then c2) wins over manifest order (c2 first).
    expect(md.indexOf('Faction')).toBeLessThan(md.indexOf('Republic'))
    expect(md).toContain('## Section 1')
  })

  it('throws on a non-EPUB zip', async () => {
    const notEpub = zipSync({ 'hello.txt': strToU8('hi') })
    await expect(epubToMarkdown(notEpub)).rejects.toThrow(/EPUB/i)
  })
})

describe('convertDocument', () => {
  it('reads markdown / text files as-is', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'convert-'))
    const f = join(tmp, 'note.md')
    writeFileSync(f, '# Hi\n\nsome text')
    expect(await convertDocument(f)).toBe('# Hi\n\nsome text')
  })

  it('rejects unsupported document types', async () => {
    await expect(convertDocument('/x/file.docx')).rejects.toThrow(/Unsupported/)
  })
})
