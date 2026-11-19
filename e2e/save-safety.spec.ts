import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ORIGINAL = '# Draft\n\nOriginal text.\n'
const EXTERNAL = '# Draft\n\nExternal revision.\n'
const LOCAL = 'Local draft.'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let app: ElectronApplication
let closeObserved = false
let page: Page
let work: string
let vault: string
let otherVault: string
let draft: string

async function launch(autosaveOnSwitch = true, nested = false): Promise<void> {
  work = mkdtempSync(join(tmpdir(), 'nodebook-save-safety-'))
  vault = join(work, 'First vault')
  otherVault = join(work, 'Second vault')
  const profile = join(work, 'profile')
  for (const dir of [vault, otherVault, profile]) mkdirSync(dir)
  const noteDir = nested ? join(vault, 'Folder') : vault
  if (nested) mkdirSync(noteDir)
  draft = join(noteDir, 'Draft.md')
  writeFileSync(draft, ORIGINAL)
  writeFileSync(join(vault, 'Other.md'), '# Other\n')
  writeFileSync(join(otherVault, 'Second.md'), '# Second\n')
  writeFileSync(join(profile, 'settings.toml'), `[editor]\nautosaveOnSwitch = ${autosaveOnSwitch}\n`)

  app = await electron.launch({
    args: [resolve(__dirname, '..')],
    env: { ...process.env, NODEBOOK_E2E: '1', NODEBOOK_USER_DATA: profile }
  })
  closeObserved = false
  app.on('close', () => { closeObserved = true })
  page = await app.firstWindow()
  await pickVault(vault)
  await page.getByRole('button', { name: 'Open vault', exact: true }).click()
  await note('Draft').click()
  await expect(page.locator('.cm-content')).toContainText('Original text.')
}

test.afterEach(async () => {
  // A failed assertion can leave a conflict dialog open in the disposable app.
  if (app && !closeObserved) {
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => setImmediate(() => app.exit())).catch(() => {})
    await closed
  }
  rmSync(work, { recursive: true, force: true })
})

async function pickVault(path: string): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, path)
}

const note = (name: string) => page.locator('.tree-file').filter({ hasText: new RegExp(`^${name}$`) })
const dialog = () => page.getByRole('dialog')
const options = (name: string) => dialog().getByRole('button', { name, exact: true })
const disk = () => readFileSync(draft, 'utf8')

async function edit(): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.insertText(LOCAL)
  await expect(page.locator('.tree-file.active .tree-dirty')).toBeVisible()
}

async function expectConflict(): Promise<void> {
  await expect(dialog()).toContainText('changed on disk')
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Draft')
  await expect(page.locator('.cm-content')).toContainText(LOCAL)
}

test('note switch waits for conflict resolution and Cancel preserves both versions', async () => {
  await launch()
  await edit()
  const { atime, mtime } = statSync(draft)
  writeFileSync(draft, EXTERNAL)
  // A reused mtime and a separate preview read cannot refresh the draft's baseline.
  utimesSync(draft, atime, mtime)
  const opened = await page.evaluate(async () => {
    const root = document.querySelector('.vault-path')!.getAttribute('title')!
    return window.nodebook.readFile(`${root}/Draft.md`)
  })
  expect(opened).toBe(EXTERNAL)
  await note('Other').click()
  await expectConflict()
  await options('Cancel').click()
  await expect(dialog()).toHaveCount(0)
  await expect(page.locator('.tree-file.active .tree-dirty')).toBeVisible()
  expect(disk()).toBe(EXTERNAL)

  await note('Other').click()
  await expectConflict()
  const newer = '# Draft\n\nAnother external revision.\n'
  writeFileSync(draft, newer)
  await options('Overwrite').click()
  // A change made while confirmation was open needs a fresh decision.
  await expectConflict()
  await expect(options('Cancel')).toBeFocused()
  expect(disk()).toBe(newer)
  await options('Overwrite').click()
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Other')
  expect(disk()).toContain(LOCAL)
})

test('vault switch keeps the old vault and draft until its conflict is resolved', async () => {
  await launch()
  await edit()
  writeFileSync(draft, EXTERNAL)
  await pickVault(otherVault)
  const open = page.getByRole('button', { name: 'Open vault', exact: true })
  await open.click()
  await expectConflict()
  await options('Cancel').click()
  await expect(page.locator('.vault-path')).toHaveText('First vault')
  await expect(page.locator('.cm-content')).toContainText(LOCAL)
  expect(disk()).toBe(EXTERNAL)

  await open.click()
  await expectConflict()
  await options('Overwrite').click()
  await expect(page.locator('.vault-path')).toHaveText('Second vault')
  await expect(note('Second')).toBeVisible()
  expect(disk()).toContain(LOCAL)
})

