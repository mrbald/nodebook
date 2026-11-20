import { chardet } from 'jschardet'
import { importTextEncodingLabel } from '../../shared/textEncodings'

export interface ImportTextOptions {
  encoding?: string
  html?: boolean
  xml?: boolean
}

export interface DecodedImportText {
  text: string
  encoding: string
  source: 'bom' | 'utf8' | 'declared' | 'detected' | 'chosen'
  uncertain?: boolean
}

interface ImportDecoder {
  readonly encoding: string
  decode(bytes: Uint8Array): string
}

// The detector names its models after the Python codecs it was trained on.
// TextDecoder uses WHATWG labels for the compatible subset.
const encodingAliases = new Map([
  ['utf-8-sig', 'utf-8'],
  ['mac-cyrillic', 'x-mac-cyrillic'],
  ['maccyrillic', 'x-mac-cyrillic'],
  ['mac-roman', 'macintosh'],
  ['macroman', 'macintosh'],
  ['855', 'ibm855'],
  ['cp855', 'ibm855'],
  ['csibm855', 'ibm855'],
  ['cp874', 'windows-874'],
  ['cp932', 'shift_jis'],
  ['cp949', 'euc-kr'],
  ['big5hkscs', 'big5'],
  ['euc-jis-2004', 'euc-jp'],
  ['shift_jis_2004', 'shift_jis'],
  ['utf-16-le', 'utf-16le'],
  ['utf-16-be', 'utf-16be']
])

// The 0x80–0xff mapping for IBM855, which ICU's WHATWG API does not expose.
// https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP855.TXT
const ibm855HighBytes =
  'ђЂѓЃёЁєЄѕЅіІїЇјЈ' +
  'љЉњЊћЋќЌўЎџЏюЮъЪ' +
  'аАбБцЦдДеЕфФгГ«»' +
  '░▒▓│┤хХиИ╣║╗╝йЙ┐' +
  '└┴┬├─┼кК╚╔╩╦╠═╬¤' +
  'лЛмМнНоОп┘┌█▄Пя▀' +
  'ЯрРсСтТуУжЖвВьЬ№' +
  '\u00adыЫзЗшШэЭщЩчЧ§■\u00a0'

// The 0xa0–0xff mapping from Python's iso8859_16 codec. Lower bytes map
// to themselves. Node 22 does not expose this encoding through TextDecoder.
const iso885916HighBytes =
  '\u00a0ĄąŁ€„Š§š©Ș«Ź\u00adźŻ' +
  '°±ČłŽ”¶·žčș»ŒœŸż' +
  'ÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏ' +
  'ĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚß' +
  'àáâăäćæçèéêëìíîï' +
  'đńòóôőöśűùúûüęțÿ'

function singleByteDecoder(encoding: string, highBytes: string): ImportDecoder {
  const start = 0x100 - highBytes.length
  return {
    encoding,
    decode(bytes: Uint8Array): string {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
        .replace(/[\u0080-\u00ff]/g, (char) => highBytes[char.charCodeAt(0) - start] ?? char)
    }
  }
}

function decoderFor(label: string): ImportDecoder | undefined {
  const normalized = label.trim().toLowerCase()
  const hyphenated = normalized.replaceAll('_', '-')
  const encoding = encodingAliases.get(normalized) ?? encodingAliases.get(hyphenated) ?? hyphenated
  if (encoding === 'ibm855') return singleByteDecoder(encoding, ibm855HighBytes)
  if (encoding === 'iso-8859-16') return singleByteDecoder(encoding, iso885916HighBytes)
  try {
    return new TextDecoder(encoding, { fatal: true })
  } catch {
    return undefined
  }
}

function decode(bytes: Uint8Array, decoder: ImportDecoder): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

function withoutDosEof(bytes: Uint8Array): Uint8Array {
  // Older DOS text editors wrote a single trailing Ctrl-Z.
  return bytes.at(-1) === 0x1a ? bytes.subarray(0, -1) : bytes
}

function isPlainText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && (code < 9 || code > 13)) return false
    if (code >= 127 && code <= 159 && code !== 0x85) return false
    if (code >= 0xfffe) return false
  }
  return true
}

function assertRecoverable(text: string | undefined): void {
  if (!text) return
  let count = 0
  for (let index = text.indexOf('\uFFFD'); index !== -1; index = text.indexOf('\uFFFD', index + 1)) {
    count++
  }
  // Preserve occasional literal �, e.g. in technical text about encoding.
  if (count >= 4 && count * 20 >= text.length) {
    throw new Error('This file contains many Unicode replacement characters (�). Import the original file or a fresh export.')
  }
}

