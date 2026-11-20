import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDocumentNote } from './emit'
import { ReadingCopies } from './readingCopy'

const book = 'Book'
const run = 'run-2'
const source = `${book}.txt`
const text = 'Русский текст о старой книге. История была записана в конце века.\n'
const original = Buffer.from(Array.from(text, (letter) => {
  const code = letter.charCodeAt(0)
  return code < 128 ? code : 0xc0 + code - 0x0410
}))
const damaged = original.toString('utf8')
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

let fixture: string
let vault: string
let userData: string
let runDirectory: string
let sourceNote: string
let originalPath: string
let copies: ReadingCopies

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'nodebook-reading-copy-'))
  vault = join(fixture, 'vault')
  userData = join(fixture, 'user-data')
  runDirectory = join(vault, '.distill', run)
  sourceNote = join(runDirectory, 'notes', `${book}.md`)
  originalPath = join(fixture, source)
  mkdirSync(join(runDirectory, 'notes'), { recursive: true })
  writeFileSync(sourceNote, damaged)
  writeFileSync(join(runDirectory, 'notes', 'Concept.md'), '# Concept\n')
  writeFileSync(join(runDirectory, 'meta.json'), JSON.stringify({ source, notes: 1 }))
  writeFileSync(originalPath, original)
  copies = new ReadingCopies(userData)
})

afterEach(() => rmSync(fixture, { recursive: true, force: true }))

const pickOriginal = async (): Promise<string> => originalPath

