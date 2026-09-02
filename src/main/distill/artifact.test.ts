import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertRunId,
  runDir,
  sourceNoteName,
  planRunFiles,
  writeRunArtifact,
  listRuns,
  removeRun,
  mergeRun,
  unmergeRun,
  readMergeManifest,
  readRunMeta
} from './artifact'
import { emitNotes } from './emit'
import type { GroundedNote } from './extract'

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})
function tmpVault(): string {
  root = mkdtempSync(join(tmpdir(), 'distill-'))
  return root
}

const grounded = (): GroundedNote[] => [
  {
    kind: 'concept',
    title: 'Faction',
    summary: 's',
    links: [{ relation: 'contrasts_with', target: 'Union' }],
    citations: [{ file: 'Federalist.md', chunkId: 1, start: 0, end: 7, quote: 'Faction' }]
  },
  {
    kind: 'claim',
    title: 'Union',
    summary: 's',
    links: [],
    citations: [{ file: 'Federalist.md', chunkId: 2, start: 20, end: 25, quote: 'Union' }]
  }
]

describe('assertRunId', () => {
  it('accepts safe single-segment ids', () => {
    for (const ok of ['fed-themes', 'sapiens v2', 'run.1', 'A']) expect(() => assertRunId(ok)).not.toThrow()
  })
  it('rejects traversal / separators / dotfiles', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', 'a..b', '']) expect(() => assertRunId(bad)).toThrow()
  })
})

describe('paths', () => {
  it('places a run under the ignored .nodebook dot-dir', () => {
    expect(runDir('/vault', 'r1')).toBe(join('/vault', '.nodebook', 'distill', 'r1'))
  })
  it('derives the source note name from a path', () => {
    expect(sourceNoteName('books/Federalist.md')).toBe('Federalist')
  })
  it('shortens a library-dump filename the same way emit.ts shortens the source:: link target — so it resolves', () => {
    const dump =
      "Options, Futures, and Other Derivatives__ Solutions Manual -- Hull J_ -- 11, 2021 -- Pearson -- 80e6709029281e474d6c1fe3767907a0 -- Anna's Archive.pdf"
    expect(sourceNoteName(dump)).toBe('Options, Futures, and Other Derivatives Solutions Manual — Hull J')
  })
})

describe('planRunFiles', () => {
  it('lists the source note, each emitted note, and meta.json', () => {
    const files = planRunFiles({ file: 'Federalist.md', text: 'x' }, emitNotes(grounded()))
    const rels = files.map((f) => f.relPath)
    expect(rels).toContain(join('notes', 'Federalist.md'))
    expect(rels).toContain(join('notes', 'Faction.md'))
    expect(rels).toContain(join('notes', 'Union.md'))
    expect(rels).toContain('meta.json')
    expect(JSON.parse(files.at(-1)!.content)).toMatchObject({ source: 'Federalist.md', notes: 2 })
  })

  it('persists run stats into meta.json when given (diagnosable after the banner)', () => {
    const stats = { chunks: 10, notes: 2, dropped: 3, failedClusters: 1 }
    const files = planRunFiles({ file: 'Federalist.md', text: 'x' }, emitNotes(grounded()), stats)
    expect(JSON.parse(files.at(-1)!.content)).toMatchObject({ notes: 2, stats })
  })

  it('BACKSTOP: refuses to write an emitted note over the source note', () => {
    // emitNotes reserves the source name; if a caller forgets, planRunFiles must
    // not silently plan two files at the same path (the book would be lost).
    const collide = emitNotes([{ ...grounded()[0], title: 'Federalist' }])
    expect(() => planRunFiles({ file: 'Federalist.md', text: 'x' }, collide)).toThrow(
      /would overwrite the source note/
    )
    // With the reservation in place the concept is simply suffixed.
    const ok = emitNotes([{ ...grounded()[0], title: 'Federalist' }], { reserved: ['Federalist'] })
    expect(() => planRunFiles({ file: 'Federalist.md', text: 'x' }, ok)).not.toThrow()
  })

  it('names the book file by the short title (matching the source:: target); meta.source keeps the raw identifier', () => {
    const dump = "Options, Futures, and Other Derivatives__ Solutions Manual -- Hull J_ -- Anna's Archive.pdf"
    const shortName = 'Options, Futures, and Other Derivatives Solutions Manual — Hull J'
    const files = planRunFiles({ file: dump, text: 'x' }, emitNotes(grounded()))
    expect(files.map((f) => f.relPath)).toContain(join('notes', `${shortName}.md`))
    expect(JSON.parse(files.at(-1)!.content)).toMatchObject({ source: dump })
  })
})

