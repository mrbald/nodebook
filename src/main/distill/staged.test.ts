import Database from 'better-sqlite3'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { VaultIndex } from '../indexer'
import { legacyDistillRoot, migrateDistillRuns, runDir } from './artifact'
import { StagedRunStore } from './staged'

// Vitest does not run electron-vite's worker import transform. Staged indexes
// never start the canonical vault themes worker.
vi.mock('../vaultThemes.worker?nodeWorker', () => ({ default: vi.fn() }))

const runId = 'Test book'
const heading = (title: string, kind: string): string => `---\nkind: ${kind}\n---\n# ${title}\n\n`

function warmRun(folder: string): void {
  const directory = join(folder, 'notes')
  mkdirSync(directory, { recursive: true })
  const index = new VaultIndex(join(folder, 'run.db'))
  const add = (name: string, text: string): void => {
    const path = join(directory, `${name}.md`)
    writeFileSync(path, text)
    index.indexFile(path, text)
  }
  try {
    add('Book', heading('Book', 'document') + 'The book itself.')
    for (const theme of ['Ideas', 'Methods']) {
      add(theme, heading(theme, 'theme') + 'source:: Book\n')
      for (let i = 0; i < 101; i++) {
        const name = `${theme} ${i}`
        const relations = name === 'Ideas 0' ? 'status:: Methods 1\nsupports:: [[Methods 0]]\n' : ''
        add(name, heading(name, 'concept') + `part_of:: ${theme}\n${relations}\nProse for ${name}.\n`)
      }
    }
  } finally {
    index.close()
  }
}

describe('StagedRunStore warm cache scope', () => {
  it.each(['legacy migration', 'copied vault', 'mixed cache'] as const)('rebuilds graph and reader paths after %s', (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'nodebook-staged-relocation-'))
    const store = new StagedRunStore(root)
    try {
      const current = runDir(root, runId)
      const previous = scenario === 'legacy migration'
        ? join(legacyDistillRoot(root), runId)
        : scenario === 'copied vault' ? runDir(join(root, 'previous vault'), runId) : current
      warmRun(previous)
      const outside = scenario === 'mixed cache' ? join(current, 'notes-archive') : join(previous, 'notes')
      const oldPath = join(outside, 'Ideas 0.md')
      if (scenario === 'legacy migration') {
        expect(migrateDistillRuns(root)).toEqual([runId])
      } else if (scenario === 'copied vault') {
        cpSync(previous, current, { recursive: true })
      } else {
        const db = new Database(join(current, 'run.db'))
        try {
          // A warm cache can have otherwise valid file rows and stale relation
          // sources. A sibling with the same textual prefix is outside the run.
          db.prepare('UPDATE triples SET source_file = ? WHERE source_file = ?').run(
            oldPath, join(current, 'notes', 'Ideas 0.md')
          )
        } finally {
          db.close()
        }
      }
      mkdirSync(outside, { recursive: true })
      writeFileSync(oldPath, '# Old note\n\nOutside this run.\n')

      const note = (name: string): string => join(current, 'notes', `${name}.md`)
      const overview = store.bookOverview(runId)!
      expect(overview.noteCount).toBe(202)
      expect(overview.themes.map(({ id }) => id)).toEqual([note('Ideas'), note('Methods')])
      expect(overview.links).toEqual([
        { source: note('Ideas'), target: note('Methods'), count: 1, strong: true }
      ])
      const pair = store.linkEvidence(runId, note('Ideas'), note('Methods'))?.pairs[0]
      expect(pair).toMatchObject({
        source: { id: note('Ideas 0') },
        target: { id: note('Methods 0') },
        relationships: [{ source: note('Ideas 0'), target: note('Methods 0'), relation: 'supports' }]
      })
      expect(store.themeGraph(runId, note('Ideas'))?.nodes.some(({ id }) => id === pair?.source.id)).toBe(true)
      expect(store.graph(runId, note('Ideas 0')).nodes.find(({ focus }) => focus)?.id).toBe(note('Ideas 0'))
      expect(store.rows(runId).triples.some(({ source_file }) => source_file === oldPath)).toBe(false)
      expect(store.readNote(runId, note('Ideas 0'))).toMatchObject({
        content: expect.stringContaining('Prose for Ideas 0.'),
        themeId: note('Ideas'),
        themeLabel: 'Ideas'
      })
      expect(store.readNote(runId, oldPath)).toBeNull()
      expect(store.notePreview(runId, note('Ideas 0'))).toBe('Prose for Ideas 0.')
      expect(store.notePreview(runId, oldPath)).toBe('')
    } finally {
      store.close()
      rmSync(root, { force: true, recursive: true })
    }
  })
})
