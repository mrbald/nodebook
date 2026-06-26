import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Application-menu commands. Playwright can't click the native menu bar, so we
// drive the renderer-facing `menu:command` channel directly (as editor.spec does
// for export-pdf/help) and assert the effects. The menu *structure* is covered
// by the pure menu.test.ts unit test.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultA: string
let vaultB: string
let userDataDir: string

async function menuCmd(cmd: string, arg?: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { cmd, arg }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', cmd, arg)
    },
    { cmd, arg }
  )
}

test.beforeAll(async () => {
  test.setTimeout(45_000)
  vaultA = mkdtempSync(join(tmpdir(), 'nodebook-menuA-'))
  cpSync(fixtureVault, vaultA, { recursive: true, filter: (s) => !s.split(sep).includes('.nodebook') })
  vaultB = mkdtempSync(join(tmpdir(), 'nodebook-menuB-'))
  writeFileSync(join(vaultB, 'BetaNote.md'), '# BetaNote\n\nonly in vault B\n')
  userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-menu-ud-'))

  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultA)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

test('opening a vault records it in recents.json (powers Open Recent)', () => {
  const recents = JSON.parse(readFileSync(join(userDataDir, 'recents.json'), 'utf8'))
  expect(recents).toContain(realpathSync(vaultA))
})

test('menu command: Preferences/settings opens the Settings pane', async () => {
  await menuCmd('settings')
  await expect(page.locator('.settings-title')).toHaveText('Settings')
  // return to the editor for later tests
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
})

test('menu command: Knowledge Map opens the map', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await menuCmd('map')
  await expect(page.locator('.graph-view')).toBeVisible()
  await page.locator('.graph-close').click()
  await expect(page.locator('.graph-view')).toHaveCount(0)
})

test('menu command: open-vault switches to another vault by path', async () => {
  await menuCmd('open-vault', realpathSync(vaultB))
  await expect(page.locator('.tree-file', { hasText: 'BetaNote' })).toBeVisible()
  // vault B is now the most-recent entry
  const recents = JSON.parse(readFileSync(join(userDataDir, 'recents.json'), 'utf8'))
  expect(recents[0]).toBe(realpathSync(vaultB))
})

test('menu command: new-note prompts and creates a note', async () => {
  await menuCmd('new-note')
  await page.locator('.modal-input').fill('Menu Made Note')
  await page.locator('.modal-btn-primary').click()
  await expect(page.locator('.tree-file', { hasText: 'Menu Made Note' })).toBeVisible()
})
