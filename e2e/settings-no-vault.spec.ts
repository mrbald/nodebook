import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Settings live in userData/settings.toml (app-global, not per-vault), so they
// must be reachable before any vault is opened.
const projectRoot = resolve(__dirname, '..')
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-nv-userdata-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
})

test.afterAll(async () => {
  await app?.close()
})

test('Settings open with no vault opened', async () => {
  // No vault: the empty state is shown and the Settings button is still present.
  await expect(page.locator('.empty')).toHaveText('Open a vault to begin')
  await page.locator('.settings-btn').click()
  await expect(page.locator('.settings-title')).toHaveText('Settings')
  await expect(page.locator('.cm-content')).toContainText('followSystem')
})

test('Reveal defaults shows a read-only reference; Hide closes it', async () => {
  // Settings is open from the previous test.
  await expect(page.locator('.settings-defaults')).toHaveCount(0)
  await page.locator('.settings-reset', { hasText: 'Reveal defaults' }).click()

  const ref = page.locator('.settings-defaults')
  await expect(ref).toBeVisible()
  await expect(ref.locator('.settings-defaults-label')).toContainText('read-only')
  // The defaults TOML header (top of the doc, reliably in the CM viewport).
  await expect(ref.locator('.cm-content')).toContainText('every option with its default')
  // The reference is read-only, never editable.
  await expect(ref.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

  await page.locator('.settings-reset', { hasText: 'Hide defaults' }).click()
  await expect(page.locator('.settings-defaults')).toHaveCount(0)
})
