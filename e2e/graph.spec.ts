import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The knowledge-map MVP: open a note's local graph, see its links as nodes/edges,
// click a neighbour to navigate.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-graph-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-graph-userdata-'))
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
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
})

test.afterAll(async () => {
  await app?.close()
})

test('the ⊹ Map button opens a force-directed graph with nodes and edges', async () => {
  await page.locator('.graph-open-btn', { hasText: 'Map' }).click()
  await expect(page.locator('.graph-view')).toBeVisible()
  await expect(page.locator('.graph-title')).toContainText('welcome')

  // Focus (welcome) + its two neighbours; the neighbours are themselves linked
  // (Roadmap → Graph Model), so the local slice shows all three edges.
  await expect(page.locator('.graph-node')).toHaveCount(3)
  await expect(page.locator('.graph-node.is-focus')).toHaveText(/welcome/)
  await expect(page.locator('.graph-node', { hasText: 'Graph Model' })).toBeVisible()
  await expect(page.locator('.graph-edge')).toHaveCount(3)
})

test('clicking a neighbour node recenters the map on it', async () => {
  await page.locator('.graph-node', { hasText: 'Graph Model' }).click()
  await expect(page.locator('.graph-title')).toContainText('Graph Model')
  // Graph Model is linked from welcome and projects/Roadmap → at least those appear.
  await expect(page.locator('.graph-node.is-focus')).toHaveText(/Graph Model/)
})

test('Close returns to the editor', async () => {
  await page.locator('.graph-close').click()
  await expect(page.locator('.graph-view')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
})
