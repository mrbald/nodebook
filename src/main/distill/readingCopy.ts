import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { ReadingCopy, ReadingCopyPreview, StagedReading } from '../../shared/readingCopy'
import { distillRoot, isRunId, readRunMeta, readRunJson, runDir, sourceNoteName, stagedNotePath } from './artifact'
import { renderDocumentNote } from './emit'
import { decodeImportText } from './textEncoding'
import { encodingSample } from '../../shared/encodingSample'

export const READING_COPY_EXTENSIONS = ['txt', 'text', 'md', 'markdown']

function isPlainTextPath(path: string): boolean {
  return READING_COPY_EXTENSIONS.includes(extname(path).toLowerCase().slice(1))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

interface DamagedDocument {
  vault: string
  runId: string
  path: string
  scopeHash: string
  historicalHash: string
  body: string
}

function openRegularFile<T>(path: string, read: (fd: number, stat: BigIntStats) => T): T {
  if (!lstatSync(path).isFile()) throw new Error('Choose a regular text file.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) throw new Error('Choose a regular text file.')
    return read(fd, stat)
  } finally {
    closeSync(fd)
  }
}

function fileRevision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

interface SourceScan {
  path: string
  revision: string
  document: DamagedDocument | null
}

function scanStagedSource(vault: string, runId: string, previous?: SourceScan | null): SourceScan | null {
  if (typeof runId !== 'string' || !isRunId(runId)) return null
  try {
    const dir = runDir(vault, runId)
    if (![distillRoot(vault), dir, join(dir, 'notes')].every((path) => lstatSync(path).isDirectory())) return null
    if (!lstatSync(join(dir, 'meta.json')).isFile()) return null
    const meta = readRunMeta(vault, runId)
    if (!meta || basename(meta.source) !== meta.source || !isPlainTextPath(meta.source)) return null
    const note = `${sourceNoteName(meta.source)}.md`
    const path = join(dir, 'notes', note)
    const scopeHash = sha256(JSON.stringify([realpathSync(vault), basename(realpathSync(dir)), `notes/${note}`]))
    const run = lstatSync(join(dir, 'run.json'), { throwIfNoEntry: false })?.isFile()
      ? readRunJson(vault, runId)
      : null
    // Recreate exactly the generated wrapper using the saved run provenance.
    // Old source notes have no wrapper. Authored Markdown frontmatter is data.
    const header = run?.file === meta.source && run.hash === meta.sourceHash
      ? renderDocumentNote({ text: '', hash: run.hash, originalPath: run.originalPath }).content
      : ''
    return openRegularFile(path, (fd, stat) => {
      const revision = `${scopeHash}:${fileRevision(stat)}:${header}`
      if (previous?.path === path && previous.revision === revision) return previous
      const bytes = readFileSync(fd)
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const body = header && content.startsWith(header) ? content.slice(header.length) : content
      const firstReplacement = body.indexOf('\uFFFD')
      const damaged = body.includes('\0') || (firstReplacement >= 0 && body.indexOf('\uFFFD', firstReplacement + 1) >= 0)
      return {
        path,
        revision,
        document: damaged ? { vault, runId, path, scopeHash, historicalHash: sha256(bytes), body } : null
      }
    })
  } catch {
    return null
  }
}

function sourceUnchanged(doc: DamagedDocument): boolean {
  const current = scanStagedSource(doc.vault, doc.runId)?.document
  return !!current && current.path === doc.path && current.scopeHash === doc.scopeHash &&
    current.historicalHash === doc.historicalHash && current.body === doc.body
}

function readOriginal(path: string, body: string): Buffer {
  try {
    return openRegularFile(path, (fd, stat) => {
      // One UTF-8 decoded code unit consumes at most four input bytes. Bound the
      // read even if the file grows between the size check and read.
      const size = Number(stat.size)
      if (size > body.length * 4) throw new Error('This file does not match the staged source.')
      const buffer = Buffer.alloc(size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length !== size || fileRevision(stat) !== fileRevision(fstatSync(fd, { bigint: true }))) {
        throw new Error('The original changed while reading it. Pick it again.')
      }
      return buffer.subarray(0, length)
    })
  } catch (error) {
    // Native picker paths belong to main, including in errors from the OS.
    if (error instanceof Error && 'code' in error) throw new Error('Couldn’t read the original text file.', { cause: error })
    throw error
  }
}

interface CopyRecord extends ReadingCopy {
  version: 1
  scopeHash: string
  historicalHash: string
  originalHash: string
  textHash: string
}

function copyPath(directory: string, doc: DamagedDocument): string {
  return join(directory, `${doc.scopeHash}-${doc.historicalHash}.json`)
}

function readCopy(directory: string, doc: DamagedDocument): ReadingCopy | null {
  try {
    if (!lstatSync(directory).isDirectory()) return null
    const bytes = openRegularFile(copyPath(directory, doc), (fd) => readFileSync(fd))
    const copy: Partial<CopyRecord> = JSON.parse(bytes.toString('utf8'))
    if (copy.version !== 1 || copy.scopeHash !== doc.scopeHash || copy.historicalHash !== doc.historicalHash ||
        typeof copy.originalHash !== 'string' || !/^[a-f0-9]{64}$/.test(copy.originalHash) ||
        typeof copy.text !== 'string' || typeof copy.encoding !== 'string' ||
        copy.textHash !== sha256(copy.text)) return null
    return { text: copy.text, encoding: copy.encoding }
  } catch {
    return null
  }
}

interface PendingCopy {
  id: string
  doc: DamagedDocument
  bytes: Buffer
  draft?: ReadingCopy
}

/** A durable display copy plus one pending picker per open vault. Reading a
 * staged note's citation or merging a run still uses its historical bytes. */
export class ReadingCopies {
  private revision = 0
  private pending: PendingCopy | null = null
  private lastScan: SourceScan | null = null
  private readonly directory: string

  constructor(userData: string) {
    this.directory = join(userData, 'reading-copies')
  }

  clear(): void {
    this.revision++
    this.pending = null
    this.lastScan = null
  }

  status(vault: string, runId: string, note: string): StagedReading | undefined {
    const notePath = stagedNotePath(vault, runId, note)
    if (!notePath) return
    this.lastScan = scanStagedSource(vault, runId, this.lastScan)
    const doc = this.lastScan?.document
    if (!doc) return
    if (notePath !== doc.path) return { kind: 'historical-note' }
    return { kind: 'source', copy: readCopy(this.directory, doc) }
  }

  async locate(
    vault: string, runId: string, note: string, pick: () => Promise<string | null>
  ): Promise<ReadingCopyPreview | null> {
    const notePath = stagedNotePath(vault, runId, note)
    const doc = notePath && scanStagedSource(vault, runId)?.document
    if (!doc || notePath !== doc.path) throw new Error('This staged source is unavailable.')
    this.clear()
    const revision = this.revision
    const path = await pick()
    if (!path || revision !== this.revision) return null
    if (!sourceUnchanged(doc)) throw new Error('The staged source changed. Reopen it and try again.')
    if (!isPlainTextPath(path)) throw new Error('Choose an original text or Markdown file.')
    const bytes = readOriginal(path, doc.body)
    if (bytes.toString('utf8') !== doc.body) throw new Error('This file does not match the staged source.')
    if (!doc.body.includes('\0') && bytes.equals(Buffer.from(doc.body, 'utf8'))) {
      throw new Error('This file already contains the damaged text. Choose the original bytes.')
    }
    this.pending = { id: randomUUID(), doc, bytes }
    return this.choose(this.pending.id)
  }

  choose(id: string, encoding?: string): ReadingCopyPreview {
    const pending = this.requirePending(id)
    pending.id = randomUUID()
    pending.draft = undefined
    try {
      const decoded = decodeImportText(pending.bytes, { encoding })
      pending.draft = { encoding: decoded.encoding, text: decoded.text }
      return { id: pending.id, encoding: decoded.encoding, preview: encodingSample(decoded.text, 800), uncertain: decoded.uncertain }
    } catch (error) {
      return { id: pending.id, error: error instanceof Error ? error.message : 'Couldn’t decode the original.' }
    }
  }

  save(id: string): ReadingCopy {
    const pending = this.requirePending(id)
    const { doc, draft } = pending
    if (!draft || !sourceUnchanged(doc)) {
      throw new Error('The staged source changed or the preview is unavailable. Locate the original again.')
    }
    const record: CopyRecord = {
      version: 1,
      scopeHash: doc.scopeHash,
      historicalHash: doc.historicalHash,
      originalHash: sha256(pending.bytes),
      textHash: sha256(draft.text),
      ...draft
    }
    const path = copyPath(this.directory, doc)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!lstatSync(this.directory).isDirectory()) throw new Error('The reading copy folder is unavailable.')
    const temp = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
      renameSync(temp, path)
    } finally {
      rmSync(temp, { force: true })
    }
    this.clear()
    return draft
  }

  discard(id: string): void {
    if (this.pending?.id === id) this.clear()
  }

  private requirePending(id: string): PendingCopy {
    if (!this.pending || typeof id !== 'string' || this.pending.id !== id) {
      throw new Error('The preview is no longer available. Locate the original again.')
    }
    return this.pending
  }
}
