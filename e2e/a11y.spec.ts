import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Accessibility: modal dialogs must be announced (role="dialog"/aria-modal),
// move focus inside on open, trap Tab, and restore focus to the trigger on close.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  test.setTimeout(45_000) // sorts first → pays the cold electron-launch cost
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-a11y-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-a11y-userdata-'))
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

test('a confirm dialog traps focus, defaults to Cancel, and Escape restores focus', async () => {
  await page.locator('.settings-btn').click()
  const reset = page.locator('.settings-reset', { hasText: 'Reset' })
  await reset.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  // Opens with Cancel focused — a stray Enter won't fire the destructive action.
  await expect(page.locator('.modal-btn', { hasText: 'Cancel' })).toBeFocused()
  // Tab moves to the danger button; Tab again wraps back inside the dialog.
  await page.keyboard.press('Tab')
  await expect(page.locator('.modal-btn-danger')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator('.modal-btn', { hasText: 'Cancel' })).toBeFocused()
  // Escape closes and returns focus to the trigger.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(reset).toBeFocused()

  await page.locator('.tree-file', { hasText: 'welcome' }).click() // leave settings
})

test('a prompt dialog is a labelled dialog that focuses its input; Escape cancels', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'New note' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.modal-input')).toBeFocused() // focus moved into the field
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('the context menu is a keyboard-operable menu', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('role', 'menu')
  await expect(menu.locator('.context-menu-item').first()).toBeFocused() // opens focused
  await page.keyboard.press('ArrowDown') // arrows move focus between items
  await expect(menu.locator('.context-menu-item').nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.context-menu')).toHaveCount(0)
})

test('the status-bar selector is an accessible menu button', async () => {
  const trigger = page.locator('.status-select-mode .status-btn')
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const menu = page.locator('.status-select-mode .status-menu')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3) // code / live / reading

  // Escape closes and restores focus to the trigger button.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('list rows are focusable and open with Enter (tree + search)', async () => {
  const row = page.locator('.tree-file', { hasText: 'Graph Model' })
  await row.focus()
  await expect(row).toBeFocused()
  await row.press('Enter')
  await expect(page.locator('.tree-file.active')).toHaveText('Graph Model')

  await page.locator('.search-box').fill('claim') // only welcome contains "claim"
  await expect(page.locator('.search-result-title')).toBeVisible() // a real result, not "No matches"
  const hit = page.locator('.search-results li').first()
  await hit.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('claim')
  await page.locator('.search-box').fill('') // restore the tree
})
