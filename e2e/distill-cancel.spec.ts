import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Cancelling a distill run from the UI, and resuming it. The stub chat is slowed
// down (NODEBOOK_E2E_CHAT_DELAY_MS) so the run is still extracting when the
// Cancel button is clicked — otherwise it would be over before the click lands.
// Its own app instance: the delay would make every other distill test slow.
//
// The three tests are one story in order: cancel → the run is paused, not lost →
// Resume finishes it.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

/** Per chat call, in ms — enough to click Cancel mid-extraction. A short book
 *  now fits ONE reading window (the run reads it in one call instead of one per
 *  cluster), so this single stall is the whole window the click has to land in. */
const CHAT_DELAY_MS = 3000

let app: ElectronApplication
let page: Page
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
  ''
].join('\n')

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-cancel-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-cancel-userdata-'))
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )
  bookPath = join(userDataDir, 'on-government.md')
  writeFileSync(bookPath, BOOK)

  app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      NODEBOOK_USER_DATA: userDataDir,
      NODEBOOK_E2E: '1',
      NODEBOOK_E2E_CHAT_DELAY_MS: String(CHAT_DELAY_MS)
    }
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

test('Cancel stops a run in flight: it is not an error, and the run is paused', async () => {
  // The stub chat deliberately stalls (probe + one extraction call), so this
  // test needs more than the suite's fail-fast ceiling.
  test.setTimeout(30_000)

  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  await skipFocusDialog()

  const toast = page.locator('.distill-toast')
  await expect(toast).toBeVisible({ timeout: 15_000 })
  // Wait until the model is actually being called — the point of no cheap return.
  await expect(toast).toContainText('extracting concepts', { timeout: 15_000 })

  await page.locator('.distill-cancel').click()
  await expect(toast).toBeHidden({ timeout: 15_000 })

  // Cancelling is a choice, not a fault: a plain status line, no error banner.
  await expect(page.locator('.distill-coverage-banner')).toContainText('cancelled')
  await expect(page.locator('.error-banner')).toHaveCount(0)

  // The run is PAUSED, not lost: it keeps what it already read and offers to
  // carry on. Nothing is staged as notes yet — that only happens on completion.
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs).toEqual([
    { id: 'on-government', notes: 0, themes: [], merged: false, unfinished: true }
  ])
  await expect(page.locator('.run-item-meta')).toContainText('paused')
  await expect(page.locator('.run-item-resume')).toBeVisible()
})

test('Resume carries the paused run to the end, and stages its notes', async () => {
  test.setTimeout(60_000)

  await page.locator('.run-item-resume').click()
  const toast = page.locator('.distill-toast')
  await expect(toast).toBeVisible({ timeout: 15_000 })
  await expect(toast).toBeHidden({ timeout: 45_000 })

  // Finished: notes staged, and the run is no longer offered for resuming.
  await expect(page.locator('.distill-coverage-banner')).toContainText('Staged')
  await expect(page.locator('.error-banner')).toHaveCount(0)
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ id: 'on-government', unfinished: false })
  expect(runs[0].notes).toBeGreaterThan(0)
  await expect(page.locator('.run-item-resume')).toHaveCount(0)
})

test('after a cancelled run the next one can start (the single-run slot is free)', async () => {
  test.setTimeout(30_000)
  const res = await page.evaluate(async (p) => {
    const id = await window.nodebook.distillRegisterPath(p)
    return window.nodebook.distillRun(id)
  }, bookPath)
  expect(res.stats.notes).toBeGreaterThan(0)
})