describe('reading copies', () => {
  it('stores a verified, separately addressed display copy and reopens without the original', async () => {
    expect(copies.status(vault, run, book)).toEqual({ kind: 'source', copy: null })
    expect(copies.status(vault, run, 'Concept')).toEqual({ kind: 'historical-note' })

    const auto = await copies.locate(vault, run, sourceNote, pickOriginal)
    const chosen = copies.choose(auto!.id, 'windows-1251')
    expect(chosen).toMatchObject({ encoding: 'windows-1251', preview: text })
    expect(() => copies.save(auto!.id)).toThrow('preview is no longer available')
    expect(copies.save(chosen.id)).toEqual({ text, encoding: 'windows-1251' })

    const historicalHash = digest(damaged)
    const scopeHash = digest(JSON.stringify([realpathSync(vault), run, `notes/${book}.md`]))
    const cache = join(userData, 'reading-copies', `${scopeHash}-${historicalHash}.json`)
    const record = JSON.parse(readFileSync(cache, 'utf8'))
    expect(record).toEqual({
      version: 1,
      scopeHash,
      historicalHash,
      originalHash: digest(original),
      encoding: 'windows-1251',
      textHash: digest(text),
      text
    })
    expect(readFileSync(sourceNote, 'utf8')).toBe(damaged)
    rmSync(originalPath)
    const restarted = new ReadingCopies(userData)
    expect(restarted.status(vault, run, book)).toEqual({ kind: 'source', copy: { text, encoding: 'windows-1251' } })
    writeFileSync(cache, JSON.stringify({ ...record, text: 'Edited cached text' }))
    expect(restarted.status(vault, run, book)).toEqual({ kind: 'source', copy: null })
  })

  it('never reuses copies between vaults, runs, or source names with identical damaged text', async () => {
    const otherVault = join(fixture, 'other-vault')
    const otherRun = 'run-3'
    const otherBook = 'Different book'
    const otherOriginal = join(fixture, 'different.txt')
    const differentBytes = Buffer.from(original)
    differentBytes[0] = 0xc0
    expect(differentBytes.toString('utf8')).toBe(damaged)
    writeFileSync(otherOriginal, differentBytes)

    const fixtureBook = (root: string, id: string, title: string): void => {
      const dir = join(root, '.distill', id)
      mkdirSync(join(dir, 'notes'), { recursive: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ source: `${title}.txt`, notes: 0 }))
      writeFileSync(join(dir, 'notes', `${title}.md`), damaged)
    }
    fixtureBook(vault, otherRun, book)
    fixtureBook(otherVault, run, book)

    const save = async (root: string, id: string, pick: () => Promise<string>): Promise<void> => {
      const preview = await copies.locate(root, id, book, pick)
      const selected = copies.choose(preview!.id, 'windows-1251')
      copies.save(selected.id)
    }
    await save(vault, run, pickOriginal)
    expect(copies.status(vault, otherRun, book)).toEqual({ kind: 'source', copy: null })
    expect(copies.status(otherVault, run, book)).toEqual({ kind: 'source', copy: null })

    await save(otherVault, run, async () => otherOriginal)
    expect(copies.status(otherVault, run, book)).toMatchObject({ copy: { text: 'А' + text.slice(1) } })
    expect(copies.status(vault, run, book)).toMatchObject({ copy: { text } })

    fixtureBook(vault, run, otherBook)
    expect(copies.status(vault, run, otherBook)).toEqual({ kind: 'source', copy: null })
  })

  it('strips only a generated modern wrapper and checks the whole body, including line endings', async () => {
    const hash = 'b'.repeat(40)
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({
      file: source, hash, originalPath, createdAt: '2026-11-20T01:00:00.000Z'
    }))
    writeFileSync(join(runDirectory, 'meta.json'), JSON.stringify({ source, sourceHash: hash, notes: 1 }))
    const rendered = renderDocumentNote({ text: damaged, originalPath, hash }).content
    writeFileSync(sourceNote, rendered)
    const preview = await copies.locate(vault, run, book, pickOriginal)
    expect(preview).toBeTruthy()

    writeFileSync(sourceNote, rendered.replace('kind: document', 'kind: other'))
    await expect(copies.locate(vault, run, book, pickOriginal)).rejects.toThrow('does not match')
    writeFileSync(sourceNote, rendered.replace(/\n$/, '\r\n'))
    await expect(copies.locate(vault, run, book, pickOriginal)).rejects.toThrow('does not match')
  })

  it('restricts picker and writes to a damaged staged source and a regular text original', async () => {
    const pick = vi.fn(pickOriginal)
    await expect(copies.locate(vault, run, 'Concept', pick)).rejects.toThrow('unavailable')
    await expect(copies.locate(vault, '../run-2', book, pick)).rejects.toThrow('unavailable')
    await expect(copies.locate(vault, run, originalPath, pick)).rejects.toThrow('unavailable')
    expect(pick).not.toHaveBeenCalled()

    const different = join(fixture, 'different.txt')
    writeFileSync(different, damaged)
    await expect(copies.locate(vault, run, book, async () => different)).rejects.toThrow('already contains the damaged text')
    const symlink = join(fixture, 'link.txt')
    symlinkSync(originalPath, symlink)
    await expect(copies.locate(vault, run, book, async () => symlink)).rejects.toThrow('regular text file')
    await expect(copies.locate(vault, run, book, async () => join(fixture, 'book.pdf'))).rejects.toThrow('text or Markdown')

    writeFileSync(sourceNote, 'This healthy text contains a literal � example.')
    expect(copies.status(vault, run, book)).toBeUndefined()
    await expect(copies.locate(vault, run, book, pick)).rejects.toThrow('unavailable')
    expect(pick).not.toHaveBeenCalled()
  })

  it('invalidates previews on overlapping picks, a vault close, a run edit, or cancellation', async () => {
    let finish!: (value: string) => void
    const pending = copies.locate(vault, run, book, () => new Promise((resolve) => { finish = resolve }))
    const auto = await copies.locate(vault, run, book, pickOriginal)
    finish(originalPath)
    await expect(pending).resolves.toBeNull()
    const chosen = copies.choose(auto!.id, 'windows-1251')

    writeFileSync(sourceNote, damaged + 'Changed')
    expect(() => copies.save(chosen.id)).toThrow('staged source changed')
    writeFileSync(sourceNote, damaged)
    copies.clear()
    expect(() => copies.save(chosen.id)).toThrow('preview is no longer available')

    const other = await copies.locate(vault, run, book, pickOriginal)
    const manual = copies.choose(other!.id, 'invalid')
    expect(manual.error).toBeTruthy()
    const retry = copies.choose(manual.id, 'windows-1251')
    expect(retry.preview).toBe(text)
    copies.discard(retry.id)
    expect(() => copies.save(retry.id)).toThrow('preview is no longer available')
  })
})
