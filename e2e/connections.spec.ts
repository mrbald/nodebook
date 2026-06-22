import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The right-side Connections panel lists a note's outbound links/properties and
// its backlinks — but a note that references *itself* is noise, not navigation,
// so self-references are filtered from both sections.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // This spec sorts first, so its beforeAll pays the cold electron-launch +
  // index-build cost; give the *setup* hook headroom (the test itself still
  // runs under the 10s ceiling).
  test.setTimeout(45_000)
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-conn-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  // A note that links to itself *and* to a real neighbour, present at startup so
  // it is indexed by the open-scan (deterministic — no watcher race).
  writeFileSync(
    join(vaultDir, 'SelfRef.md'),
    '# SelfRef\n\nThis mentions [[SelfRef]] itself, plus [[Graph Model]].\n'
  )
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-conn-userdata-'))
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

test('the Connections panel hides self-references', async () => {
  await page.locator('.tree-file', { hasText: 'SelfRef' }).click()
  const panel = page.locator('.backlinks')

  // The real outbound link to a neighbour shows…
  await expect(panel.locator('.outbound-item', { hasText: 'Graph Model' })).toBeVisible()
  // …but the [[SelfRef]] self-link is filtered out of both Links and Backlinks.
  await expect(panel.locator('.outbound-item', { hasText: 'SelfRef' })).toHaveCount(0)
  await expect(panel.locator('.backlinks-item', { hasText: 'SelfRef' })).toHaveCount(0)
})
