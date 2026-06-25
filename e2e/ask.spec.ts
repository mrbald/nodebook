import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// "Ask" (talk-to-docs P2): retrieve grounding chunks → stream a cited answer.
// A chat provider is configured so Ask is available; under NODEBOOK_E2E the chat
// model is a deterministic stub (no network/key), and the embedder is faked.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  test.setTimeout(45_000) // launch + open + enable/index can take a few seconds
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-ask-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-ask-userdata-'))
  // Configure a chat provider so "Ask" is offered; the stub answers it.
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )
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
  // Enable talk so retrieval (and therefore citations) work.
  await page.locator('.talk-cta').click()
  await page.locator('.talk-enable').click()
  await expect(page.locator('.talk-status .talk-on')).toBeVisible({ timeout: 9000 })
})

test.afterAll(async () => {
  await app?.close()
})

test('Ask streams a grounded answer and lists its sources', async () => {
  await expect(page.locator('.ask-open-btn')).toBeVisible() // chat provider configured
  await page.locator('.ask-open-btn').click()
  await expect(page.locator('.ask-pane')).toBeVisible()

  await page.locator('.ask-input').fill('What is in my notes?')
  await page.locator('.ask-send').click()

  await expect(page.locator('.ask-answer')).toContainText('Based on your notes')
  await expect(page.locator('.ask-source').first()).toBeVisible() // a cited source note
})
