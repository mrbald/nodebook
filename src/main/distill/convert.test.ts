import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { zipSync, strToU8 } from 'fflate'
import {
  pdfToMarkdown,
  proseText,
  codeText,
  type TextItem,
  epubToMarkdown,
  epubNavTitles,
  htmlToMarkdown,
  docxToMarkdown,
  convertDocument
} from './convert'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A minimal valid EPUB: two chapters, in-memory. `withNav` adds an EPUB 2
 *  `toc.ncx` naming the first `namedChapters` of them. */
function makeEpub({ withNav = false, namedChapters = 2 } = {}): Uint8Array {
  const container =
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const navItem = withNav
    ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    : ''
  const opf =
    '<?xml version="1.0"?><package><manifest>' +
    navItem +
    '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  const points = [
    '<navPoint><navLabel><text>Of Faction</text></navLabel><content src="chap1.xhtml"/></navPoint>',
    '<navPoint><navLabel><text>Of the Republic</text></navLabel><content src="chap2.xhtml"/></navPoint>'
  ].slice(0, namedChapters)
  const chap1 = '<html><body><h1>Faction</h1><p>Faction arises from the unequal distribution of property.</p></body></html>'
  const chap2 = '<html><body><h1>Republic</h1><p>A republic refines public views through representatives.</p></body></html>'
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'content.opf': strToU8(opf),
    ...(withNav ? { 'toc.ncx': strToU8(`<ncx><navMap>${points.join('')}</navMap></ncx>`) } : {}),
    'chap1.xhtml': strToU8(chap1),
    'chap2.xhtml': strToU8(chap2)
  })
}

/** The real multi-page PDF fixture the eval and the golden test share. */
const PAPER_PDF = join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'distill', 'paper.pdf')

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

  // The golden case: a real 21-page PDF laid out by scripts/make-paper-pdf.mjs
  // with exactly the defects a PDF text layer has — a running header on every
  // page, a page-number footer, words hyphenated across the line break, and one
  // hard newline per printed line. See cleanPdf.ts.
  it('cleans a real multi-page PDF: no furniture, whole words, real paragraphs', async () => {
    const md = await pdfToMarkdown(new Uint8Array(readFileSync(PAPER_PDF)))

    // Page provenance survives, for every page.
    expect(md).toContain('## Page 1')
    expect(md).toContain('## Page 21')

    // The running header and the `- N -` footer are gone.
    expect(md).not.toContain('RELATIVITY: THE SPECIAL AND GENERAL THEORY')
    expect(md).not.toMatch(/^- \d+ -$/m)

    // No word is left cut in half, and the halves are back together.
    expect(md).not.toMatch(/\w-\n\w/)
    for (const word of ['railway', 'revolution', 'considerations', 'intellectual'])
      expect(md).toContain(word)

    // Prose reads as paragraphs, not as one line per printed line: every page
    // is a handful of blocks, and each block is far longer than a printed line.
    const pages = md.split(/^## Page \d+$/m).filter((p) => p.trim())
    expect(pages).toHaveLength(21)
    for (const page of pages) {
      const paragraphs = page.trim().split('\n\n')
      expect(paragraphs.length).toBeLessThanOrEqual(12)
      expect(Math.max(...paragraphs.map((p) => p.length))).toBeGreaterThan(400)
      // A paragraph is one line: the printed line breaks are gone.
      for (const paragraph of paragraphs) expect(paragraph).not.toContain('\n')
    }
  })
})

// --- Fonts and geometry: code listings, word gaps, duplicate items ------------

type Op = { font: 'F1' | 'F2'; size: number; x: number; y: number; text: string }

/** A raw multi-page PDF with two standard fonts — F1 Helvetica (prose), F2
 *  Courier (fixed pitch) — one text-showing operation per `Op`, so pdf.js sees
 *  exactly the items, fonts and positions the test lays out. WinAnsi, so a
 *  `\x95` byte is the bullet. */
