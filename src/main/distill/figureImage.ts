import { crc32 } from 'zlib'
import type { FigureExtension } from '../../shared/figures'

export function figureImageDimensions(input: Uint8Array): [FigureExtension, number, number] | undefined {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.length < 24) return undefined
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR') {
    return ['png', bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  const signature = bytes.toString('ascii', 0, 6)
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return ['gif', bytes.readUInt16LE(6), bytes.readUInt16LE(8)]
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return ['webp', bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const shape = bytes.readUInt32LE(21)
      return ['webp', (shape & 0x3fff) + 1, ((shape >> 14) & 0x3fff) + 1]
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.readUIntLE(23, 3) === 0x2a019d) {
      return ['webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
    }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  for (let i = 2; i + 4 <= bytes.length;) {
    if (bytes[i++] !== 0xff) break
    while (bytes[i] === 0xff) i++
    const marker = bytes[i++]
    if (marker === 0xd9 || marker === 0xda || i + 2 > bytes.length) break
    const size = bytes.readUInt16BE(i)
    if (size < 2 || i + size > bytes.length) break
    // Start of frame markers carry image dimensions. C4, C8 and CC do not.
    if ((marker & 0xf0) === 0xc0 && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 7) {
      return ['jpg', bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 3)]
    }
    i += size
  }
  return undefined
}

function completePng(bytes: Buffer): boolean {
  let imageData = false
  for (let i = 8; i + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(i)
    const end = i + 8 + length
    if (end + 4 > bytes.length || bytes.readUInt32BE(end) !== crc32(bytes.subarray(i + 4, end))) return false
    const type = bytes.toString('ascii', i + 4, i + 8)
    if (i === 8 && (type !== 'IHDR' || length !== 13)) return false
    if (type === 'IDAT' && length) imageData = true
    if (type === 'IEND') return imageData && length === 0 && end + 4 === bytes.length
    i = end + 4
  }
  return false
}

function completeGif(bytes: Buffer): boolean {
  const tableBytes = (flags: number): number => flags & 0x80 ? 3 * (2 << (flags & 7)) : 0
  let i = 13 + tableBytes(bytes[10])
  let image = false
  while (i < bytes.length) {
    const block = bytes[i++]
    if (block === 0x3b) return image && i === bytes.length
    if (block === 0x21) i++ // extension label precedes its data blocks
    else if (block === 0x2c && i + 9 <= bytes.length) {
      i += 10 + tableBytes(bytes[i + 8]) // image descriptor, color table, and LZW code size
      image = true
    } else return false
    for (;;) {
      if (i >= bytes.length) return false
      const size = bytes[i++]
      if (!size) break
      i += size
    }
  }
  return false
}

function completeWebp(bytes: Buffer): boolean {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return false
  let found = false
  let i = 12
  while (i + 8 <= bytes.length) {
    const type = bytes.toString('ascii', i, i + 4)
    const size = bytes.readUInt32LE(i + 4)
    if (size && (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF')) found = true
    i += 8 + size + (size % 2)
  }
  return found && i === bytes.length
}

/** Called after checking the raster header and pixel/byte budgets. Check
 * container integrity without passing malformed bytes to a native decoder. */
export function completeFigureImage(input: Uint8Array, ext: FigureExtension): boolean {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.length < 24) return false
  if (ext === 'png') return completePng(bytes)
  if (ext === 'gif') return completeGif(bytes)
  if (ext === 'webp') return completeWebp(bytes)
  return bytes.readUInt16BE(bytes.length - 2) === 0xffd9
}
