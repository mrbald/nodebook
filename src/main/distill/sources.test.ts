import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync, symlinkSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  sha1,
  sourcesDir,
  sourceTextPath,
  assertSourceHash,
  readSourceIndex,
  readSourceRecord,
  readSourceText,
  originalPathOf,
  putSource,
  cachedSource,
  prepareSource,
  publishSource,
  bindPickedSource,
  readPickedSource
} from './sources'
import { convertDocumentWithCoverage } from './convert'

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function tmpVault(): string {
  root = mkdtempSync(join(tmpdir(), 'sources-'))
  return root
}

/** A document file in the vault's parent, as if the user had picked it. */
function document(vault: string, name: string, bytes: string | Uint8Array = 'the original bytes'): string {
  const dir = join(vault, 'originals')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

async function approveSource(...args: Parameters<typeof prepareSource>): ReturnType<typeof prepareSource> {
  return publishSource(args[0], await prepareSource(...args))
}

describe('sha1 / assertSourceHash', () => {
  it('is stable, and different for different text', () => {
    expect(sha1('hello')).toBe(sha1('hello'))
    expect(sha1('hello')).not.toBe(sha1('hellp'))
    expect(sha1('hello')).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses anything that is not a hash — it is also a path segment', () => {
    expect(() => assertSourceHash(sha1('x'))).not.toThrow()
    for (const bad of ['', '..', '../etc/passwd', 'ABCDEF', 'z'.repeat(40)])
      expect(() => assertSourceHash(bad)).toThrow(/invalid source hash/)
    expect(() => sourceTextPath('/v', '../../etc/passwd')).toThrow()
  })
})

describe('putSource', () => {
  it('stores the converted text once, addressed by its content', () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const stored = putSource(v, original, 'converted text')

    expect(stored.hash).toBe(sha1('converted text'))
    expect(readFileSync(join(sourcesDir(v), `${stored.hash}.md`), 'utf8')).toBe('converted text')
    expect(readSourceText(v, stored.hash)).toBe('converted text')
  })

  it('records where the document came from, what it is called, and its format', () => {
    const v = tmpVault()
    const original = document(v, 'Sapiens -- Harari -- 2011.epub', 'x'.repeat(42))
    const { hash } = putSource(v, original, 'converted')
    const record = readSourceRecord(v, hash)!

    expect(record.originalPath).toBe(original)
    expect(record.title).toBe('Sapiens — Harari') // emit.sourceTitle, so links resolve
    expect(record.format).toBe('epub')
    expect(record.size).toBe(42)
    expect(record.mtime).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(record.convertedAt))).toBe(false)
  })

  it('keeps one entry per document and one file per text', () => {
    const v = tmpVault()
    const a = putSource(v, document(v, 'A.md'), 'same text')
    const b = putSource(v, document(v, 'B.md'), 'same text')
    expect(b.hash).toBe(a.hash)
    expect(readSourceIndex(v).size).toBe(1)
    // The record follows the latest path — that is what "Open original" needs.
    expect(readSourceRecord(v, a.hash)!.originalPath).toMatch(/B\.md$/)
  })
})

describe('cachedSource', () => {
  it('reuses the stored text while the file is unchanged', () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const stored = putSource(v, original, 'converted once')
    const cached = cachedSource(v, original)!
    expect(cached.hash).toBe(stored.hash)
    expect(cached.text).toBe('converted once')
    expect(cached.cached).toBe(true)
  })

  it('misses when the file changed, was never stored, or the text is gone', () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const stored = putSource(v, original, 'converted once')

    expect(cachedSource(v, join(v, 'originals', 'Other.pdf'))).toBeNull()

    // Same size, new mtime — an edit the byte count happens not to change.
    const later = new Date(Date.now() + 60_000)
    utimesSync(original, later, later)
    expect(cachedSource(v, original)).toBeNull()

    // The store lost the text: the record alone is not a cache hit.
    utimesSync(original, new Date(stored.record.mtime), new Date(stored.record.mtime))
    rmSync(sourceTextPath(v, stored.hash))
    expect(cachedSource(v, original)).toBeNull()
  })
})

