/** Include text that actually changes with the encoding, even after an ASCII preamble. */
export function encodingSample(content: string, limit = 1200): string {
  const text = content.trimStart()
  const chunk = (start: number, size: number): string =>
    text.slice(start, start + size).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
  const firstLetter = text.search(/(?=\P{ASCII})\p{L}/u)
  const first = firstLetter < 0 ? text.search(/\P{ASCII}/u) : firstLetter
  if (first < limit - 60) return chunk(0, limit)
  const head = Math.floor(limit / 4)
  return chunk(0, head).trimEnd() + '\n…\n' + chunk(Math.max(head, first - 55), limit - head - 3)
}
