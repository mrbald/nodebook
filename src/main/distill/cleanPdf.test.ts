import { describe, it, expect } from 'vitest'
import { cleanPdf } from './cleanPdf'

/**
 * Filler that brings a line to full measure. A printed line that stops early
 * is exactly the signal `cleanPdf` reads as "end of paragraph", so every line
 * a test does NOT mean as a paragraph break has to be a full one.
 */
const FILL = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'

/** A full-measure line ending in `text` (for a line that ends with a hyphen). */
const endsWith = (text: string): string => `${FILL} ${text}`
/** A full-measure line starting with `text`. */
const startsWith = (text: string): string => `${text} ${FILL}`

const page = (...lines: string[]): string => lines.join('\n')

describe('cleanPdf', () => {
  it('drops a line repeated on most pages, and keeps one that is not', () => {
    const pages = ['alpha', 'beta', 'gamma', 'delta'].map((w) =>
      page('A Running Header', startsWith(w))
    )
    pages[0] += '\nonce only'
    const out = cleanPdf(pages).join('\n')
    expect(out).not.toContain('A Running Header')
    expect(out).toContain('once only')
    expect(out).toContain('alpha')
  })

  it('folds digits before comparing, so a numbered header still repeats', () => {
    const pages = ['alpha', 'beta', 'gamma', 'delta'].map((w, i) =>
      page(`Chapter 7 · page ${i + 1}`, startsWith(w))
    )
    expect(cleanPdf(pages).join('\n')).not.toContain('Chapter 7')
  })

  it('leaves a two-page document alone — 30% of two pages is not evidence', () => {
    const pages = ['alpha', 'beta'].map((w) => page('Shared Line', startsWith(w)))
    expect(cleanPdf(pages).join('\n')).toContain('Shared Line')
  })

  it('drops a bare page number however it is decorated', () => {
    const footers = ['- 1 -', '[2]', 'Page 3', '4.']
    const pages = ['alpha', 'beta', 'gamma', 'delta'].map((w, i) =>
      page(startsWith(w), footers[i])
    )
    const out = cleanPdf(pages).join('\n')
    for (const footer of footers) expect(out).not.toContain(footer)
    expect(out).toContain('alpha')
  })

  it('keeps a number that is part of a sentence', () => {
    const pages = ['alpha', 'beta', 'gamma'].map((w) => startsWith(w))
    pages[0] += `\n${startsWith('there were 12 of them in all')}`
    expect(cleanPdf(pages).join('\n')).toContain('there were 12 of them')
  })

  it('rejoins a word split across a line break when the whole word occurs elsewhere', () => {
    const out = cleanPdf([
      page(endsWith('we crossed the rail-'), startsWith('way that morning'), startsWith('the railway was busy'))
    ])[0]
    expect(out).toContain('the railway that morning')
  })

  it('rejoins two lowercase halves with no other evidence', () => {
    const out = cleanPdf([page(endsWith('a consid-'), startsWith('erable amount'))])[0]
    expect(out).toContain('considerable amount')
  })

  it('keeps the hyphen when the hyphenated form occurs elsewhere', () => {
    const out = cleanPdf([
      page(endsWith('we use co-'), startsWith('ordinates here'), startsWith('the co-ordinates are fixed'))
    ])[0]
    expect(out).toContain('co-ordinates here')
    expect(out).not.toContain('coordinates here')
  })

  it('keeps the hyphen when a half is capitalised and nothing says otherwise', () => {
    const out = cleanPdf([page(endsWith('the Anglo-'), startsWith('Saxon world'))])[0]
    expect(out).toContain('Anglo-Saxon world')
  })

  it('leaves a double dash at a line end alone', () => {
    const out = cleanPdf([page(endsWith('he waited--'), startsWith('perhaps too long'))])[0]
    expect(out).toContain('waited-- perhaps')
  })

  it('joins wrapped lines into a paragraph and breaks at the short one', () => {
    const a = startsWith('alpha')
    const b = startsWith('beta')
    const paras = cleanPdf([page(a, b, 'and then it stopped.', a, b)])[0].split('\n\n')
    expect(paras).toHaveLength(2)
    expect(paras[0]).toBe(`${a} ${b} and then it stopped.`)
    expect(paras[1]).toBe(`${a} ${b}`)
  })

  it('starts a new paragraph at a blank line, an indent, or a list marker', () => {
    const out = cleanPdf([
      page(startsWith('alpha'), '', startsWith('beta'), `    ${startsWith('indented')}`, `- ${startsWith('a list item')}`)
    ])[0]
    expect(out.split('\n\n')).toHaveLength(4)
  })

  it('returns one entry per page, empty where a page was only furniture', () => {
    const pages = [
      page(startsWith('alpha'), 'H'),
      'H',
      page(startsWith('beta'), 'H'),
      'H'
    ]
    const out = cleanPdf(pages)
    expect(out).toHaveLength(4)
    expect(out[1]).toBe('')
    expect(out[3]).toBe('')
  })

  it('handles an empty document and an empty page without throwing', () => {
    expect(cleanPdf([])).toEqual([])
    expect(cleanPdf([''])).toEqual([''])
  })
})