describe('readRunMeta', () => {
  it('round-trips meta.json (with stats) and is null for a missing run', () => {
    const v = tmpVault()
    const stats = { chunks: 5, notes: 0, dropped: 5, failedClusters: 0 }
    writeRunArtifact(v, 'r1', { file: 'B.md', text: 'x' }, [], stats)
    expect(readRunMeta(v, 'r1')).toMatchObject({ source: 'B.md', notes: 0, stats })
    expect(readRunMeta(v, 'no-such-run')).toBeNull()
  })

  it('still reads a pre-stats meta.json (stats simply absent)', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r1', { file: 'B.md', text: 'x' }, [])
    const m = readRunMeta(v, 'r1')
    expect(m).toMatchObject({ source: 'B.md', notes: 0 })
    expect(m!.stats).toBeUndefined()
  })
})

describe('writeRunArtifact', () => {
  it('writes notes under the run dir and returns the note paths', () => {
    const v = tmpVault()
    const { dir, notePaths } = writeRunArtifact(v, 'r1', { file: 'Federalist.md', text: 'Faction vs Union.' }, emitNotes(grounded()))
    expect(existsSync(join(dir, 'notes', 'Faction.md'))).toBe(true)
    expect(existsSync(join(dir, 'notes', 'Federalist.md'))).toBe(true)
    expect(existsSync(join(dir, 'meta.json'))).toBe(true)
    expect(notePaths).toHaveLength(3) // source + 2 emitted; meta.json is not a note
    expect(readFileSync(join(dir, 'notes', 'Faction.md'), 'utf8')).toContain('contrasts_with:: [[Union]]')
  })

  it('FIREWALL: the run is invisible to a canonical vault scan (dot-dir skip)', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r1', { file: 'Federalist.md', text: 'Faction.' }, emitNotes(grounded()))
    expect(canonicalMarkdown(v)).toEqual([]) // a scan skipping dotdirs finds nothing
  })

  it('replacing a run id starts fresh', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r', { file: 'B.md', text: 'x' }, emitNotes(grounded()))
    writeRunArtifact(v, 'r', { file: 'B.md', text: 'x' }, []) // no emitted notes this time
    expect(existsSync(join(runDir(v, 'r'), 'notes', 'Faction.md'))).toBe(false)
  })
})

describe('listRuns / removeRun', () => {
  it('lists and removes runs', () => {
    const v = tmpVault()
    expect(listRuns(v)).toEqual([])
    writeRunArtifact(v, 'a', { file: 'B.md', text: 'x' }, [])
    writeRunArtifact(v, 'b', { file: 'B.md', text: 'x' }, [])
    expect(listRuns(v)).toEqual(['a', 'b'])
    removeRun(v, 'a')
    expect(listRuns(v)).toEqual(['b'])
  })
})

