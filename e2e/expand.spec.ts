import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Per-node expand/collapse: pull a single note's neighbourhood into the map
// without growing the global depth. A Root→Mid→Leaf chain means Leaf is two hops
// from the focus (hidden), until we expand Mid.
const projectRoot = resolve(__dirname, '..')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-expand-'))
  writeFileSync(join(vaultDir, 'Root.md'), '# Root\n\nlinks [[Mid]]\n')
  writeFileSync(join(vaultDir, 'Mid.md'), '# Mid\n\nlinks [[Leaf]]\n')
  writeFileSync(join(vaultDir, 'Leaf.md'), '# Leaf\n\nlinks [[Tip]]\n')
  writeFileSync(join(vaultDir, 'Tip.md'), '# Tip\n')
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-expand-userdata-'))
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
  await page.locator('.tree-file', { hasText: 'Root' }).click()
})

test.afterAll(async () => {
  await app?.close()
})

test('expanding a node pulls in its neighbours; collapse removes them', async () => {
  await page.locator('.graph-open-btn', { hasText: 'Map' }).click()
  await expect(page.locator('.graph-node', { hasText: 'Mid' })).toBeVisible()
  await expect(page.locator('.graph-node', { hasText: 'Leaf' })).toHaveCount(0) // 2 hops away

  await page.locator('.graph-node', { hasText: 'Mid' }).click() // select Mid
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  await expect(page.locator('.graph-node', { hasText: 'Leaf' })).toBeVisible() // pulled in

  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  await expect(page.locator('.graph-node', { hasText: 'Leaf' })).toHaveCount(0)
})
