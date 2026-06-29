import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// D2 — provenance UX: a distilled note's `cite::` frontmatter shows as a Sources
// list; clicking a citation opens its source note scrolled to + selecting the
// cited character span.

const projectRoot = resolve(__dirname, '..')

let app: ElectronApplication
let page: Page

const SOURCE = '# Source Book\n\nThe quick brown fox jumps over the lazy dog, and faction arises from liberty.\n'
const NOTE = `---
kind: claim
source: source-book.md
cite:
  - chunk: 1
    span: 15-34
---
# Extended republic

source:: [[source-book]]

A large republic dilutes faction.
`

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-cite-'))
  mkdirSync(vaultDir, { recursive: true })
  writeFileSync(join(vaultDir, 'source-book.md'), SOURCE)
  writeFileSync(join(vaultDir, 'concept.md'), NOTE)
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-cite-userdata-'))

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
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

test('a cited note shows its Sources, and clicking one opens the source at the span', async () => {
  // Open the distilled note.
  await page.locator('.tree-file', { hasText: 'concept' }).click()
  await expect(page.locator('.cm-content')).toContainText('A large republic dilutes faction.')

  // Its frontmatter cite surfaces as a Sources entry.
  await expect(page.locator('.sources')).toBeVisible()
  const cite = page.locator('.source-cite')
  await expect(cite).toHaveCount(1)
  await expect(cite).toContainText('source-book')

  // Clicking it opens the source note...
  await cite.click()
  await expect(page.locator('.cm-content')).toContainText('The quick brown fox')
  // ...scrolled to + selecting the cited span (a non-empty selection is drawn).
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible()
})