function asText(
  bytes: Uint8Array,
  decoder: ImportDecoder,
  source: DecodedImportText['source']
): DecodedImportText | undefined {
  const text = decode(decoder.encoding.startsWith('utf-16') ? bytes : withoutDosEof(bytes), decoder)
  if (text === undefined || !isPlainText(text)) return undefined
  assertRecoverable(text)
  return { text, encoding: decoder.encoding, source }
}

function byteOrderMark(bytes: Uint8Array): string | undefined {
  const [a, b, c, d] = bytes.subarray(0, 4)
  if (a === 0xef && b === 0xbb && c === 0xbf) return 'utf-8'
  if (a === 0x00 && b === 0x00 && c === 0xfe && d === 0xff) return 'utf-32be'
  if (a === 0xff && b === 0xfe && c === 0x00 && d === 0x00) return 'utf-32le'
  if (a === 0xff && b === 0xfe) return 'utf-16le'
  if (a === 0xfe && b === 0xff) return 'utf-16be'
  return undefined
}

function shortUnmarkedUtf16(bytes: Uint8Array): string | undefined {
  // The library sniffs UTF-16 in files of at least ten bytes. For shorter
  // inputs, require at least two ASCII code units in the same byte order.
  if (bytes.length < 4 || bytes.length >= 10 || bytes.length % 2 !== 0) return undefined
  const ascii = (byte: number): boolean => byte >= 9 && byte <= 126
  if (bytes.every((byte, index) => (index % 2 === 0 ? ascii(byte) : byte === 0))) return 'utf-16le'
  if (bytes.every((byte, index) => (index % 2 === 1 ? ascii(byte) : byte === 0))) return 'utf-16be'
  return undefined
}

function attributes(source: string): Map<string, string> {
  const values = new Map<string, string>()
  const pairs = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const [, name, double, single, bare] of source.matchAll(pairs)) {
    const key = name.toLowerCase()
    if (!values.has(key)) values.set(key, double ?? single ?? bare ?? '')
  }
  return values
}

function declaredEncoding(bytes: Uint8Array, options: ImportTextOptions): ImportDecoder | undefined {
  if (!options.html && !options.xml) return undefined
  // Charset labels and their delimiters are ASCII even in an otherwise legacy document.
  const header = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024))
  const declaration = /^<\?xml\s+([\s\S]*?)\?>/.exec(header)
  const xmlLabel = declaration && attributes(declaration[1]).get('encoding')
  if (xmlLabel) {
    const decoder = decoderFor(xmlLabel)
    if (decoder) return decoder
  }
  if (!options.html) return undefined

  // Skip comments, quoted attribute values and raw text when reading HTML metadata.
  const tags = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:[^"'>]|"[^"]*"|'[^']*')*)>/gi
  let rawTextTag: string | undefined
  let templateDepth = 0
  for (const [, closing, name, attrs] of header.matchAll(tags)) {
    const tag = name?.toLowerCase()
    if (rawTextTag) {
      if (closing && tag === rawTextTag) rawTextTag = undefined
      continue
    }
    if (tag === 'template') {
      templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1))
      continue
    }
    if (templateDepth) continue
    if (tag === 'body' || (closing && tag === 'head')) break
    if (closing) continue
    if (tag === 'script' || tag === 'style' || tag === 'title' || tag === 'textarea') rawTextTag = tag
    if (tag !== 'meta') continue

    const values = attributes(attrs)
    let label = values.get('charset')
    if (label === undefined && values.get('http-equiv')?.trim().toLowerCase() === 'content-type') {
      const content = values.get('content') ?? ''
      const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i.exec(content)
      if (charset) label = charset[1] ?? charset[2] ?? charset[3]
    }
    if (label === undefined) continue
    const decoder = decoderFor(label)
    if (!decoder) continue
    // HTML's META declares an ASCII-compatible encoding.
    if (decoder.encoding.startsWith('utf-16')) return decoderFor('utf-8')
    if (decoder.encoding === 'x-user-defined') return decoderFor('windows-1252')
    return decoder
  }
  return undefined
}

function detectionSample(bytes: Uint8Array): Uint8Array {
  // The library inspects at most 200 KB. Start close to the first non-ASCII
  // evidence when a long ASCII-only prefix would otherwise exhaust that budget.
  if (bytes.length <= chardet.DEFAULT_MAX_BYTES) return bytes
  const first = bytes.findIndex((byte) => byte >= 128 || byte === 0)
  if (first < 1024) return bytes
  return bytes.subarray(first - 1024)
}

const binaryError = 'This file does not contain readable text. Check the file format or choose the original text encoding.'
const closeScore = 0.015

