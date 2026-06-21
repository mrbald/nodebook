import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Verifies the whole "talk to docs" vertical — enable → chunk → embed → store →
// hybrid search — using a deterministic in-process embedder (window flag
// __NODEBOOK_FAKE_EMBED__), so CI never downloads a model and stays offline.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string

test.beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-talk-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-talk-userdata-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)

  page = await app.firstWindow()
  // Swap in the deterministic embedder before anything calls getEmbedder().
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

test('off by default: an honest CTA, no dead toggles, keyword search only', async () => {
  await expect(page.locator('.talk-cta')).toBeVisible()
  await expect(page.locator('.talk-status')).toHaveCount(0)
  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(false)
})

test('enable: setup card → indexes the vault → semantic search goes live', async () => {
  await page.locator('.talk-cta').click()
  await expect(page.locator('.talk-setup')).toBeVisible()
  await page.locator('.talk-enable').click()

  // Indexing finishes and the status flips to "on".
  await expect(page.locator('.talk-status .talk-on')).toBeVisible({ timeout: 9000 })

  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(true)
  expect(status.ready).toBe(true)
  expect(status.total).toBeGreaterThan(0)
  expect(status.pending).toBe(0) // fully embedded
})

test('hybrid search surfaces a note and marks the meaning-matched hit with ✨', async () => {
  await page.locator('.search-box').fill('claim') // a word that lives in welcome.md
  await expect(page.locator('.search-results li').first()).toBeVisible()
  await expect(page.locator('.search-result-ai').first()).toBeVisible()

  // The hit opens its note.
  await page.locator('.search-results li').first().click()
  await expect(page.locator('.cm-content')).toContainText('claim')
  await page.locator('.search-box').fill('')
})

test('turn off: drops the embeddings and reverts to the CTA (reversible)', async () => {
  await page.locator('.talk-link', { hasText: 'Turn off' }).click()
  await expect(page.locator('.talk-cta')).toBeVisible()
  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(false)
  expect(status.total).toBe(0) // chunks + vectors dropped
})
