import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The same idea under another name: with talk on, Merge proposes a vault note
// that means the same as a staged note, and a tick links the two as one. The
// deterministic e2e embedder is a bag of words, so a vault note with the same
// words as a staged note is its exact twin — closest both ways.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string
let bookPath: string
let firstRunId = ''

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
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-sameas-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-sameas-userdata-'))
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )
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

/** The distill flow asks what to focus on before it spends anything. These
 *  tests are not about the focus, so they confirm the empty field — which is
 *  the "no focus" answer, and the reading these tests have always made. */
async function skipFocusDialog(): Promise<void> {
  const modal = page.locator('.modal', { hasText: 'What should the notes focus on?' })
  await expect(modal).toBeVisible({ timeout: 15_000 })
  await modal.getByRole('button', { name: 'Distill' }).click()
}

test('Merge proposes a vault note that means the same as a staged one, and a tick links them', async () => {
  // Talk on: the vault's note vectors are what the proposal is matched against.
  await page.locator('.talk-cta').click()
  await page.locator('.talk-enable').click()
  await expect(page.locator('.talk-status .talk-on')).toBeVisible({ timeout: 9000 })

  // Run from the menu, as a user would: the run map opens with its Merge button.
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  await skipFocusDialog()
  await expect(page.locator('.graph-view')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.distill-coverage-banner')).toBeVisible()
  await page.locator('.distill-coverage-close').click()
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const runId = runs[0].id
  firstRunId = runId
  const root = realpathSync(vaultDir)
  const stagedDir = join(root, '.distill', runId, 'notes')
  const stagedName = readdirSync(stagedDir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))
    .find((n) => n !== 'on-government')!
  const stagedFile = join(stagedDir, `${stagedName}.md`)
  expect(existsSync(stagedFile)).toBe(true)

  // Your own note about the same thing, under another name: the same words.
  const twin = 'Property and faction'
  writeFileSync(join(root, `${twin}.md`), readFileSync(stagedFile, 'utf8'))
  await expect.poll(() => page.evaluate(() => window.nodebook.noteNames())).toContain(twin)
  await expect.poll(async () => (await page.evaluate(() => window.nodebook.talkStatus())).pending).toBe(0)

  // The plan proposes it — on a `new` entry, unticked, and on that entry only.
  const plan = await page.evaluate((r) => window.nodebook.distillMergePlan(r), runId)
  const entry = plan.entries.find((e) => e.name === stagedName)!
  expect(entry.action).toBe('new')
  expect(entry.sameAsCandidate).toBe(twin)
  expect(plan.entries.filter((e) => e.sameAsCandidate)).toHaveLength(1)

  // The dialog says so; a tick, then Merge.
  await page.locator('.distill-merge-btn').click()
  await expect(page.locator('.merge-dialog')).toBeVisible()
  const row = page.locator('.merge-twin', { hasText: stagedName })
  await expect(row).toContainText(`same as your “${twin}”`)
  await expect(row.locator('input')).not.toBeChecked()
  await row.locator('input').check()
  await page.locator('.merge-confirm').click()
  await expect(page.locator('.distill-merged-banner')).toBeVisible()

  // Written under its own name, with the decision as one readable line.
  const merged = join(root, 'Distilled', runId, `${stagedName}.md`)
  await expect.poll(() => existsSync(merged)).toBe(true)
  expect(readFileSync(merged, 'utf8')).toContain(`same_as:: [[${twin}]]`)

  // …and the map draws the two as one dot.
  await expect
    .poll(async () => {
      const g = await page.evaluate(() => window.nodebook.graph(null, {}))
      return g.nodes.filter((n) => n.label === twin || n.label === stagedName).length
    })
    .toBe(1)
})

test('a tick means the twin that was shown: a clash appearing under the dialog drops it', async () => {
  // Undo the previous merge, then a second run of the same book; the twin from
  // the previous test is still in the vault, so the same staged note gets the
  // same proposal.
  await page.locator('.distill-undo').click()
  await expect(page.locator('.distill-merged-banner')).toBeHidden()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  await skipFocusDialog()
  await expect(page.locator('.distill-coverage-banner')).toBeVisible({ timeout: 15000 })
  await page.locator('.distill-coverage-close').click()
  // The new run is the one the previous test did not make (both are unmerged now).
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const run = runs.find((r) => r.id !== firstRunId)!
  const root = realpathSync(vaultDir)
  const stagedName = readdirSync(join(root, '.distill', run.id, 'notes'))
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))
    .find((n) => n !== 'on-government')!

  await page.locator('.distill-merge-btn').click()
  await expect(page.locator('.merge-dialog')).toBeVisible()
  const row = page.locator('.merge-twin', { hasText: stagedName })
  await expect(row).toBeVisible()
  await row.locator('input').check()

  // While the dialog is open, a note of that exact name appears in the vault:
  // the entry is now a clash with a stranger. The tick said "same as the twin".
  writeFileSync(join(root, `${stagedName}.md`), `# ${stagedName}\n\nSomething else entirely.\n`)
  await expect.poll(() => page.evaluate(() => window.nodebook.noteNames())).toContain(stagedName)
  await page.locator('.merge-confirm').click()
  await expect(page.locator('.distill-merged-banner')).toBeVisible()

  // Saved beside the stranger, and linked to neither: no redirect, no twin.
  const beside = join(root, 'Distilled', run.id, `${stagedName} (on-government).md`)
  await expect.poll(() => existsSync(beside)).toBe(true)
  expect(readFileSync(beside, 'utf8')).not.toContain('same_as::')
})