function detectEncoding(bytes: Uint8Array): DecodedImportText {
  const detectionOptions = { compatNames: false, ignoreThreshold: true }
  const withoutEof = withoutDosEof(bytes)
  const sample = detectionSample(withoutEof)
  // An unmarked UTF-16 code unit can also end in 0x1a. Give the detector the
  // original bytes when they could contain whole code units.
  const original = withoutEof !== bytes && bytes.length % 2 === 0
    ? chardet.detectAll(detectionSample(bytes), detectionOptions)
    : undefined
  const matches = original?.[0]?.encoding?.startsWith('utf-16')
    ? original
    : chardet.detectAll(sample, detectionOptions)
  if (matches[0]?.encoding === null) throw new Error(binaryError)

  const checked = new Set<string>()
  let best: (DecodedImportText & { confidence: number }) | undefined
  let ambiguous = false
  for (const { encoding, confidence } of matches) {
    if (best && best.confidence - confidence >= closeScore) break
    if (!encoding) continue
    const decoder = decoderFor(encoding)
    if (!decoder || checked.has(decoder.encoding)) continue
    checked.add(decoder.encoding)
    const result = asText(bytes, decoder, 'detected')
    if (!result) continue
    if (!best) {
      best = { ...result, confidence }
      continue
    }
    if (result.text !== best.text) {
      ambiguous = true
      break
    }
  }
  if (!best) throw new Error(binaryError)

  // Confidence is a model score. Sparse evidence and a close candidate with a
  // different decoded string both warrant a preview before accepting the guess.
  let highBytes = 0
  for (const byte of sample.subarray(0, chardet.DEFAULT_MAX_BYTES)) {
    if (byte >= 128 && ++highBytes >= 8) break
  }
  const { confidence, ...result } = best
  const skippedTopGuess = (matches[0]?.confidence ?? 0) - confidence >= closeScore
  const uncertain = ambiguous || skippedTopGuess || confidence < 0.2 ||
    (highBytes < 8 && !result.encoding.startsWith('utf-16'))
  return uncertain ? { ...result, uncertain: true } : result
}

export function decodeImportText(
  bytes: Uint8Array,
  options: ImportTextOptions = {}
): DecodedImportText {
  const bom = byteOrderMark(bytes)
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  if (options.encoding !== undefined) {
    const chosen = decoderFor(options.encoding)
    if (!chosen) throw new Error('Unsupported text encoding: ' + options.encoding)
    const original = (bom && decoderFor(bom)) || utf8
    const originalText = decode(bytes, original)
    assertRecoverable(originalText)
    if (originalText === undefined || !isPlainText(originalText)) {
      const match = chardet.detect(bytes)
      if (!match.encoding && match.mimeType !== 'application/octet-stream') throw new Error(binaryError)
    }
    const result = asText(bytes, chosen, 'chosen')
    if (result) return result
    throw new Error('Cannot read this file as ' + importTextEncodingLabel(chosen.encoding) + '. Choose another encoding or import the original file.')
  }

  if (bom) {
    const decoder = decoderFor(bom)
    if (!decoder) throw new Error('Unsupported Unicode byte-order mark. Export the original file as UTF-8.')
    const result = asText(bytes, decoder, 'bom')
    if (result) return result
    throw new Error('The file does not match its Unicode byte-order mark. Import the original file or a fresh export.')
  }

  const utf16 = shortUnmarkedUtf16(bytes)
  if (utf16) {
    const result = asText(bytes, new TextDecoder(utf16, { fatal: true }), 'detected')
    if (result) return result
  }

  const rawUtf8 = decode(withoutDosEof(bytes), utf8)
  assertRecoverable(rawUtf8)
  const declared = declaredEncoding(bytes, options)
  if (declared) {
    const result = asText(bytes, declared, 'declared')
    if (result) {
      // A stale single-byte declaration can turn valid UTF-8 into printable
      // gibberish. Both interpretations are possible, so ask the reader to check.
      return rawUtf8 !== undefined && rawUtf8 !== result.text && isPlainText(rawUtf8)
        ? { ...result, uncertain: true } : result
    }
  }

  // ISO-2022-JP uses only seven-bit bytes, including escape sequences.
  if (rawUtf8?.includes('\x1b$') || rawUtf8?.includes('\x1b(')) {
    const result = asText(bytes, new TextDecoder('iso-2022-jp', { fatal: true }), 'detected')
    if (result) return result
  }
  if (rawUtf8 !== undefined && isPlainText(rawUtf8)) {
    return { text: rawUtf8, encoding: 'utf-8', source: 'utf8' }
  }
  const result = detectEncoding(bytes)
  return declared ? { ...result, uncertain: true } : result
}
