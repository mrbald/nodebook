import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Empty/error states: opening a vault with no notes should explain what to do,
// not show a dead-end "Select a note" with nothing to select.
const projectRoot = resolve(__dirname, '..')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-empty-')) // a vault with no .md
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-empty-userdata-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
})

test.afterAll(async () => {
  await app?.close()
})

test('an empty vault shows a friendly, instructive empty state', async () => {
  await expect(page.locator('.empty')).toContainText('no notes yet')
})
