import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { VaultThemesData } from '../shared/types'
import { VaultIndex } from './indexer'

const makeWorker = vi.hoisted(() => vi.fn())
vi.mock('./vaultThemes.worker?nodeWorker', () => ({ default: makeWorker }))

class HeldWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => {
    this.emit('exit', 1)
    return 1
  })

  finish(data: VaultThemesData): void {
    this.emit('message', data)
    this.emit('exit', 0)
  }
}

it('retries a worker that read before a committed note revision, then caches only the current result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-themes-race-'))
  const path = join(root, 'Note.md')
  const index = new VaultIndex(join(root, 'index.db'))
  const workers: HeldWorker[] = []
  makeWorker.mockImplementation(() => {
    const worker = new HeldWorker()
    workers.push(worker)
    return worker
  })
  const snapshot = (title: string): VaultThemesData => ({
    noteCount: 1,
    embeddedCount: 0,
    themes: [],
    unmatched: [{ path, relativePath: 'Note.md', title }]
  })
  const controller = new AbortController()
  try {
    index.indexFile(path, '# First revision')
    const pending = index.vaultThemes(root, null, controller.signal)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    index.indexFile(path, '# Current revision')
    workers[0].finish(snapshot('First revision'))
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    const current = snapshot('Current revision')
    workers[1].finish(current)
    await expect(pending).resolves.toEqual(current)
    await expect(index.vaultThemes(root, null, controller.signal)).resolves.toEqual(current)
    expect(workers).toHaveLength(2)

    index.indexFile(path, '# One more revision')
    const cancelled = index.vaultThemes(root, null, controller.signal)
    await vi.waitFor(() => expect(workers).toHaveLength(3))
    controller.abort()
    await expect(cancelled).resolves.toBeNull()
    expect(workers[2].terminate).toHaveBeenCalledOnce()
  } finally {
    controller.abort()
    index.close()
    rmSync(root, { recursive: true, force: true })
  }
})