describe('mergeRun / unmergeRun (reversible promote)', () => {
  const run = (v: string): void => {
    writeRunArtifact(v, 'sapiens', { file: 'Sapiens.md', text: 'x' }, emitNotes(grounded()))
  }
  /** Undo with a trash that just records what it was asked to move. */
  const recordingTrash = (): { calls: string[]; trash: (p: string) => Promise<void> } => {
    const calls: string[] = []
    return {
      calls,
      trash: async (p) => {
        calls.push(p)
        rmSync(p, { force: true }) // stand-in for the system Trash
      }
    }
  }
  const manifestFile = (v: string): string =>
    join(v, '.nodebook', 'distill', 'sapiens', 'merge.json')

  it('copies the run notes into a namespaced vault folder + records a manifest', () => {
    const v = tmpVault()
    run(v)
    expect(canonicalMarkdown(v)).toEqual([]) // staged run is hidden (the firewall)
    const { manifest, written } = mergeRun(v, 'sapiens')
    expect(manifest.folder).toBe(join('Distilled', 'sapiens'))
    expect(manifest.complete).toBe(true)
    // Now the notes live in the vault proper — a canonical scan sees them.
    expect(canonicalMarkdown(v).length).toBe(manifest.files.length)
    expect(existsSync(join(v, 'Distilled', 'sapiens', 'Faction.md'))).toBe(true)
    expect(written).toHaveLength(manifest.files.length)
    expect(readMergeManifest(v, 'sapiens')).toEqual(manifest)
    // Every entry carries the hash of the bytes actually on disk.
    for (const f of manifest.files) {
      expect(f.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(f.path.startsWith(join('Distilled', 'sapiens'))).toBe(true)
    }
  })

  it('MANIFEST FIRST: a merge that dies before copying still leaves an undoable record', () => {
    const v = tmpVault()
    run(v)
    // A file where the target folder should be: mkdir fails, so no note is copied.
    mkdirSync(join(v, 'Distilled'), { recursive: true })
    writeFileSync(join(v, 'Distilled', 'sapiens'), 'in the way')
    expect(() => mergeRun(v, 'sapiens')).toThrow()
    const m = readMergeManifest(v, 'sapiens')
    expect(m).not.toBeNull()
    expect(m!.complete).toBe(false) // "merged" is false until the copy finishes
    expect(m!.files.length).toBeGreaterThan(0) // …but it names everything to undo
  })

  it('undo deletes exactly what it wrote, the empty folder, and the manifest', async () => {
    const v = tmpVault()
    run(v)
    const { written } = mergeRun(v, 'sapiens')
    const t = recordingTrash()
    const { removed, trashed } = await unmergeRun(v, 'sapiens', t.trash)
    expect(removed.sort()).toEqual([...written].sort())
    expect(trashed).toEqual([]) // nothing was edited — nothing needs saving
    expect(t.calls).toEqual([])
    expect(canonicalMarkdown(v)).toEqual([]) // fully reversed
    expect(existsSync(join(v, 'Distilled', 'sapiens'))).toBe(false)
    expect(readMergeManifest(v, 'sapiens')).toBeNull()
  })

  it('undo TRASHES a note you edited after merging, and skips one already gone', async () => {
    const v = tmpVault()
    run(v)
    mergeRun(v, 'sapiens')
    const edited = join(v, 'Distilled', 'sapiens', 'Faction.md')
    writeFileSync(edited, readFileSync(edited, 'utf8') + '\n\nMy own note.\n')
    rmSync(join(v, 'Distilled', 'sapiens', 'Union.md'), { force: true }) // vanished
    const t = recordingTrash()
    const { removed, trashed } = await unmergeRun(v, 'sapiens', t.trash)
    expect(trashed).toEqual([edited])
    expect(t.calls).toEqual([edited])
    expect(removed).not.toContain(edited)
    expect(removed.some((p) => p.endsWith('Union.md'))).toBe(false) // skipped, not "removed"
  })

  it('undo trashes a legacy (hash-less) entry rather than deleting it', async () => {
    const v = tmpVault()
    run(v)
    const { manifest } = mergeRun(v, 'sapiens')
    // Rewrite the manifest in the pre-hash shape (files: string[]).
    writeFileSync(
      manifestFile(v),
      JSON.stringify({ folder: manifest.folder, files: manifest.files.map((f) => f.path) })
    )
    const legacy = readMergeManifest(v, 'sapiens')!
    expect(legacy.complete).toBe(true) // legacy manifests are complete by definition
    expect(legacy.files.every((f) => f.hash === undefined)).toBe(true)
    const t = recordingTrash()
    const { removed, trashed } = await unmergeRun(v, 'sapiens', t.trash)
    expect(removed).toEqual([])
    expect(trashed).toHaveLength(legacy.files.length) // unverifiable → recoverable
  })

  it('REJECTS a manifest that escapes the merge folder or names another folder', async () => {
    const v = tmpVault()
    run(v)
    const { manifest } = mergeRun(v, 'sapiens')
    const escaping = {
      ...manifest,
      files: [...manifest.files, { path: join('..', '..', 'etc', 'passwd'), hash: 'x' }]
    }
    writeFileSync(manifestFile(v), JSON.stringify(escaping))
    expect(readMergeManifest(v, 'sapiens')).toBeNull()
    // …so undo does nothing at all rather than deleting the listed paths.
    const t = recordingTrash()
    expect(await unmergeRun(v, 'sapiens', t.trash)).toEqual({ removed: [], trashed: [] })
    expect(existsSync(join(v, 'Distilled', 'sapiens', 'Faction.md'))).toBe(true)

    writeFileSync(manifestFile(v), JSON.stringify({ ...manifest, folder: join('Distilled', 'other') }))
    expect(readMergeManifest(v, 'sapiens')).toBeNull()
    writeFileSync(manifestFile(v), JSON.stringify({ ...manifest, files: [{ hash: 'x' }] }))
    expect(readMergeManifest(v, 'sapiens')).toBeNull()
  })

  it('reports merge status (null until merged)', () => {
    const v = tmpVault()
    run(v)
    expect(readMergeManifest(v, 'sapiens')).toBeNull()
    mergeRun(v, 'sapiens')
    expect(readMergeManifest(v, 'sapiens')?.folder).toBe(join('Distilled', 'sapiens'))
  })
})

/** Walk a vault the way scanVault/chokidar do — skipping any dot-prefixed entry. */
function canonicalMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...canonicalMarkdown(full))
    else if (e.name.endsWith('.md')) out.push(full)
  }
  return out
}
