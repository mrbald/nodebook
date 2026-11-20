import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'

// Settings live in userData/settings.toml (app-global, not per-vault), so they
// must be reachable before any vault is opened.
const projectRoot = resolve(__dirname, '..')
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-nv-userdata-'))
  const binary = process.env.NODEBOOK_SMOKE_BINARY
  app = await launchElectron({
    executablePath: binary,
    args: binary ? [] : [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  if (binary) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
})

test.afterAll(async () => {
  await closeElectron(app)
})

test('Settings open with no vault opened', async () => {
  if (process.platform === 'darwin') {
    const { path, upload } = await app.evaluate(({ app, crashReporter }) => ({
      path: app.getPath('crashDumps'),
      upload: crashReporter.getUploadToServer()
    }))
    expect(dirname(path)).toBe(test.info().project.outputDir)
    expect(basename(path)).toMatch(/^electron-crash-/)
    expect(upload).toBe(false)
    await expect.poll(() => readdirSync(path).length).toBeGreaterThan(0)
  }

  // No vault: the empty state is shown and the Settings button is still present.
  await expect(page.locator('.empty')).toHaveText('Open a vault to begin')
  await expect(page.getByRole('button', { name: /^Appearance:/ })).toBeVisible()
  await page.locator('.settings-btn').click()
  await expect(page.getByRole('button', { name: /^Appearance:/ })).toHaveCount(0)
  await expect(page.locator('.settings-title')).toHaveText('Settings')
  await expect(page.locator('.cm-content')).toContainText('followSystem')
})

test('Reveal defaults shows a read-only reference; Hide closes it', async () => {
  // Settings is open from the previous test.
  await expect(page.locator('.settings-defaults')).toHaveCount(0)
  await page.locator('.settings-reveal').click()

  const ref = page.locator('.settings-defaults')
  await expect(ref).toBeVisible()
  await expect(page.locator('.settings-reveal')).toHaveText('Hide defaults')
  await expect(ref.locator('.settings-defaults-label')).toContainText('read-only')
  // The defaults TOML header (top of the doc, reliably in the CM viewport).
  await expect(ref.locator('.cm-content')).toContainText('every option with its default')
  // The reference is read-only, never editable.
  await expect(ref.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

  await page.locator('.settings-reveal').click() // now "Hide defaults"
  await expect(page.locator('.settings-defaults')).toHaveCount(0)
})


test('closing Settings returns to the welcome screen and its appearance control', async () => {
  await page.locator('.settings-actions').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.empty')).toHaveText('Open a vault to begin')
  await expect(page.getByRole('button', { name: /^Appearance:/ })).toBeVisible()
})
