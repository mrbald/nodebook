import { describe, it, expect, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync
} from 'fs'
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
  readRunMeta,
  beginRun,
  readRunJson,
  readRunSource,
  isUnfinishedRun,
  checkpointStore,
  readRunNotes,
  readStagedNote,
  legacyDistillRoot,
  migrateDistillRuns
} from './artifact'
import { ignoredInVault } from '../paths'
import { mergePlan } from './mergePlan'
import { emitNotes, renderDocumentNote } from './emit'
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
  it('places a run under the ignored .distill dot-dir (durable staging, still firewalled)', () => {
    expect(runDir('/vault', 'r1')).toBe(join('/vault', '.distill', 'r1'))
    expect(ignoredInVault('/vault')(join('/vault', '.distill', 'r1', 'notes', 'A.md'))).toBe(true)
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
  const run = (v: string, id = 'sapiens', text = 'Faction vs Union.'): void => {
    void writeRunArtifact(v, id, { file: 'Sapiens.md', text }, emitNotes(grounded()))
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
    join(v, '.distill', 'sapiens', 'merge.json')

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
      const inRun = f.path.startsWith(join('Distilled', 'sapiens'))
      // …and lands in the run's folder, except the book, which is shared.
      expect(inRun || f.path.startsWith('Sources')).toBe(true)
      expect(inRun).toBe(f.action !== 'shared')
    }
  })

  it('writes the document itself once, under Sources/', () => {
    const v = tmpVault()
    run(v)
    const { manifest } = mergeRun(v, 'sapiens')
    const book = manifest.files.find((f) => f.action === 'shared')
    expect(book!.path).toBe(join('Sources', 'Sapiens.md'))
    expect(existsSync(join(v, 'Sources', 'Sapiens.md'))).toBe(true)
    expect(existsSync(join(v, 'Distilled', 'sapiens', 'Sapiens.md'))).toBe(false)
    // The book note declares what it is, so the index can treat it as a document.
    expect(readFileSync(join(v, 'Sources', 'Sapiens.md'), 'utf8')).toMatch(
      /^---\nkind: document\n/
    )
  })

  it('a second run of the same document shares the one copy', () => {
    const v = tmpVault()
    run(v)
    run(v, 'sapiens-2')
    mergeRun(v, 'sapiens')
    const before = readFileSync(join(v, 'Sources', 'Sapiens.md'))
    const { manifest, written } = mergeRun(v, 'sapiens-2')
    // Same bytes already there: recorded as shared, not written again.
    expect(manifest.files.find((f) => f.action === 'shared')!.path).toBe(
      join('Sources', 'Sapiens.md')
    )
    expect(written.some((p) => p.includes('Sources'))).toBe(false)
    expect(readFileSync(join(v, 'Sources', 'Sapiens.md'))).toEqual(before)
    expect(readdirSync(join(v, 'Sources'))).toEqual(['Sapiens.md'])
  })

  it('undo leaves the shared document while another run still points at it', async () => {
    const v = tmpVault()
    run(v)
    run(v, 'sapiens-2')
    mergeRun(v, 'sapiens')
    mergeRun(v, 'sapiens-2')
    await unmergeRun(v, 'sapiens-2', async () => {})
    expect(existsSync(join(v, 'Sources', 'Sapiens.md'))).toBe(true)
    // …and takes it once the last run lets go.
    await unmergeRun(v, 'sapiens', async () => {})
    expect(existsSync(join(v, 'Sources', 'Sapiens.md'))).toBe(false)
  })

  it('a different document with the same title lands beside it, and links follow', () => {
    const v = tmpVault()
    // Both runs distil a file called Federalist.md — different books, one title.
    const book = (id: string, text: string): void => {
      writeRunArtifact(v, id, { file: 'Federalist.md', text }, emitNotes(grounded()))
    }
    book('one', 'The first book.')
    book('two', 'A DIFFERENT book that shares a title.')
    mergeRun(v, 'one')
    const { manifest } = mergeRun(v, 'two')
    expect(manifest.files.find((f) => f.action === 'shared')!.path).toBe(
      join('Sources', 'Federalist 2.md')
    )
    // Nothing of the first merge was overwritten…
    expect(readFileSync(join(v, 'Sources', 'Federalist.md'), 'utf8')).toContain('The first book.')
    // …and the second run's notes point at the copy that is actually theirs.
    expect(readFileSync(join(v, 'Distilled', 'two', 'Faction.md'), 'utf8')).toContain(
      'source:: [[Federalist 2]]'
    )
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

describe('readRunNotes / readStagedNote (readable staging)', () => {
  it('lists every staged note with its hash, source copy included', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r1', { file: 'Federalist.md', text: 'Faction vs Union.' }, emitNotes(grounded()))
    const notes = readRunNotes(v, 'r1')
    expect(notes.map((n) => n.name).sort()).toEqual(['Faction', 'Federalist', 'Union'])
    for (const n of notes) expect(n.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(notes.find((n) => n.name === 'Federalist')!.content).toBe(
      renderDocumentNote({ text: 'Faction vs Union.' }).content
    )
  })

  it('reads one note by name, and refuses to escape the run\'s notes dir', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r1', { file: 'Federalist.md', text: 'the book' }, emitNotes(grounded()))
    const book = renderDocumentNote({ text: 'the book' }).content
    expect(readStagedNote(v, 'r1', 'Federalist')).toBe(book)
    expect(readStagedNote(v, 'r1', 'Federalist.md')).toBe(book)
    expect(readStagedNote(v, 'r1', 'nope')).toBeNull()
    for (const evil of [join('..', '..', 'secret'), '/etc/passwd', '../../../etc/passwd'])
      expect(readStagedNote(v, 'r1', evil)).toBeNull()
  })
})

describe('mergeRun with a plan (converging merge)', () => {
  const staged = (v: string): void => {
    writeRunArtifact(v, 'sapiens', { file: 'Sapiens.md', text: 'x' }, emitNotes(grounded()))
  }
  const planFor = (v: string, vaultNames: Record<string, string>) =>
    mergePlan(
      readRunNotes(v, 'sapiens'),
      { names: new Set(Object.keys(vaultNames)), hashByName: new Map(Object.entries(vaultNames)) },
      'Sapiens'
    )

  it('a collision lands beside the vault note, never over it, with links re-pointed', () => {
    const v = tmpVault()
    staged(v)
    // Faction links to Union, so renaming Union must drag that link along.
    const before = readFileSync(join(v, '.distill', 'sapiens', 'notes', 'Faction.md'), 'utf8')
    expect(before).toContain('[[Union]]')

    const plan = planFor(v, { Union: 'different-bytes' })
    expect(plan.find((e) => e.name === 'Union')).toEqual({
      name: 'Union',
      action: 'collides',
      targetName: 'Union (Sapiens)'
    })
    const { manifest } = mergeRun(v, 'sapiens', plan)
    const folder = join(v, 'Distilled', 'sapiens')
    expect(existsSync(join(folder, 'Union (Sapiens).md'))).toBe(true)
    expect(existsSync(join(folder, 'Union.md'))).toBe(false)
    expect(readFileSync(join(folder, 'Faction.md'), 'utf8')).toContain(
      'contrasts_with:: [[Union (Sapiens)]]'
    )
    expect(manifest.files.find((f) => f.path.endsWith('Union (Sapiens).md'))?.action).toBe(
      'collides'
    )
  })

  it('an identical note is skipped — nothing written, and undo can never reach it', () => {
    const v = tmpVault()
    staged(v)
    const hash = readRunNotes(v, 'sapiens').find((n) => n.name === 'Faction')!.hash
    const plan = planFor(v, { Faction: hash })
    const { manifest, written } = mergeRun(v, 'sapiens', plan)
    expect(manifest.skipped).toEqual(['Faction'])
    expect(written.some((p) => p.includes('Faction'))).toBe(false)
    expect(manifest.files.every((f) => !f.path.endsWith('Faction.md'))).toBe(true)
  })

  it('a confirmed "same as" writes one same_as:: line after source::', () => {
    const v = tmpVault()
    staged(v)
    const plan = planFor(v, { Union: 'different-bytes' })
    mergeRun(v, 'sapiens', plan, { sameAs: ['Union'] })
    const merged = readFileSync(join(v, 'Distilled', 'sapiens', 'Union (Sapiens).md'), 'utf8')
    const lines = merged.split('\n')
    const src = lines.findIndex((l) => l.startsWith('source::'))
    expect(src).toBeGreaterThanOrEqual(0)
    expect(lines[src + 1]).toBe('same_as:: [[Union]]')
  })

  it('without a confirmation no same_as is written — a name clash is not identity', () => {
    const v = tmpVault()
    staged(v)
    mergeRun(v, 'sapiens', planFor(v, { Union: 'different-bytes' }))
    const merged = readFileSync(join(v, 'Distilled', 'sapiens', 'Union (Sapiens).md'), 'utf8')
    expect(merged).not.toContain('same_as::')
  })

  it('no plan = every note under its own name (unchanged behaviour)', () => {
    const v = tmpVault()
    staged(v)
    const { manifest } = mergeRun(v, 'sapiens')
    expect(manifest.files.map((f) => f.path).some((p) => p.endsWith('Faction.md'))).toBe(true)
  })
})

describe('migrateDistillRuns (.nodebook/distill → .distill)', () => {
  const legacyRun = (v: string, id: string): string => {
    const dir = join(legacyDistillRoot(v), id, 'notes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Alpha.md'), '# Alpha\n')
    writeFileSync(join(legacyDistillRoot(v), id, 'meta.json'), JSON.stringify({ source: 'B.md', notes: 1 }))
    return dir
  }

  it('moves every legacy run whole, and listRuns then sees only the new root', () => {
    const v = tmpVault()
    legacyRun(v, 'old-a')
    legacyRun(v, 'old-b')
    expect(listRuns(v)).toEqual([]) // nothing under .distill yet

    expect(migrateDistillRuns(v)).toEqual(['old-a', 'old-b'])
    expect(listRuns(v)).toEqual(['old-a', 'old-b'])
    expect(readRunMeta(v, 'old-a')?.notes).toBe(1)
    expect(readStagedNote(v, 'old-a', 'Alpha')).toBe('# Alpha\n')
    expect(existsSync(legacyDistillRoot(v))).toBe(false) // emptied, then removed
  })

  it('is a no-op the second time, and never clobbers a run already in .distill', () => {
    const v = tmpVault()
    legacyRun(v, 'dup')
    migrateDistillRuns(v)
    expect(migrateDistillRuns(v)).toEqual([])

    // A legacy run whose id already exists in the new root is left alone.
    legacyRun(v, 'dup')
    writeFileSync(join(legacyDistillRoot(v), 'dup', 'notes', 'Alpha.md'), '# Legacy\n')
    expect(migrateDistillRuns(v)).toEqual([])
    expect(readStagedNote(v, 'dup', 'Alpha')).toBe('# Alpha\n')
  })

  it('does nothing when there is no legacy root at all', () => {
    expect(migrateDistillRuns(tmpVault())).toEqual([])
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

describe('a run in flight (start marker, checkpoint, resume)', () => {
  const src = { file: 'Federalist.md', text: 'Faction vs Union.' }

  it('records what the run is BEFORE any model call, and reads it back', () => {
    const v = tmpVault()
    beginRun(v, 'r1', src, { provider: 'anthropic', model: 'claude-test' })
    const run = readRunJson(v, 'r1')
    expect(run?.file).toBe('Federalist.md')
    expect(run?.settings).toEqual({ provider: 'anthropic', model: 'claude-test' })
    expect(Number.isNaN(Date.parse(run!.createdAt))).toBe(false)
    // The converted text is the run's own copy — a resume never re-converts,
    // and never depends on the original file still being where it was.
    expect(readRunSource(v, 'r1')).toEqual(src)
  })

  it('is "unfinished" from the start marker until meta.json exists', () => {
    const v = tmpVault()
    beginRun(v, 'r1', src)
    expect(isUnfinishedRun(v, 'r1')).toBe(true)
    writeRunArtifact(v, 'r1', src, emitNotes(grounded()))
    expect(isUnfinishedRun(v, 'r1')).toBe(false)
    expect(isUnfinishedRun(v, 'never-ran')).toBe(false)
  })

  it('appends each window to the checkpoint and replays it in order', () => {
    const v = tmpVault()
    beginRun(v, 'r1', src)
    const store = checkpointStore(v, 'r1')
    expect(store.load()).toBeNull() // nothing recorded yet
    store.save({ type: 'plan', windows: [[0, 1], [2]] })
    store.save({ type: 'window', index: 0, items: [] })
    store.save({ type: 'window', index: 1, failed: true })
    const cp = store.load()!
    expect(cp.plan).toEqual([[0, 1], [2]])
    expect(cp.done.get(0)).toEqual({ items: [], failed: false })
    expect(cp.done.get(1)).toEqual({ items: [], failed: true })
    expect(cp.done.size).toBe(2)
  })

  it('survives a torn last line (a crash mid-write loses that window, not the run)', () => {
    const v = tmpVault()
    beginRun(v, 'r1', src)
    const store = checkpointStore(v, 'r1')
    store.save({ type: 'plan', windows: [[0]] })
    store.save({ type: 'window', index: 0, items: [] })
    appendFileSync(join(runDir(v, 'r1'), 'progress.jsonl'), '{"type":"window","ind')
    const cp = store.load()!
    expect(cp.plan).toEqual([[0]])
    expect(cp.done.size).toBe(1)
  })

  it('FINISHING a run replaces notes + meta.json, keeps the start files, drops the checkpoint', () => {
    const v = tmpVault()
    beginRun(v, 'r1', src)
    const created = readRunJson(v, 'r1')!.createdAt
    const store = checkpointStore(v, 'r1')
    store.save({ type: 'plan', windows: [[0]] })
    // A leftover from an earlier attempt must not survive into the artifact.
    mkdirSync(join(runDir(v, 'r1'), 'notes'), { recursive: true })
    writeFileSync(join(runDir(v, 'r1'), 'notes', 'Stale.md'), 'x')

    writeRunArtifact(v, 'r1', src, emitNotes(grounded()))
    const dir = runDir(v, 'r1')
    expect(existsSync(join(dir, 'notes', 'Stale.md'))).toBe(false)
    expect(existsSync(join(dir, 'notes', 'Faction.md'))).toBe(true)
    expect(existsSync(join(dir, 'progress.jsonl'))).toBe(false) // no longer resumable
    expect(existsSync(join(dir, 'source.md'))).toBe(true)
    expect(readRunJson(v, 'r1')!.createdAt).toBe(created) // the start record is not rewritten
  })

  it('a run written without a start marker still gets one (one shape per run dir)', () => {
    const v = tmpVault()
    writeRunArtifact(v, 'r1', src, [])
    expect(readRunSource(v, 'r1')).toEqual(src)
    expect(isUnfinishedRun(v, 'r1')).toBe(false)
  })
})
