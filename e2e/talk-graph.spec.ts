import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Phase D: the semantic overlay. Two notes with high word overlap but NO link
// between them — with the deterministic stub embedder, the map should surface a
// dashed "related but not linked" edge.
const projectRoot = resolve(__dirname, '..')
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-talkgraph-'))
  writeFileSync(join(vaultDir, 'Alpha.md'), '# Alpha\n\ngraph theory nodes edges clustering centrality\n')
  writeFileSync(join(vaultDir, 'Beta.md'), '# Beta\n\ngraph nodes clustering theory centrality\n')
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-talkgraph-userdata-'))
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

test('enable talk-to-docs and embed the vault', async () => {
  await page.locator('.talk-cta').click()
  await page.locator('.talk-enable').click()
  await expect(page.locator('.talk-status .talk-on')).toBeVisible({ timeout: 9000 })
})

test('the map overlays a "related but not linked" dashed edge to a similar note', async () => {
  await page.locator('.tree-file', { hasText: 'Alpha' }).click()
  await page.locator('.graph-open-btn').click()
  await expect(page.locator('.graph-view')).toBeVisible()

  // Related is on by default once talk is ready: Beta (similar, unlinked) appears.
  await expect(page.locator('.graph-node', { hasText: 'Beta' })).toBeVisible()
  await expect(page.locator('.graph-edge-related')).toHaveCount(1)

  // Toggling the overlay off removes it.
  await page.locator('.graph-ctl', { hasText: 'Related' }).click()
  await expect(page.locator('.graph-edge-related')).toHaveCount(0)
})
