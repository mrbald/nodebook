import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Cancelling a distill run from the UI. The stub chat is slowed down
// (NODEBOOK_E2E_CHAT_DELAY_MS) so the run is still extracting when the Cancel
// button is clicked — otherwise it would be over before the click lands. Its
// own app instance: the delay would make every other distill test slow.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

/** Per chat call, in ms — enough to click Cancel mid-extraction. */
const CHAT_DELAY_MS = 1500

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

test('Cancel stops a run in flight: nothing is staged, and it is not an error', async () => {
  // The stub chat deliberately stalls (probe + one extraction call), so this
  // test needs more than the suite's fail-fast ceiling.
  test.setTimeout(30_000)

  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })

  const toast = page.locator('.distill-toast')
  await expect(toast).toBeVisible({ timeout: 15_000 })
  // Wait until the model is actually being called — the point of no cheap return.
  await expect(toast).toContainText('extracting concepts', { timeout: 15_000 })

  await page.locator('.distill-cancel').click()
  await expect(toast).toBeHidden({ timeout: 15_000 })

  // Cancelling is a choice, not a fault: a plain status line, no error banner.
  await expect(page.locator('.distill-coverage-banner')).toContainText('cancelled')
  await expect(page.locator('.error-banner')).toHaveCount(0)

  // Nothing was staged — the cancelled run does not appear in the runs list.
  expect(await page.evaluate(() => window.nodebook.distillListRuns())).toEqual([])
  await expect(page.locator('.runs-section')).toHaveCount(0)
})

test('after a cancelled run the next one can start (the single-run slot is free)', async () => {
  test.setTimeout(30_000)
  const res = await page.evaluate(async (p) => {
    const id = await window.nodebook.distillRegisterPath(p)
    return window.nodebook.distillRun(id)
  }, bookPath)
  expect(res.stats.notes).toBeGreaterThan(0)
})
