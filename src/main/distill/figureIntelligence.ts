import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { resolveCommand } from '../rag/cliChat'
import { figureImageDimensions } from './figureImage'

const execute = promisify(execFile)
const OCR_TIMEOUT_MS = 7_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16_000_000
const MAX_IMAGE_SIDE = 8_192
const MAX_TEXT = 4_000

// osascript and Vision ship with macOS. The only input to this script is an
// app-created file. ImageIO checks the actual raster before Vision decodes it.
const APPLE_OCR = `
ObjC.import('Foundation')
ObjC.import('ImageIO')
ObjC.import('Vision')
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0])
  const source = $.CGImageSourceCreateWithURL(url, null)
  if (Number($.CGImageSourceGetCount(source)) !== 1) return ''
  const props = ObjC.deepUnwrap(ObjC.castRefToObject(
    $.CGImageSourceCopyPropertiesAtIndex(source, 0, null)
  ))
  if (!props || !props.PixelWidth || !props.PixelHeight ||
      props.PixelWidth > ${MAX_IMAGE_SIDE} || props.PixelHeight > ${MAX_IMAGE_SIDE} ||
      props.PixelWidth * props.PixelHeight > ${MAX_IMAGE_PIXELS}) return ''
  const request = $.VNRecognizeTextRequest.alloc.init
  request.recognitionLevel = 0
  request.usesLanguageCorrection = false
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}))
  const requests = $.NSMutableArray.alloc.init
  requests.addObject(request)
  if (!handler.performRequestsError(requests, null)) return ''
  const results = request.results
  const lines = []
  for (let i = 0; i < Math.min(200, results.count); i++) {
    const candidate = results.objectAtIndex(i).topCandidates(1).firstObject
    if (candidate && candidate.confidence >= 0.3) {
      lines.push(ObjC.unwrap(candidate.string).slice(0, 500))
    }
  }
  return JSON.stringify(lines.join('\\n').slice(0, ${MAX_TEXT}))
}
`

let active = 0

/** Best-effort offline OCR. Conversion sets its own total figure/time budget.
 * Keep a process-wide cap as estimates can overlap and OCR is optional. */
export async function recognizeFigureText(
  bytes: Uint8Array,
  ext: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (active >= 2 || bytes.byteLength > MAX_IMAGE_BYTES || signal?.aborted) return
  if (ext !== 'png' && ext !== 'jpg' && ext !== 'gif' && ext !== 'webp') return
  const shape = figureImageDimensions(bytes)
  if (!shape) return
  const [format, width, height] = shape
  if (format !== ext || width <= 0 || height <= 0 ||
      width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) return
  const mac = process.platform === 'darwin'
  const command = mac ? '/usr/bin/osascript' : resolveCommand('tesseract')
  // A .cmd/.bat shim would require a shell. Tesseract's native binary doesn't.
  if (!command || /\.(cmd|bat)$/i.test(command)) return
  active++
  let scratch: string | undefined
  try {
    scratch = await mkdtemp(join(tmpdir(), 'nodebook-ocr-'))
    const file = join(scratch, `figure.${ext}`)
    await writeFile(file, bytes, { mode: 0o600, signal })
    const args = mac
      ? ['-l', 'JavaScript', '-e', APPLE_OCR, '--', file]
      : [file, 'stdout', '--psm', '11']
    const { stdout } = await execute(command, args, {
      cwd: scratch,
      env: mac ? process.env : { ...process.env, OMP_THREAD_LIMIT: '2' },
      timeout: OCR_TIMEOUT_MS,
      signal,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
    if (!stdout.trim()) return
    const text: unknown = mac ? JSON.parse(stdout) : stdout
    if (typeof text === 'string') return text.trim().slice(0, MAX_TEXT) || undefined
  } catch {
    // An unreadable or unsupported raster must never fail an import.
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    active--
  }
}
