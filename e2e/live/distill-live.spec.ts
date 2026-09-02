import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// LIVE: the real app, the real embedding model (downloaded on first run) and
// the real chat provider — Claude Code's CLI under the user's own sign-in — on
// one small document. Not part of `npm run test:e2e`: it needs network, a
// signed-in `claude`, and minutes. `npm run test:e2e:live` builds and runs it.
//
// It verifies exactly what the stubbed suite cannot: that themes and dedup
// hold up on real vectors and real replies — every note under one theme, theme
// names distinct from note names, and in the document's own language.

const projectRoot = resolve(__dirname, '..', '..')
const fixtureVault = join(projectRoot, 'e2e', 'fixtures', 'vault')
const BOOK = join(projectRoot, 'e2e', 'fixtures', 'distill', 'book-en', 'federalist-84.md')
// Persistent on purpose: the embedding model is downloaded once, not per run.
const userDataDir = join(tmpdir(), 'nodebook-live-userdata')

let app: ElectronApplication
let page: Page
let vaultDir: string

test.beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-live-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk]\nenabled = true\n\n[talk.chat]\nprovider = "claude-cli"\nmodel = "sonnet"\n'
  )
  app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      NODEBOOK_USER_DATA: userDataDir,
      NODEBOOK_E2E: '1', // the door a spec registers a document through
      NODEBOOK_E2E_LIVE_CHAT: '1' // …without swapping the chat model for the stub
    }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  page = await app.firstWindow()
  // No `__NODEBOOK_FAKE_EMBED__` here: the real worker loads the real model.
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

test('real vectors and a real model: every note under one theme, themes distinct and in the document language', async () => {
  const fake = await page.evaluate(() => (window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__)
  expect(fake).toBeUndefined()

  const { runId, stats } = await page.evaluate(async (path) => {
    const id = await window.nodebook.distillRegisterPath(path)
    return window.nodebook.distillRun(id)
  }, BOOK)

  // The run read the whole essay and the model's quotes grounded.
  expect(stats.failedWindows).toBe(0)
  expect(stats.notes).toBeGreaterThanOrEqual(6)
  expect(stats.dropped).toBeLessThan(stats.extracted * 0.2)
  expect(stats.themesSkipped).toBe(0)
  expect(stats.themes).toBeGreaterThanOrEqual(3)

  const g = await page.evaluate((r) => window.nodebook.distillGraph(r), runId)
  const themes = g.nodes.filter((n) => n.kind === 'theme')
  const notes = g.nodes.filter((n) => n.kind !== 'theme' && n.kind !== 'document' && !n.ghost)
  expect(themes.length).toBe(stats.themes)

  // Every note hangs off exactly one theme, and that theme is a real node.
  const themeIds = new Set(themes.map((n) => n.id))
  const partOf = g.edges.filter((e) => e.relation === 'part_of' && themeIds.has(e.target))
  const byNote = new Map<string, number>()
  for (const e of partOf) byNote.set(e.source, (byNote.get(e.source) ?? 0) + 1)
  for (const n of notes) expect(byNote.get(n.id), `${n.label} has one theme`).toBe(1)

  // Theme names: distinct from each other, never a note's own name, and in the
  // essay's language — the observed failure was Russian/Polish/Turkish names
  // for an English book.
  const noteLabels = new Set(notes.map((n) => n.label.toLowerCase()))
  const seen = new Set<string>()
  for (const t of themes) {
    const key = t.label.toLowerCase()
    expect(noteLabels.has(key), `theme "${t.label}" is not also a note`).toBe(false)
    expect(seen.has(key), `theme "${t.label}" is unique`).toBe(false)
    seen.add(key)
    expect(t.label, 'no Cyrillic').not.toMatch(/[Ѐ-ӿ]/)
    expect(t.label, 'no Polish/Turkish letters').not.toMatch(/[ąćęłńśźżğışçö]/i)
    expect(t.label, 'not the stub').not.toMatch(/^Theme \d+$/)
  }

  console.log(
    `live distill of federalist-84: windows=${stats.windows} extracted=${stats.extracted} grounded=${stats.grounded} ` +
      `dropped=${stats.dropped} merged=${stats.merged} notes=${stats.notes} themes=${stats.themes} ` +
      `edges=${stats.edges} ghosts=${stats.ghostLinks}\nthemes: ${themes.map((t) => t.label).join(' | ')}`
  )
})