describe('prepare and publish source', () => {
  it('converts once and reuses the result for an unchanged file', async () => {
    const v = tmpVault()
    const original = document(v, 'Book.docx')
    let calls = 0
    const convert = async () => {
      calls++
      return { text: 'converted text' }
    }

    const first = await approveSource(v, original, convert)
    const second = await approveSource(v, original, convert)
    expect(calls).toBe(1)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.hash).toBe(first.hash)
  })

  it('refreshes a legacy PDF conversion once and caches page accounting', async () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    putSource(v, original, 'old text')
    const pdf = { pages: 3, missing: [2] }
    const convert = async () => ({ text: 'new text', pdf })
    expect((await approveSource(v, original, convert)).cached).toBe(false)
    const again = await approveSource(v, original, convert)
    expect(again.cached).toBe(true)
    expect(again.record.pdf).toEqual(pdf)
  })

  it('refreshes a legacy text conversion and keeps historical citation text for both encodings', async () => {
    const v = tmpVault()
    const bytes = Buffer.from('<meta charset="windows-1251"><body><h1>\xCA\xED\xE8\xE3\xE0</h1></body>', 'latin1')
    const original = document(v, 'Book.html', bytes)
    const { hash: oldHash } = putSource(v, original, '# �����')

    const detected = await approveSource(v, original, convertDocumentWithCoverage)
    expect(detected.cached).toBe(false)
    expect(detected.text).toBe('# Книга')
    expect(detected.record.encoding).toEqual({ name: 'windows-1251', uncertain: false })

    const override = await approveSource(v, original, convertDocumentWithCoverage, { encoding: 'windows-1252' })
    expect(override.cached).toBe(false)
    expect(override.text).toBe('# Êíèãà')
    expect(override.hash).not.toBe(detected.hash)
    expect(override.record.encoding?.name).toBe('windows-1252')

    const autoAgain = await approveSource(v, original, convertDocumentWithCoverage)
    expect(autoAgain.cached).toBe(true)
    expect(autoAgain.hash).toBe(detected.hash)
    expect(readFileSync(original)).toEqual(bytes)
    expect(readSourceText(v, oldHash)).toBe('# �����')
    expect(readSourceText(v, detected.hash)).toBe('# Книга')
    expect(readSourceText(v, override.hash)).toBe('# Êíèãà')
  })

  it('keeps all preview choices out of the store and leaves matching historical provenance alone', async () => {
    const v = tmpVault()
    const previous = document(v, 'Previous.html')
    const old = putSource(v, previous, '# Книга')
    const index = join(v, '.distill', 'sources.json')
    const storedIndex = readFileSync(index, 'utf8')
    const bytes = Buffer.from('<meta charset="windows-1251"><body><h1>\xCA\xED\xE8\xE3\xE0</h1></body>', 'latin1')
    const original = document(v, 'Candidate.html', bytes)

    const automatic = await prepareSource(v, original, convertDocumentWithCoverage)
    const override = await prepareSource(v, original, convertDocumentWithCoverage, { encoding: 'windows-1252' })
    expect(automatic.hash).toBe(old.hash)
    expect(automatic.record.originalPath).toBe(original)
    expect(readFileSync(index, 'utf8')).toBe(storedIndex)
    expect(readSourceText(v, override.hash)).toBeNull()
    expect(originalPathOf(v, old.hash)).toBe(previous)

    publishSource(v, override)
    expect(readSourceText(v, override.hash)).toBe('# Êíèãà')
    expect(originalPathOf(v, override.hash)).toBe(original)
    expect(originalPathOf(v, old.hash)).toBe(previous)
  })

  it.each([
    ['empty', ''],
    ['BOM-only', Buffer.from([0xef, 0xbb, 0xbf])],
    ['whitespace-only', ' \t\r\n']
  ])('rejects a %s document before making any vault files', async (_label, bytes) => {
    const v = tmpVault()
    const original = document(v, 'Blank.md', bytes)
    await expect(prepareSource(v, original, convertDocumentWithCoverage)).rejects.toThrow('no readable text')
    expect(existsSync(join(v, '.distill'))).toBe(false)
  })

  it('recovers from an edited or corrupt cached document when picked again', async () => {
    const v = tmpVault()
    const original = document(v, 'Book.docx')
    const convert = async () => ({ text: 'original text' })
    const stored = await approveSource(v, original, convert)
    writeFileSync(sourceTextPath(v, stored.hash), 'incorrect text')
    expect(cachedSource(v, original)).toBeNull()
    expect((await approveSource(v, original, convert)).cached).toBe(false)
    expect(cachedSource(v, original)?.text).toBe('original text')
  })

  it('rejects a source replaced during conversion', async () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const convert = async () => {
      writeFileSync(original, 'replacement document with different pages')
      return { text: 'previous document', pdf: { pages: 1, missing: [] } }
    }
    await expect(prepareSource(v, original, convert)).rejects.toThrow('changed during conversion')
    expect(cachedSource(v, original)).toBeNull()
  })

  it('converts again once the file changes', async () => {
    const v = tmpVault()
    const original = document(v, 'Book.docx')
    let text = 'first conversion'
    let calls = 0
    const convert = async () => {
      calls++
      return { text }
    }

    const first = await approveSource(v, original, convert)
    writeFileSync(original, 'the original bytes, edited')
    text = 'second conversion'
    const second = await approveSource(v, original, convert)

    expect(calls).toBe(2)
    expect(second.hash).not.toBe(first.hash)
    expect(second.text).toBe('second conversion')
    // Both texts stay in the store — an older run still refers to the first.
    expect(existsSync(sourceTextPath(v, first.hash))).toBe(true)
  })
})

