import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The relation-typing bridge: naming an untyped [[link]] in the map writes a
// `relation:: [[target]]` field to the *source note*, and the edge re-renders
// typed (the bare links_to is superseded). Editing the map edits the notes.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-rel-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-rel-userdata-'))
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

test('naming a link writes a field to the note and the edge becomes typed', async () => {
  await page.locator('.graph-open-btn', { hasText: 'Map' }).click()
  await expect(page.locator('.graph-view')).toBeVisible()

  // Select welcome (the focus note) → its outbound links show in the inspector.
  await page.locator('.graph-node.is-focus').click()
  const row = page.locator('.graph-insp-edge', { hasText: 'Graph Model' })
  await expect(row.locator('.graph-insp-rel')).toContainText('links_to')

  // Name the link "cites".
  await row.locator('.graph-insp-name').click()
  await page.locator('.graph-insp-input').fill('cites')
  await page.locator('.graph-insp-input').press('Enter')

  // The note is rewritten + re-indexed; the edge is now typed (links_to dropped).
  // This round-trip (write field → harvest → buildGraph dedup → render) only
  // succeeds if the `cites:: [[Graph Model]]` field actually landed in the note.
  await expect(
    page.locator('.graph-insp-edge', { hasText: 'Graph Model' }).locator('.graph-insp-rel')
  ).toContainText('cites')
})
