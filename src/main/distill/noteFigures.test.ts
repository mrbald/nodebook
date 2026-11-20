import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { figureMarkdown, figurePath, type CapturedFigure } from '../../shared/figures'
import { chunkMarkdown } from '../rag/chunk'
import {
  archivedFigureRunIds,
  beginRun,
  isUnfinishedRun,
  mergeRun,
  readRunSource,
  removeRun,
  runDir,
  sourceNoteName,
  unmergeRun,
  writeRunArtifact,
  type RunSource
} from './artifact'
import { renderDocumentNote, type EmittedNote } from './emit'
import { resolveNoteFigureBytes, resolveNoteFigures } from './noteFigures'
import { prepareSource, publishSource, sourcesDir, type PreparedSource } from './sources'

const vaults: string[] = []
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmioAAAAASUVORK5CYII=', 'base64')
const nextPage = 'See the attendance chart on the next page.'
const introduction = 'This report was published in December.'

function vault(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodebook-figures-'))
  vaults.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of vaults.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function figure(label: string, page: number, variant = ''): CapturedFigure {
  const bytes = Buffer.concat([pixel, Buffer.from(variant)])
  return {
    id: createHash('sha256').update(bytes).digest('hex'), ext: 'png', bytes, label,
    location: `Page ${page}`, caption: `${label} caption`, ocr: `${label} text`
  }
}

const attendance = figure('Attendance chart', 2)
const unrelated = figure('Registration trend', 4, 'alternate')

async function approve(v: string, file = 'Report.pdf', figures = [attendance, unrelated]): Promise<RunSource> {
  const originalPath = join(v, file)
  writeFileSync(originalPath, 'picked document')
  const text = `# Report\n\n## Page 1\n\n${introduction} ${nextPage}\n\n${figures.map((f) => `## ${f.location}\n\n${figureMarkdown(f)}`).join('\n\n')}`
  const prepared = await prepareSource(v, originalPath, async () => ({ text, figures, pdf: { pages: 4, missing: [] } }))
  return runSource(publishSource(v, prepared))
}

function runSource(source: PreparedSource): RunSource {
  return {
    file: basename(source.record.originalPath), text: source.text, hash: source.hash,
    originalPath: source.record.originalPath, figures: source.record.figures
  }
}

function concept(source: RunSource, quote: string, embed?: CapturedFigure): EmittedNote {
  const start = source.text.indexOf(quote)
  const index = chunkMarkdown(source.text).findIndex((chunk) => start >= chunk.start && start < chunk.end)
  const offset = renderDocumentNote(source).citeOffset
  return {
    fileName: 'Attendance.md', name: 'Attendance',
    content: `---\nkind: concept\nsource: ${sourceNoteName(source.file)}\ncite:\n  - chunk: ${index}\n    span: ${start + offset}-${start + quote.length + offset}\n    where: "Page 1"\n    quote: ${JSON.stringify(quote)}\n---\n\n${embed ? figureMarkdown(embed) : quote}\n`
  }
}

function report(v: string, id: string): string {
  return join(runDir(v, id), 'notes', 'Report.md')
}

describe('durable figure assets', () => {
  it('keeps previews and cancellation in memory and refreshes a damaged cached asset', async () => {
    const v = vault()
    const file = join(v, 'Report.pdf')
    writeFileSync(file, 'picked')
    const text = figureMarkdown(attendance)
    const convert = vi.fn(async () => ({ text, figures: [attendance], pdf: { pages: 2, missing: [] }, figureCoverage: { skipped: 1 } }))
    const preview = await prepareSource(v, file, convert)
    expect(existsSync(join(v, '.distill'))).toBe(false)
    const stopped = new AbortController()
    await expect(prepareSource(v, file, async (_path, _encoding, _read, signal) => {
      expect(signal).toBe(stopped.signal)
      stopped.abort()
      return convert()
    }, { signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(join(v, '.distill'))).toBe(false)
    publishSource(v, preview)
    const saved = join(sourcesDir(v), figurePath(attendance))
    expect(readFileSync(saved)).toEqual(attendance.bytes)
    const cached = await prepareSource(v, file, convert)
    expect(cached.cached).toBe(true)
    expect(cached.record.figureCoverage).toEqual({ skipped: 1 })
    expect(cached.record.figures?.[0]).not.toHaveProperty('bytes')
    expect(cached.capturedFigures).toBeUndefined()
    writeFileSync(saved, unrelated.bytes)
    const refreshed = await prepareSource(v, file, convert)
    expect(refreshed.cached).toBe(false)
    expect(refreshed.hash).toBe(preview.hash)
    publishSource(v, refreshed)
    expect(readFileSync(saved)).toEqual(attendance.bytes)
  })

  it('rechecks local HTML image dependencies on repeat import', async () => {
    const v = vault()
    const file = join(v, 'Local.html')
    writeFileSync(file, '<p>Changed separately</p><img src="chart.png">')
    let image = attendance
    const convert = vi.fn(async () => ({ text: figureMarkdown(image), figures: [image], externalImages: true as const }))
    const first = publishSource(v, await prepareSource(v, file, convert))
    image = unrelated
    const second = publishSource(v, await prepareSource(v, file, convert))
    expect(second.hash).not.toBe(first.hash)
    expect(convert).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(sourcesDir(v), figurePath(attendance)))).toEqual(attendance.bytes)
    expect(readFileSync(join(sourcesDir(v), figurePath(unrelated)))).toEqual(unrelated.bytes)
  })

  it('retains assets for a resumed detached run and matches citations to relevant figures', async () => {
    const v = vault()
    const source = await approve(v)
    const dir = beginRun(v, 'paused', source)
    expect(isUnfinishedRun(v, 'paused')).toBe(true)
    expect(readFileSync(join(dir, figurePath(attendance)))).toEqual(attendance.bytes)
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).not.toContain('"bytes"')
    rmSync(source.originalPath!)
    rmSync(sourcesDir(v), { recursive: true })
    const recovered = readRunSource(v, 'paused')!
    writeRunArtifact(v, 'paused', recovered, [concept(recovered, 'the attendance chart on the next')])
    expect(isUnfinishedRun(v, 'paused')).toBe(false)
    const book = report(v, 'paused')
    expect(readFileSync(book, 'utf8').slice(renderDocumentNote(source).citeOffset)).toBe(source.text)
    expect(readFileSync(join(dirname(book), figurePath(attendance)))).toEqual(attendance.bytes)
    expect((await resolveNoteFigures(v, book, 'paused')).map((f) => f.label)).toEqual(['Attendance chart', 'Registration trend'])
    const path = join(dirname(book), 'Attendance.md')
    expect((await resolveNoteFigures(v, path, 'paused')).map((f) => f.label)).toEqual(['Attendance chart'])
    expect(resolveNoteFigureBytes(v, path, attendance.id, 'paused')).toMatchObject({ bytes: Uint8Array.from(attendance.bytes), mime: 'image/png' })
    expect(resolveNoteFigureBytes(v, path, unrelated.id, 'paused')).toBeNull()
    writeFileSync(path, concept(recovered, introduction).content)
    expect(await resolveNoteFigures(v, path, 'paused')).toEqual([])
    removeRun(v, 'paused')
    expect(resolveNoteFigureBytes(v, path, attendance.id, 'paused')).toBeNull()
  })

  it('follows a numbered figure across pages only when its occurrence is unambiguous', async () => {
    const v = vault()
    const target = figure('Attendance', 3, 'chart 4')
    target.caption = 'Figure 4. Attendance totals'
    const near = figure('Table 4', 2)
    const far = figure('Figure 40', 4, 'chart 40')
    const originalPath = join(v, 'Numbered.pdf')
    writeFileSync(originalPath, 'picked')
    const text = `# Report\n\n## Page 1\n\nThe results are shown in Figure 4.\n\n${[near, target, far].map((ref) => `## ${ref.location}\n\n${figureMarkdown(ref)}`).join('\n\n')}`
    const source = runSource(publishSource(v, await prepareSource(v, originalPath, async () => ({ text, figures: [near, target, far] }))))
    writeRunArtifact(v, 'numbers', source, [concept(source, 'The results are shown')])
    const note = join(runDir(v, 'numbers'), 'notes', 'Attendance.md')
    expect((await resolveNoteFigures(v, note, 'numbers')).map((f) => f.label)).toEqual(['Attendance'])
  })

  it('keeps same-image occurrences distinct and stops citation context at the page boundary', async () => {
    const v = vault()
    const reused = { ...attendance, label: 'Historical attendance', location: 'Page 3' }
    const file = join(v, 'Bounded.pdf')
    writeFileSync(file, 'picked')
    const text = `## Page 1\n\nAttendance is shown by the chart\n\n## Page 2\n\non the next page.\n\n${figureMarkdown(attendance)}\n\n## Page 3\n\n${figureMarkdown(reused)}`
    const source = runSource(publishSource(v, await prepareSource(v, file, async () => ({ text, figures: [attendance, reused] }))))
    writeRunArtifact(v, 'bounded', source, [concept(source, 'Attendance is shown by the chart')])
    const notes = join(runDir(v, 'bounded'), 'notes')
    expect(await resolveNoteFigures(v, join(notes, 'Attendance.md'), 'bounded')).toEqual([])
    const book = join(notes, 'Bounded.md')
    expect((await resolveNoteFigures(v, book, 'bounded')).map((ref) => ref.location)).toEqual(['Page 2', 'Page 3'])
    expect(resolveNoteFigureBytes(v, book, attendance.id, 'bounded', reused)?.ref.location).toBe('Page 3')
    expect(resolveNoteFigureBytes(v, book, attendance.id, 'bounded', { ...reused, location: 'Page 8' })).toBeNull()
  })

  it('projects standard relative links into Sources and Distilled and keeps shared assets until the final undo', async () => {
    const v = vault()
    const source = await approve(v)
    for (const id of ['first', 'second']) {
      writeRunArtifact(v, id, source, [concept(source, nextPage, attendance)])
      mergeRun(v, id)
    }
    const book = join(v, 'Sources', 'Report.md')
    const first = join(v, 'Distilled', 'first', 'Attendance.md')
    const second = join(v, 'Distilled', 'second', 'Attendance.md')
    const asset = join(dirname(book), figurePath(attendance))
    for (const note of [book, first, second]) {
      expect(readFileSync(note, 'utf8')).toContain(figurePath(attendance))
      expect(readFileSync(join(dirname(note), figurePath(attendance)))).toEqual(attendance.bytes)
      expect(resolveNoteFigureBytes(v, note, attendance.id)).not.toBeNull()
    }
    const trash = vi.fn(async () => {})
    await unmergeRun(v, 'first', trash)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(asset)).toBe(true)
    expect(resolveNoteFigureBytes(v, second, attendance.id)).not.toBeNull()
    await unmergeRun(v, 'second', trash)
    expect(existsSync(asset)).toBe(false)
    expect(trash).not.toHaveBeenCalled()
  })

  it('keeps approved provenance for merged notes whose stage was discarded', async () => {
    const v = vault()
    const source = await approve(v)
    for (const id of ['discarded', 'undoable']) {
      writeRunArtifact(v, id, source, [concept(source, nextPage)])
      mergeRun(v, id)
    }
    removeRun(v, 'discarded')
    rmSync(source.originalPath!)
    await unmergeRun(v, 'undoable', async () => {})
    rmSync(sourcesDir(v), { recursive: true })
    expect(archivedFigureRunIds(v)).toEqual(['discarded'])
    const note = join(v, 'Distilled', 'discarded', 'Attendance.md')
    expect((await resolveNoteFigures(v, note)).map((f) => f.label)).toEqual(['Attendance chart'])
    expect(resolveNoteFigureBytes(v, note, attendance.id)).not.toBeNull()
  })

  it('recognizes renamed book and claim receipts after the stage and original are removed', async () => {
    const v = vault()
    const source = await approve(v)
    writeRunArtifact(v, 'relocated', source, [concept(source, nextPage)])
    mergeRun(v, 'relocated')
    const oldBook = join(v, 'Sources', 'Report.md')
    const oldClaim = join(v, 'Distilled', 'relocated', 'Attendance.md')
    const book = join(dirname(oldBook), 'Renamed report.md')
    const claim = join(dirname(oldClaim), 'Renamed claim.md')
    renameSync(oldBook, book)
    renameSync(oldClaim, claim)
    removeRun(v, 'relocated')
    rmSync(source.originalPath!)
    const impostor = join(dirname(claim), 'Attendance.md')
    const wrongSource = concept(source, nextPage).content.replace('source: Report', 'source: Another report')
    writeFileSync(impostor, wrongSource)
    expect((await resolveNoteFigures(v, book)).map((f) => f.label)).toEqual(['Attendance chart', 'Registration trend'])
    expect((await resolveNoteFigures(v, claim)).map((f) => f.label)).toEqual(['Attendance chart'])
    expect(await resolveNoteFigures(v, impostor)).toEqual([])
  })

  it('keeps local assets linked by a renamed or ordinary note after undo', async () => {
    const v = vault()
    const source = await approve(v)
    writeRunArtifact(v, 'retained', source, [concept(source, nextPage, attendance)])
    mergeRun(v, 'retained')
    const oldBook = join(v, 'Sources', 'Report.md')
    const book = join(dirname(oldBook), 'Retained report.md')
    renameSync(oldBook, book)
    const notes = join(v, 'Distilled', 'retained')
    const ordinary = join(notes, 'Summary.md')
    writeFileSync(ordinary, `# Summary\n\n![My local chart](./${figurePath(attendance)})`)
    const trash = vi.fn(async () => {})
    await unmergeRun(v, 'retained', trash)
    expect(existsSync(join(notes, 'Attendance.md'))).toBe(false)
    expect(readFileSync(join(dirname(book), figurePath(attendance)))).toEqual(attendance.bytes)
    expect(readFileSync(join(notes, figurePath(attendance)))).toEqual(attendance.bytes)
    expect((await resolveNoteFigures(v, book)).map((f) => f.label)).toEqual(['Attendance chart', 'Registration trend'])
    expect(await resolveNoteFigures(v, ordinary)).toEqual([{ id: attendance.id, ext: 'png', label: 'My local chart', location: 'Summary' }])
    expect(resolveNoteFigureBytes(v, ordinary, attendance.id)?.bytes).toEqual(Uint8Array.from(attendance.bytes))
    expect(trash).not.toHaveBeenCalled()
  })

  it('rejects unrelated paths, symlinks, forged figure bytes, and conflicting merge targets', async () => {
    const v = vault()
    const source = await approve(v)
    const legacy = { file: 'Legacy.md', text: figureMarkdown(attendance) }
    writeRunArtifact(v, 'legacy', legacy, [])
    expect(await resolveNoteFigures(v, join(runDir(v, 'legacy'), 'notes', 'Legacy.md'), 'legacy')).toEqual([])
    writeRunArtifact(v, 'run', source, [concept(source, nextPage)])
    const book = report(v, 'run')
    const other = join(v, 'Other.md')
    writeFileSync(other, readFileSync(book))
    expect(await resolveNoteFigures(v, other)).toEqual([])
    expect(await resolveNoteFigures(v, book, '../run')).toEqual([])
    expect(await resolveNoteFigures(v, book)).toEqual([])
    const asset = join(dirname(book), figurePath(attendance))
    const unscoped = join(vault(), 'Some.png')
    writeFileSync(unscoped, attendance.bytes)
    rmSync(asset)
    symlinkSync(unscoped, asset)
    expect(resolveNoteFigureBytes(v, book, attendance.id, 'run')).toBeNull()
    rmSync(asset)
    writeFileSync(asset, unrelated.bytes)
    expect((await resolveNoteFigures(v, book, 'run')).map((f) => f.label)).toEqual(['Registration trend'])
    expect(resolveNoteFigureBytes(v, book, attendance.id, 'run')).toBeNull()
    writeFileSync(asset, attendance.bytes)
    expect((await resolveNoteFigures(v, book, 'run')).map((f) => f.label)).toEqual(['Attendance chart', 'Registration trend'])
    const canonicalAsset = join(v, 'Sources', figurePath(attendance))
    mkdirSync(dirname(canonicalAsset), { recursive: true })
    writeFileSync(canonicalAsset, 'collision')
    expect(() => mergeRun(v, 'run')).toThrow('already occupies')
    expect(readFileSync(canonicalAsset, 'utf8')).toBe('collision')
    expect(existsSync(join(v, 'Sources', 'Report.md'))).toBe(false)
    writeFileSync(canonicalAsset, attendance.bytes)
    mergeRun(v, 'run')
    await unmergeRun(v, 'run', async () => {})
    expect(readFileSync(canonicalAsset)).toEqual(attendance.bytes)
  })

  it('never traverses a symlinked figure directory while serving, merging, or undoing', async () => {
    const v = vault()
    const source = await approve(v)
    writeRunArtifact(v, 'run', source, [concept(source, nextPage)])
    const canonicalDir = join(v, 'Sources', 'figures')
    const outside = vault()
    const external = join(outside, basename(figurePath(attendance)))
    writeFileSync(external, attendance.bytes)
    mkdirSync(dirname(canonicalDir))
    symlinkSync(outside, canonicalDir)
    expect(() => mergeRun(v, 'run')).toThrow('Figure folder is unavailable')
    rmSync(canonicalDir)
    mergeRun(v, 'run')
    rmSync(canonicalDir, { recursive: true })
    symlinkSync(outside, canonicalDir)
    expect(await resolveNoteFigures(v, join(v, 'Sources', 'Report.md'))).toEqual([])
    const trash = vi.fn(async () => {})
    await unmergeRun(v, 'run', trash)
    expect(readFileSync(external)).toEqual(attendance.bytes)
    expect(trash).not.toHaveBeenCalled()
  })

  it('verifies figure digests on the first inventory of a cold vault', async () => {
    const v = vault()
    const source = await approve(v)
    writeRunArtifact(v, 'run', source, [])
    mergeRun(v, 'run')
    const reopened = vault()
    // A fresh path has no verified revision in main, as after a restart.
    cpSync(v, reopened, { recursive: true })
    const book = join(reopened, 'Sources', 'Report.md')
    const asset = join(dirname(book), figurePath(attendance))
    const changed = readFileSync(asset)
    changed[changed.length - 1] ^= 1
    writeFileSync(asset, changed)
    expect((await resolveNoteFigures(reopened, book)).map((ref) => ref.label)).toEqual(['Registration trend'])
    writeFileSync(asset, attendance.bytes)
    expect((await resolveNoteFigures(reopened, book)).map((ref) => ref.label)).toEqual(['Attendance chart', 'Registration trend'])
  })
})
