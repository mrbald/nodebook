import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Verifies the "distill a document" vertical end-to-end — chunk → embed (renderer
// bridge, faked) → cluster → extract (stub chat) → ground → emit → staged run.db
// → run graph — and the firewall: the distilled notes never reach the canonical
// index. No model download, no network, no key.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string
let bookPath: string

const BOOK = [
  '# On Government',
  '',
  '## Faction',
  'Faction arises from the unequal distribution of property among the citizens.',
  '',
  '## Republic',
  'A republic refines public views by passing them through elected representatives.',
  '',
  '## Powers',
  'The accumulation of all powers in the same hands is the very definition of tyranny.',
  '',
  '## Ambition',
  'Ambition must be made to counteract ambition so that power checks power.',
  '',
  '## Liberty',
  'Liberty is to faction what air is to fire, an aliment without which it expires.',
  '',
  '## Union',
  'A firm union is essential to the peace and the liberty of the several states.',
  ''
].join('\n')

test.beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-userdata-'))
  // A chat provider so distill is allowed; under NODEBOOK_E2E the model is a stub.
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )
  // The book lives OUTSIDE the vault, so it is not itself a canonical note.
  bookPath = join(userDataDir, 'on-government.md')
  writeFileSync(bookPath, BOOK)

  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)

  page = await app.firstWindow()
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__ = true
  })
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

test('distills a document into a staged, cited run of notes', async () => {
  const result = await page.evaluate((p) => window.nodebook.distillRun(p), bookPath)
  expect(result.runId).toBeTruthy()
  expect(result.stats.chunks).toBeGreaterThan(0)
  expect(result.stats.notes).toBeGreaterThan(0)
  expect(result.stats.dropped).toBe(0) // stub quotes are real substrings → grounding keeps all
})

test('the run map wires distilled notes to the source book', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs.length).toBeGreaterThan(0)
  const g = await page.evaluate((id) => window.nodebook.distillGraph(id), runs[0])
  expect(g.nodes.length).toBeGreaterThan(1)
  expect(g.nodes.some((n) => n.id === 'on-government')).toBe(true) // source is a node
  expect(g.edges.some((e) => e.relation === 'source')).toBe(true) // notes cite it
})

test('FIREWALL: distilled notes never enter the canonical index', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const g = await page.evaluate((id) => window.nodebook.distillGraph(id), runs[0])
  const canonNames = await page.evaluate(() => window.nodebook.noteNames())
  // Not one of the run's nodes (source or distilled concepts) leaked into the vault index.
  for (const node of g.nodes) expect(canonNames).not.toContain(node.id)
})

test('OVERLAY unions the vault + the run with provenance, writing nothing', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const overlay = await page.evaluate((id) => window.nodebook.distillOverlayGraph(id), runs[0])
  const sources = new Set(overlay.nodes.map((n) => n.source))
  expect(sources.has('run')).toBe(true) // the book's nodes
  expect(sources.has('vault')).toBe(true) // your existing notes, shown alongside
  expect(overlay.nodes.some((n) => n.id === 'on-government' && n.source === 'run')).toBe(true)
  // Overlay is a pure view — the run stays out of the canonical index.
  const canon = await page.evaluate(() => window.nodebook.noteNames())
  expect(canon).not.toContain('on-government')
})

test('File ▸ Distill a document… runs from the menu and shows the run map', async () => {
  // Point the file dialog at the book, then fire the menu command.
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  // The run map renders via the reused GraphView, with nodes + a source edge.
  await expect(page.locator('.graph-view')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.graph-node').first()).toBeVisible()
  expect(await page.locator('.graph-node').count()).toBeGreaterThan(1)
  await expect(page.locator('.graph-edge').first()).toBeVisible()
})

test('distills a PDF via pdf.js text extraction → cited notes', async () => {
  const pdfPath = join(__dirname, 'fixtures', 'sample.pdf')
  const res = await page.evaluate((p) => window.nodebook.distillRun(p), pdfPath)
  expect(res.stats.chunks).toBeGreaterThan(0)
  expect(res.stats.notes).toBeGreaterThan(0) // extracted text flowed through the pipeline
})

test('the run map toggles Standalone ⟷ Overlay (overlay adds the vault notes)', async () => {
  // The run map is open from the previous test.
  await expect(page.locator('.distill-view-toggle')).toContainText('Standalone')
  const standalone = await page.locator('.graph-node').count()
  await page.locator('.distill-view-toggle').click()
  await expect(page.locator('.distill-view-toggle')).toContainText('Overlay')
  // Overlay folds in your vault's notes, so there are strictly more nodes.
  await expect.poll(() => page.locator('.graph-node').count()).toBeGreaterThan(standalone)
})

test('MERGE writes the run into the vault (now canonical); UNDO reverses it', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0]
  expect(await page.evaluate(() => window.nodebook.noteNames())).not.toContain('on-government')
  const res = await page.evaluate((r) => window.nodebook.distillMerge(r), id)
  expect(res.count).toBeGreaterThan(0)
  // The merged notes are now real vault notes — the canonical index sees them.
  expect(await page.evaluate(() => window.nodebook.noteNames())).toContain('on-government')
  // Undo removes exactly what it wrote.
  await page.evaluate((r) => window.nodebook.distillUnmerge(r), id)
  expect(await page.evaluate(() => window.nodebook.noteNames())).not.toContain('on-government')
})

test('Merge button → confirm → Undo banner → reverses', async () => {
  // The run map is still open from the earlier tests.
  await page.locator('.distill-merge-btn').click()
  await page.locator('.modal-btn-danger').click() // confirm the merge
  await expect(page.locator('.distill-merged-banner')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.nodebook.noteNames())).toContain('on-government')
  await page.locator('.distill-undo').click()
  await expect(page.locator('.distill-merged-banner')).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => window.nodebook.noteNames()))
    .not.toContain('on-government')
})