describe('picked source identity', () => {
  it('rejects a symlink retargeted after pick, even with a matching cache entry', async () => {
    const v = tmpVault()
    const first = document(v, 'First.txt')
    const second = document(v, 'Second.txt', 'a different file')
    const alias = join(v, 'Picked.txt')
    symlinkSync(first, alias)
    const picked = bindPickedSource(alias)!
    expect(readPickedSource(picked).toString()).toBe('the original bytes')

    rmSync(alias)
    symlinkSync(second, alias)
    await approveSource(v, alias, convertDocumentWithCoverage)
    await expect(prepareSource(v, alias, convertDocumentWithCoverage, { picked })).rejects.toThrow('replaced')
  })

  it('refuses a replacement at the previously selected real path', () => {
    const v = tmpVault()
    const original = document(v, 'Original.txt')
    const replacement = document(v, 'Replacement.txt')
    const picked = bindPickedSource(original)!
    renameSync(replacement, original)
    expect(() => readPickedSource(picked)).toThrow('replaced')
  })
})

describe('originalPathOf', () => {
  it('resolves a hash to a file that is still there, and nothing otherwise', () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const { hash } = putSource(v, original, 'converted')

    expect(originalPathOf(v, hash)).toBe(original)
    expect(originalPathOf(v, sha1('never stored'))).toBeNull()
    expect(originalPathOf(v, 'not a hash')).toBeNull()

    rmSync(original)
    expect(originalPathOf(v, hash)).toBeNull() // moved or deleted since
  })

  it('opens a document or nothing — the recorded path is not trusted blindly', () => {
    const v = tmpVault()
    const original = document(v, 'Book.pdf')
    const { hash } = putSource(v, original, 'converted')
    const index = join(v, '.distill', 'sources.json')
    const repoint = (to: string): void => {
      const raw = JSON.parse(readFileSync(index, 'utf8')) as Record<
        string,
        { originalPath: string }
      >
      raw[hash].originalPath = to
      writeFileSync(index, JSON.stringify(raw))
    }

    // `sources.json` is a plain file inside the vault, so it is editable — and
    // "Open original" hands whatever it says to the OS. Only a real file with a
    // document extension may come back.
    repoint(join(v, 'originals')) // a directory
    expect(originalPathOf(v, hash)).toBeNull()

    const script = document(v, 'payload.sh', '#!/bin/sh\nsay no\n')
    repoint(script) // a real file, but not a document
    expect(originalPathOf(v, hash)).toBeNull()

    repoint(original)
    expect(originalPathOf(v, hash)).toBe(original)
  })
})

describe('a damaged store', () => {
  it('reads as empty rather than throwing', () => {
    const v = tmpVault()
    mkdirSync(join(v, '.distill'), { recursive: true })
    writeFileSync(join(v, '.distill', 'sources.json'), '{ not json')
    expect(readSourceIndex(v).size).toBe(0)

    writeFileSync(join(v, '.distill', 'sources.json'), '{"nope": {"title": 1}}')
    expect(readSourceIndex(v).size).toBe(0)
    expect(readSourceText(v, sha1('x'))).toBeNull()
  })
})
