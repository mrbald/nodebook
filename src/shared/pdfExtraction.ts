/** PDF pages with no usable text after extraction and page cleanup, numbered from one. */
export interface PdfExtraction {
  pages: number
  missing: number[]
}

export function readPdfExtraction(value: unknown): PdfExtraction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { pages, missing } = value as Partial<PdfExtraction>
  if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 1) return undefined
  if (!Array.isArray(missing) || !missing.every((n, i) =>
    Number.isInteger(n) && n >= 1 && n <= pages && (i === 0 || n > missing[i - 1])
  )) return undefined
  return { pages, missing }
}

export function describePdfExtraction({ pages, missing }: PdfExtraction): string {
  const count = pages - missing.length
  const summary = `Extracted text from ${count} of ${pages} PDF pages.`
  if (!missing.length) return summary
  const ranges: string[] = []
  for (let i = 0; i < missing.length; i++) {
    const first = missing[i]
    while (i + 1 < missing.length && missing[i + 1] === missing[i] + 1) i++
    ranges.push(first === missing[i] ? String(first) : `${first}–${missing[i]}`)
  }
  return `${summary} No usable text on ${missing.length === 1 ? 'page' : 'pages'} ${ranges.join(', ')}.`
}