function rawPdf(pages: Op[][]): Uint8Array {
  const esc = (t: string): string => t.replace(/[\\()]/g, (c) => `\\${c}`)
  let out = '%PDF-1.4\n'
  const obj = (num: number, body: string): void => {
    out += `${num} 0 obj\n${body}\nendobj\n`
  }
  obj(1, '<</Type/Catalog/Pages 2 0 R>>')
  obj(2, `<</Type/Pages/Kids[${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}]/Count ${pages.length}>>`)
  obj(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>')
  obj(4, '<</Type/Font/Subtype/Type1/BaseFont/Courier/Encoding/WinAnsiEncoding>>')
  pages.forEach((ops, i) => {
    const stream = ops
      .map((o) => `BT /${o.font} ${o.size} Tf ${o.x} ${o.y} Td (${esc(o.text)}) Tj ET`)
      .join('\n')
    obj(
      5 + 2 * i,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${6 + 2 * i} 0 R/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>>>`
    )
    obj(6 + 2 * i, `<</Length ${Buffer.byteLength(stream, 'latin1')}>>\nstream\n${stream}\nendstream`)
  })
  out += `trailer\n<</Root 1 0 R/Size ${5 + 2 * pages.length}>>\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

const prose = (y: number, text: string, x = 72): Op => ({ font: 'F1', size: 10, x, y, text })
const code = (y: number, text: string, x = 89): Op => ({ font: 'F2', size: 9, x, y, text })

describe('pdfToMarkdown — code listings and geometry', () => {
  it('keeps lines set in a fixed-pitch font as an indented code block, layout and all', async () => {
    const md = await pdfToMarkdown(
      rawPdf([
        [
          prose(700, 'Arrays have the transpose method:'),
          code(680, 'In [1]: arr = np.zeros((8, 4))'),
          code(668, 'Out[1]:'),
          code(656, 'array([[0., 0.],'),
          code(644, '[1., 1.]])', 89 + 5 * 5.4), // five characters in: Courier is 0.6 em wide
          code(632, '# a comment, not a heading'),
          prose(610, 'Then prose again.')
        ]
      ])
    )
    expect(md).toContain('Arrays have the transpose method:')
    expect(md).toContain('    In [1]: arr = np.zeros((8, 4))\n    Out[1]:\n    array([[0., 0.],\n         [1., 1.]])')
    expect(md).toContain('    # a comment, not a heading')
    expect(md).not.toMatch(/^# a comment/m)
    expect(md).toContain('Then prose again.')
    // The listing sits in a block of its own, not inside the prose paragraph.
    expect(md).toMatch(/method:\n\n {4}In \[1\]/)
  })

  it('reads a document set entirely in a fixed-pitch font as prose', async () => {
    const md = await pdfToMarkdown(
      rawPdf([[code(700, 'A report typed in Courier, every line of it, wraps'), code(688, 'like any other prose would.')]])
    )
    expect(md).not.toMatch(/^ {4}/m)
    expect(md).toContain('A report typed in Courier, every line of it, wraps like any other prose would.')
  })
})

describe('proseText / codeText', () => {
  const item = (str: string, x: number, width: number, extra: Partial<TextItem> = {}): TextItem => ({
    str,
    hasEOL: false,
    fontName: 'g_d0_f1',
    transform: [10, 0, 0, 10, x, 500],
    width,
    height: 10,
    ...extra
  })

  it('puts one space at a word gap and none inside a word split by a font change', () => {
    // pdf.js splits `Fancy indexing` at the italic and inserts its own space
    // item; joining every item with a space on top of that doubled the gap.
    expect(proseText([item('Fancy', 72, 27.2), item(' ', 99.2, 2.5, { width: 2.5 }), item('indexing', 101.7, 40)])).toBe(
      'Fancy indexing'
    )
    expect(proseText([item('Fancy', 72, 27.2), item('indexing', 102.2, 40)])).toBe('Fancy indexing')
    expect(proseText([item('un', 72, 11.1), item('happy', 83.1, 30)])).toBe('unhappy')
  })

  it('drops the duplicate item pdf.js emits for a list bullet', () => {
    // The bullet arrives inside the line's string AND as an item of its own at
    // the very same position, carrying the line break.
    expect(
      proseText([item('• ndarray, an efficient array', 80.7, 200), item('•', 80.7, 4.1, { hasEOL: true })])
    ).toBe('• ndarray, an efficient array')
    // The line may have been split into several items before the duplicate.
    expect(
      proseText([item('• (ax.xlim([0, 10])', 80.7, 90), item('sets the', 173, 40), item('•', 80.7, 4.1, { hasEOL: true })])
    ).toBe('• (ax.xlim([0, 10]) sets the')
  })

  it('re-lays a code line on a character grid from the item positions', () => {
    expect(codeText([item('In [1]:', 89, 38.3), item(' ', 127.3, 4.3), item('for', 131.5, 12.8), item('i', 148.5, 4.3)], 89, 4.25)).toBe(
      'In [1]:   for i'
    )
    expect(codeText([item('.....:', 101.7, 25.5), item('arr[i] = i', 148.5, 42.5)], 89, 4.25)).toBe(
      '   .....:     arr[i] = i'
    )
  })
})

/** An EPUB laid out the way real books often are: the package in `OEBPS/`, the
 *  chapters in `OEBPS/text/`, and an EPUB 3 nav document of its own in
 *  `OEBPS/nav/` whose hrefs point back out with `../`. */
function makeEpubNested(): Uint8Array {
  const container =
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const opf =
    '<?xml version="1.0"?><package><manifest>' +
    '<item id="nav" href="nav/toc.xhtml" properties="nav" media-type="application/xhtml+xml"/>' +
    '<item id="c1" href="text/chap1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c2" href="text/chap2.xhtml" media-type="application/xhtml+xml"/>' +
    '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  const nav =
    '<html><body><nav epub:type="toc"><ol>' +
    '<li><a href="../text/chap1.xhtml">Of Faction</a></li>' +
    '<li><a href="../text/chap2.xhtml">Of the Republic</a></li>' +
    '</ol></nav></body></html>'
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav/toc.xhtml': strToU8(nav),
    'OEBPS/text/chap1.xhtml': strToU8(
      '<html><body><h1>Faction</h1><p>Faction arises from the unequal distribution of property.</p></body></html>'
    ),
    'OEBPS/text/chap2.xhtml': strToU8(
      '<html><body><h1>Republic</h1><p>A republic refines public views through representatives.</p></body></html>'
    )
  })
}

describe('epubNavTitles', () => {
  it('reads an EPUB 2 toc.ncx, dropping the fragment', () => {
    const ncx = `<ncx><navMap>
      <navPoint id="n1"><navLabel><text>Chapter One: Faction</text></navLabel><content src="chap1.xhtml"/></navPoint>
      <navPoint id="n2"><navLabel><text>Chapter Two &amp; Last</text></navLabel><content src="chap2.xhtml#top"/></navPoint>
    </navMap></ncx>`
    expect([...epubNavTitles(ncx, '')]).toEqual([
      ['chap1.xhtml', 'Chapter One: Faction'],
      ['chap2.xhtml', 'Chapter Two & Last']
    ])
  })

  it('reads an EPUB 3 nav.xhtml toc, and ignores other navs', () => {
    const nav = `<html><body>
      <nav epub:type="landmarks"><ol><li><a href="chap1.xhtml">Start Reading</a></li></ol></nav>
      <nav epub:type="toc"><ol><li><a href="chap1.xhtml"><span>The Republic</span></a></li></ol></nav>
    </body></html>`
    expect(epubNavTitles('', nav).get('chap1.xhtml')).toBe('The Republic')
  })

  it('is empty when there is no table of contents', () => {
    expect(epubNavTitles('', '<html><body><p>no nav</p></body></html>').size).toBe(0)
  })

  it('resolves hrefs against the TOC document, not the package', () => {
    // A nav document in its own folder points UP and across — its hrefs are
    // relative to itself. Resolved against the OPF instead, they name files
    // that do not exist and the book gets "Section 1" for every chapter.
    const nav = `<html><body><nav epub:type="toc"><ol>
      <li><a href="../text/chap1.xhtml">The Republic</a></li>
      <li><a href="./chap-nav.xhtml">A page beside the nav</a></li>
    </ol></nav></body></html>`
    const titles = epubNavTitles('', nav, { navPath: 'OEBPS/nav/toc.xhtml' })
    expect(titles.get('OEBPS/text/chap1.xhtml')).toBe('The Republic')
    expect(titles.get('OEBPS/nav/chap-nav.xhtml')).toBe('A page beside the nav')
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

  it('names each section from the table of contents when the book has one', async () => {
    const md = await epubToMarkdown(makeEpub({ withNav: true }))
    expect(md).toContain('## Of Faction')
    expect(md).toContain('## Of the Republic')
    expect(md).not.toContain('## Section 1')
  })

  it('names them when the nav sits in a subfolder and points back out', async () => {
    const md = await epubToMarkdown(makeEpubNested())
    expect(md).toContain('## Of Faction')
    expect(md).toContain('## Of the Republic')
    expect(md).not.toContain('## Section 1')
  })

  it('falls back to Section N for a chapter the contents does not name', async () => {
    const md = await epubToMarkdown(makeEpub({ withNav: true, namedChapters: 1 }))
    expect(md).toContain('## Of Faction')
    expect(md).toContain('## Section 2')
  })

  it('throws on a non-EPUB zip', async () => {
    const notEpub = zipSync({ 'hello.txt': strToU8('hi') })
    await expect(epubToMarkdown(notEpub)).rejects.toThrow(/EPUB/i)
  })
})

/** A minimal valid DOCX: OPC container with one heading + one paragraph. */
function makeDocx(): Uint8Array {
  const contentTypes =
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  const doc =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Faction arises from property.</w:t></w:r></w:p><w:p><w:r><w:t>Representatives refine public views.</w:t></w:r></w:p></w:body></w:document>'
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(doc)
  })
}

describe('htmlToMarkdown', () => {
  it('converts body content and keeps real headings (provenance for the chunker)', async () => {
    const html =
      '<html><head><title>ignored</title><style>p{color:red}</style></head>' +
      '<body><h1>Faction</h1><p>Property divides people.</p><script>alert(1)</script></body></html>'
    const md = await htmlToMarkdown(html)
    expect(md).toContain('# Faction')
    expect(md).toContain('Property divides people.')
    expect(md).not.toContain('alert(1)') // scripts dropped
    expect(md).not.toContain('color:red') // styles dropped
  })

  it('throws on an HTML file with no text', async () => {
    await expect(htmlToMarkdown('<html><body><script>x()</script></body></html>')).rejects.toThrow(
      /No extractable text/i
    )
  })
})

describe('docxToMarkdown', () => {
  it('extracts paragraphs from a Word document', async () => {
    const md = await docxToMarkdown(makeDocx())
    expect(md).toContain('Faction arises from property.')
    expect(md).toContain('Representatives refine public views.')
  })
})

describe('convertDocument', () => {
  it('reads markdown / text files as-is', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'convert-'))
    const f = join(tmp, 'note.md')
    writeFileSync(f, '# Hi\n\nsome text')
    expect(await convertDocument(f)).toBe('# Hi\n\nsome text')
  })

  it('routes .html and .docx to their converters', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'convert-'))
    const h = join(tmp, 'page.html')
    writeFileSync(h, '<body><p>hello html</p></body>')
    expect(await convertDocument(h)).toContain('hello html')
    const d = join(tmp, 'doc.docx')
    writeFileSync(d, makeDocx())
    expect(await convertDocument(d)).toContain('Faction arises from property.')
  })

  it('explains that legacy .doc needs saving as .docx', async () => {
    await expect(convertDocument('/x/file.doc')).rejects.toThrow(/save.*\.docx|\.docx first/i)
  })

  it('rejects unsupported document types', async () => {
    await expect(convertDocument('/x/file.xlsx')).rejects.toThrow(/Unsupported/)
  })
})