test('native window close and app quit share the checked save and permit cancellation', async () => {
  await launch()
  await edit()
  writeFileSync(draft, EXTERNAL)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  await expectConflict()
  await options('Cancel').click()
  await expect(dialog()).toHaveCount(0)
  expect(disk()).toBe(EXTERNAL)

  await app.evaluate(({ app }) => app.quit())
  await expectConflict()
  await options('Cancel').click()
  await expect(dialog()).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText(LOCAL)
  expect(disk()).toBe(EXTERNAL)

  await app.evaluate(({ app }) => app.quit())
  await expectConflict()
  const closed = app.waitForEvent('close')
  await options('Overwrite').click()
  await closed
  expect(disk()).toContain(LOCAL)
})

test('autosave off asks before losing a draft and saves only on request', async () => {
  await launch(false)
  await edit()
  await note('Other').click()
  await expect(dialog()).toContainText('Save your changes')
  await options('Cancel').click()
  await expect(page.locator('.cm-content')).toContainText(LOCAL)
  expect(disk()).toBe(ORIGINAL)

  await note('Other').click()
  await options('Discard').click()
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Other')
  expect(disk()).toBe(ORIGINAL)

  await note('Draft').click()
  await expect(page.locator('.cm-content')).not.toContainText(LOCAL)
  await edit()
  await note('Other').click()
  await options('Save').click()
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Other')
  expect(disk()).toContain(LOCAL)
})

test('rapid edit and switch saves the latest draft', async () => {
  await launch()
  await edit()
  await page.keyboard.press(`${MOD}+s`)
  await page.keyboard.insertText(' Last edit.')
  await note('Other').click()
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Other')
  expect(disk()).toContain(`${LOCAL} Last edit.`)
})

test('a write failure leaves the draft dirty and stops navigation', async () => {
  test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'requires POSIX write permissions')
  await launch()
  await edit()
  chmodSync(vault, 0o555)
  try {
    await note('Other').click()
    await expect(page.locator('.error-banner')).toContainText('Couldn\'t save “Draft”')
    await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Draft')
    await expect(page.locator('.tree-file.active .tree-dirty')).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText(LOCAL)
    expect(disk()).toBe(ORIGINAL)
  } finally {
    chmodSync(vault, 0o755)
  }
  await note('Other').click()
  await expect(page.locator('.tree-file.active .tree-name')).toHaveText('Other')
  expect(disk()).toContain(LOCAL)
})

for (const target of ['note', 'folder'] as const) {
  test(`renaming an active ${target} checks the draft before moving files`, async () => {
    const folder = target === 'folder'
    await launch(true, folder)
    await edit()
    writeFileSync(draft, EXTERNAL)
    const entry = folder
      ? page.locator('.tree-folder').filter({ hasText: 'Folder' })
      : page.locator('.tree-file.active')
    const rename = async (): Promise<void> => {
      await entry.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      await page.locator('.modal-input').fill('Renamed')
      await options('Rename').click()
      await expectConflict()
    }
    await rename()
    await options('Cancel').click()
    await expect(dialog()).toHaveCount(0)
    expect(disk()).toBe(EXTERNAL)
    const moved = folder ? join(vault, 'Renamed', 'Draft.md') : join(vault, 'Renamed.md')
    expect(existsSync(moved)).toBe(false)

    await rename()
    await options('Overwrite').click()
    await expect(page.locator('.tree-file.active .tree-dirty')).toHaveCount(0)
    await expect.poll(() => existsSync(moved)).toBe(true)
    await expect(page.locator('.cm-content')).toContainText(LOCAL)
    expect(readFileSync(moved, 'utf8')).toContain(LOCAL)
    expect(existsSync(draft)).toBe(false)
  })
}

test('moving a dirty note to the Trash requires an explicit discard and preserves disk bytes', async () => {
  await launch()
  await edit()
  writeFileSync(draft, EXTERNAL)
  const trashed = join(work, 'trashed.md')
  await app.evaluate(({ shell }, destination) => {
    const fs = process.getBuiltinModule('node:fs')!
    shell.trashItem = async (path) => fs.renameSync(path, destination)
  }, trashed)
  const remove = async (): Promise<void> => {
    await page.locator('.tree-file.active').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await expect(dialog()).toContainText('discard unsaved changes')
  }
  await remove()
  await options('Cancel').click()
  await expect(page.locator('.cm-content')).toContainText(LOCAL)
  expect(disk()).toBe(EXTERNAL)
  expect(existsSync(trashed)).toBe(false)

  await remove()
  await options('Move to Trash').click()
  await expect(page.locator('.tree-file.active')).toHaveCount(0)
  expect(readFileSync(trashed, 'utf8')).toBe(EXTERNAL)
  expect(existsSync(draft)).toBe(false)
})
