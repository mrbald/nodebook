import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pdfToMarkdown, convertDocument } from './convert'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

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
