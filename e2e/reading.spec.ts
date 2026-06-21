import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Reading mode polish (isolated, fresh vault — no accumulated edits): code fences
// are hidden, internal vs external links are visually distinct, ghost wikilinks
// are marked.
const projectRoot = resolve(__dirname, '..')
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vault = mkdtempSync(join(tmpdir(), 'nodebook-reading-'))
  writeFileSync(
    join(vault, 'Note.md'),
    [
      '# Note',
      '',
      'A link to [[Real]] and a [[Missing]] one.',
      'An external [site](https://example.com).',
      '',
      '```js',
      'const x = 1',
      '```',
      ''
    ].join('\n')
  )
  writeFileSync(join(vault, 'Real.md'), '# Real\n')
  const ud = mkdtempSync(join(tmpdir(), 'nodebook-reading-ud-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: ud, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
  }, vault)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.locator('.tree-file', { hasText: 'Note' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  // Switch to Reading mode and wait until it's actually active (read-only).
  await page.locator('.status-select-mode .status-btn').click()
  await page.locator('.status-select-mode .status-menu-item', { hasText: 'Reading' }).click()
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
})

test.afterAll(async () => {
  await app?.close()
})

test('Reading mode hides the ``` fences but keeps the code', async () => {
  // The fence lines are collapsed via display:none, so use innerText (which
  // excludes hidden text) — textContent would still include the hidden ```.
  await expect(page.locator('.cm-fence-hidden')).toHaveCount(2)
  const visible = await page.locator('.cm-content').innerText()
  expect(visible).not.toContain('```')
  expect(visible).toContain('const x = 1')
})

test('a wikilink to a missing note is marked as a ghost', async () => {
  await expect(page.locator('.cm-wikilink', { hasText: 'Real' })).not.toHaveClass(/is-ghost/)
  await expect(page.locator('.cm-wikilink.is-ghost', { hasText: 'Missing' })).toBeVisible()
})

test('external links are visually distinct (separate class from wikilinks)', async () => {
  await expect(page.locator('.cm-md-link', { hasText: 'site' })).toBeVisible()
  await expect(page.locator('.cm-wikilink')).toHaveCount(2) // Real + Missing, not the external one
})
