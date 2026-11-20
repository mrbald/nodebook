import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, relative, resolve, sep } from 'path'
import { setImmediate } from 'timers/promises'
import { figureMarkdown } from '../../shared/figures'
import { cleanFigureText, figureOcrMarkdown, FigureCapture, literalFigureText, MAX_FIGURE_BYTES } from './captureFigures'

export type ReadImage = (src: string) => Uint8Array | undefined

/** Resolve a URL path without admitting browser-relative hosts or file URLs. */
export function relativeImagePath(src: string): string | undefined {
  const raw = src.trim().split(/[?#]/, 1)[0]
  try {
    const path = decodeURIComponent(raw)
    if (path && !path.startsWith('/') && !/[:\\\p{Cc}]/u.test(path)) return path
  } catch {
    // An invalid percent escape cannot name a local asset.
  }
  return undefined
}

export function isLocalHtmlImagePath(src: string): boolean {
  const path = relativeImagePath(src)
  return !!path && !path.split('/').includes('..')
}

/** Read static HTML's sibling assets. The document cannot use relative URLs
 * to read a parent directory, a symlink escaping the document's directory,
 * or a socket or device. The open descriptor's size bounds the read. */
export function readLocalHtmlImage(file: string, src: string): Uint8Array | undefined {
  const path = relativeImagePath(src)
  if (!path || path.split('/').includes('..')) return undefined
  let fd: number | undefined
  try {
    const base = realpathSync(dirname(file))
    const candidate = realpathSync(resolve(base, path))
    const withinBase = relative(base, candidate)
    if (!withinBase || withinBase === '..' || withinBase.startsWith(`..${sep}`) || resolve(base, withinBase) !== candidate) {
      return undefined
    }
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || !stat.size || stat.size > MAX_FIGURE_BYTES) return undefined
    const bytes = Buffer.allocUnsafe(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    return length === stat.size ? bytes.subarray(0, length) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function dataImage(src: string): Uint8Array | undefined {
  const comma = src.indexOf(',')
  if (comma < 0 || !/^data:image\/(?:png|jpeg|jpg|gif|webp);base64$/i.test(src.slice(0, comma))) return undefined
  if (src.length - comma - 1 > Math.ceil(MAX_FIGURE_BYTES / 3) * 4) return undefined
  const encoded = src.slice(comma + 1).replace(/\s/g, '')
  if (!/^[a-z\d+/]+={0,2}$/i.test(encoded) || encoded.length % 4 === 1) return undefined
  return Buffer.from(encoded, 'base64')
}

function decorative(node: HTMLElement): boolean {
  const width = Number.parseFloat(node.getAttribute('width') ?? '')
  const height = Number.parseFloat(node.getAttribute('height') ?? '')
  return node.getAttribute('aria-hidden') === 'true' ||
    ['none', 'presentation'].includes(node.getAttribute('role') ?? '') ||
    (width > 0 && width <= 12) || (height > 0 && height <= 12)
}

function authoredCaption(node: HTMLElement, wordCaptions: boolean | undefined): string {
  const figureCaption = node.closest('figure')?.querySelector('figcaption')
  if (figureCaption) return figureCaption.textContent ?? ''
  if (wordCaptions) {
    const paragraph = node.closest('p')
    const following = paragraph?.nextElementSibling
    const text = following?.textContent ?? ''
    if (following?.localName === 'figcaption' ||
        /^(?:fig(?:ure)?\.?|chart|diagram|illustration|plate)\s+[\w-]+\s*[.:—–]/i.test(text.trim())) return text
  }
  return ''
}

function imageSource(node: HTMLElement): string {
  return (node.getAttribute('src') ?? node.getAttribute('href') ?? node.getAttribute('xlink:href'))?.trim() ?? ''
}

interface HtmlFigure {
  src: string
  alt: string
  caption: string
  location: string
}

/** Turndown's own parsed nodes identify the real image elements and their
 * surrounding headings. Replace placeholders after the synchronous walk so
 * no source URL or image data reaches the output or crosses into the model. */
export async function htmlBodyToMarkdown(
  html: string,
  capture: FigureCapture,
  options: { location?: string; readImage?: ReadImage; wordCaptions?: boolean } = {}
): Promise<string> {
  capture.signal?.throwIfAborted()
  const TurndownService = (await import('turndown')).default
  const baseLocation = options.location ?? ''
  const headings: string[] = []
  const images: HtmlFigure[] = []
  const marker = `NODEBOOKIMAGE${randomUUID().replaceAll('-', '')}Z`
  const record = (node: HTMLElement, src: string, alt: string): string => {
    if (decorative(node)) return ''
    if (!src) return literalFigureText(alt)
    const caption = cleanFigureText(authoredCaption(node, options.wordCaptions))
    const location = [baseLocation, ...headings].filter(Boolean).join(' › ') || 'Document'
    images.push({ src, alt, caption, location })
    return `${marker}${images.length - 1}Z`
  }
  // EPUBs commonly wrap the cover bitmap in an SVG viewport. Capture its
  // raster resource without handing an active SVG document to a renderer.
  const svgMarkers = new WeakMap<HTMLElement, string>()
  const svgImage = (svg: HTMLElement): string => {
    const known = svgMarkers.get(svg)
    if (known !== undefined) return known
    const alt = cleanFigureText(svg.getAttribute('aria-label') ?? svg.querySelector('title')?.textContent ?? '')
    const raster = decorative(svg) ? [] : Array.from(svg.querySelectorAll<HTMLElement>('image'))
    const placeholders = raster.map((node) => record(node, imageSource(node), alt)).filter(Boolean).join('\n\n')
    svgMarkers.set(svg, placeholders)
    return placeholders
  }
  const td = new TurndownService({
    headingStyle: 'atx',
    // A pure SVG raster wrapper has no text, so Turndown asks the blank
    // handler for both the SVG and any blank surrounding block.
    blankReplacement(_content, node) {
      const svgs = node.localName === 'svg' ? [node] : Array.from(node.querySelectorAll<HTMLElement>('svg'))
      return svgs.map(svgImage).filter(Boolean).join('\n\n') || ('isBlock' in node && node.isBlock ? '\n\n' : '')
    }
  })
  td.remove(['script', 'style', 'noscript'])
  td.addRule('figureHeading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement(content, node) {
      const level = Number(node.nodeName[1])
      headings.splice(level - 1)
      headings[level - 1] = cleanFigureText(node.textContent ?? '')
      return `\n\n${'#'.repeat(level)} ${content}\n\n`
    }
  })
  td.addRule('figureCaption', {
    filter: 'figcaption',
    replacement: (content) => content ? `\n\n${content}\n\n` : ''
  })
  td.addRule('figureImage', {
    filter: 'img',
    replacement: (_content, node) => record(node, imageSource(node), cleanFigureText(node.getAttribute('alt') ?? ''))
  })
  td.addRule('svgImage', {
    filter: (node) => node.localName === 'svg',
    replacement: (content, node) => svgImage(node) || content
  })
  td.addRule('discardImageDataTargets', {
    filter: (node) => node.localName === 'a' && /^data:image\//i.test(node.getAttribute('href')?.trim() ?? ''),
    replacement: (content) => content
  })
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
  const markdown = td.turndown(body).trim()
  if (!images.length) return markdown

  const replacements: string[] = []
  const ocr: string[] = []
  for (const [index, image] of images.entries()) {
    await setImmediate()
    capture.signal?.throwIfAborted()
    const { src, alt, caption, location } = image
    const bytes = capture.full
      ? undefined
      : /^data:/i.test(src) ? dataImage(src) : options.readImage?.(src)
    const figure = bytes
      ? await capture.add(bytes, { label: alt || caption || `Figure ${index + 1}`, location, ...(caption ? { caption } : {}) })
      : capture.skip()
    replacements.push(figure ? figureMarkdown(figure) : literalFigureText(alt))
    if (figure?.ocr) ocr.push(figureOcrMarkdown(figure))
  }
  const resolved = markdown.replace(new RegExp(`${marker}(\\d+)Z`, 'g'), (_match, index) => replacements[Number(index)])
  return [resolved, ...ocr].filter(Boolean).join('\n\n').trim()
}
