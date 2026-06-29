import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
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
  readMergeManifest
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

  it('copies the run notes into a namespaced vault folder + records a manifest', () => {
    const v = tmpVault()
    run(v)
    expect(canonicalMarkdown(v)).toEqual([]) // staged run is hidden (the firewall)
    const { manifest, written } = mergeRun(v, 'sapiens')
    expect(manifest.folder).toBe(join('Distilled', 'sapiens'))
    // Now the notes live in the vault proper — a canonical scan sees them.
    expect(canonicalMarkdown(v).length).toBe(manifest.files.length)
    expect(existsSync(join(v, 'Distilled', 'sapiens', 'Faction.md'))).toBe(true)
    expect(written).toHaveLength(manifest.files.length)
    expect(readMergeManifest(v, 'sapiens')).toEqual(manifest)
  })

  it('undo deletes exactly what it wrote, the empty folder, and the manifest', () => {
    const v = tmpVault()
    run(v)
    const { written } = mergeRun(v, 'sapiens')
    const removed = unmergeRun(v, 'sapiens')
    expect(removed.sort()).toEqual([...written].sort())
    expect(canonicalMarkdown(v)).toEqual([]) // fully reversed
    expect(existsSync(join(v, 'Distilled', 'sapiens'))).toBe(false)
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
