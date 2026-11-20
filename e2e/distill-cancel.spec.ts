import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const projectRoot = resolve(__dirname, '..')
const RUN_ID = 'on-government'
const FOCUS = 'what happens, in order: events, dates, and what led to what'
// Give the spec time to interact before the preflight and each extraction finish.
const CHAT_DELAY_MS = 3000

let app: ElectronApplication
let page: Page
let fixture: string
let vaultDir: string
let userDataDir: string
let bookPath: string

const BOOK = [
  '# On Government',
  '',
  '## Faction',
  'Faction arises from the unequal distribution of property among the citizens.',
  '',
  '## Republic',
  'A republic refines public views by passing them through elected representatives.',
  '',
  '## Powers',
  'The accumulation of all powers in the same hands is the very definition of tyranny.',
  '',
  '## Ambition',
  'Ambition must be made to counteract ambition so that power checks power.',
  ''
].join('\n')

test.beforeEach(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'nodebook-distill-cancel-'))
  vaultDir = join(fixture, 'vault')
  userDataDir = join(fixture, 'profile')
  mkdirSync(vaultDir)
  mkdirSync(userDataDir)
  writeFileSync(join(vaultDir, 'Existing note.md'), '# Existing note\n')
  // One reading window per section so a pause can leave a completed window.
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n\n[distill]\nwindowSize = 1\n'
  )
  bookPath = join(fixture, `${RUN_ID}.md`)
  writeFileSync(bookPath, BOOK)
  await launchApp()
  await openVault()
})

test.afterEach(async () => {
  try {
    await closeElectron(app)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

async function launchApp(): Promise<void> {
  const binary = process.env.NODEBOOK_SMOKE_BINARY
  app = await launchElectron({
    executablePath: binary,
    args: binary ? [] : [projectRoot],
    env: {
      ...process.env,
      NODEBOOK_USER_DATA: userDataDir,
      NODEBOOK_E2E: '1',
      NODEBOOK_E2E_LIVE_CHAT: '',
      NODEBOOK_E2E_CHAT_DELAY_MS: String(CHAT_DELAY_MS)
    }
  })
  if (binary) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  page = await app.firstWindow()
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__ = true
  })
}

async function openVault(vault = vaultDir, note = 'Existing note'): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vault)
  await page.getByRole('button', { name: 'Open vault', exact: true }).click()
  await expect(page.locator('.tree-file')).toContainText(note)
}

async function startRun(): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  const modal = page.locator('.modal', { hasText: 'What should the notes focus on?' })
  await expect(modal).toBeVisible({ timeout: 15_000 })
  await modal.getByRole('button', { name: 'Timeline' }).click()
  await expect(modal.locator('.modal-input')).toHaveValue(FOCUS)
  await modal.getByRole('button', { name: 'Distill' }).click()
}

async function expectReadWindows(count: number): Promise<void> {
  await expect(page.locator('.distill-toast')).toContainText(`extracting concepts (${count}/4)`, {
    timeout: 15_000
  })
}

async function cancelRun(): Promise<void> {
  await page.getByRole('button', { name: 'Pause', exact: true }).click({ timeout: 2000 })
  await expect(page.locator('.distill-toast')).toBeHidden({ timeout: 15_000 })
  await expect(page.locator('.distill-coverage-banner')).toContainText(/cancelled|paused/i)
}

async function expectPaused(): Promise<void> {
  await expect(page.locator('.run-item-meta')).toHaveText('paused')
  await expect(page.locator('.run-item-resume')).toBeEnabled()
  await expect(page.locator('.run-item-focus')).toContainText(FOCUS)
  expect(await page.evaluate(() => window.nodebook.distillListRuns())).toMatchObject([
    { id: RUN_ID, notes: 0, focus: FOCUS, merged: false, unfinished: true }
  ])
}

function runFile(name: string): string {
  return join(vaultDir, '.distill', RUN_ID, name)
}

function checkpointLines(): string[] {
  return readFileSync(runFile('progress.jsonl'), 'utf8').trimEnd().split('\n')
}

async function expectFinished(runMarker: string): Promise<void> {
  await expect(page.locator('.distill-toast')).toBeHidden({ timeout: 45_000 })
  await expect(page.locator('.distill-coverage-banner')).toContainText('Staged')
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs).toMatchObject([{ id: RUN_ID, unfinished: false, focus: FOCUS }])
  expect(runs[0].notes).toBeGreaterThan(0)
  expect(readFileSync(runFile('run.json'), 'utf8')).toBe(runMarker)
  await expect(page.locator('.run-item-focus')).toContainText(FOCUS)
  await expect(page.locator('.run-item-resume')).toHaveCount(0)
}

test('reopen a paused run, activate Resume twice, then pause and finish the same run', async () => {
  test.setTimeout(60_000)

  await startRun()
  await expectReadWindows(1)
  await cancelRun()
  await expectPaused()
  await expect(page.locator('.error-banner')).toHaveCount(0)
  const runMarker = readFileSync(runFile('run.json'), 'utf8')
  const savedLines = checkpointLines()
  expect(savedLines.map((line) => JSON.parse(line))).toMatchObject([
    { type: 'plan' }, { type: 'window', index: 0 }
  ])

  await closeElectron(app)
  await launchApp()
  await openVault()
  await expectPaused()

  const toast = page.locator('.distill-toast')
  // Enter on the Resume button, then click the row while the model probe waits.
  await page.locator('.run-item-resume').press('Enter')
  await expect(toast).toContainText(/starting|resuming/i, { timeout: 1000 })
  const originalToast = await toast.elementHandle()
  await expect.soft(page.locator('.run-item-meta')).toHaveText('resuming', { timeout: 1000 })
  await page.getByText(RUN_ID, { exact: true }).click({ force: true })
  await expectReadWindows(2)
  // The first progress event must not have to remount a toast cleared by a rejected second call.
  expect.soft(await originalToast.evaluate((element) => element.isConnected), 'the original progress toast remains mounted').toBe(true)
  await originalToast.dispose()
  expect.soft(await page.locator('.error-banner').allTextContents()).toEqual([])

  await cancelRun()
  await expectPaused()
  const resumedLines = checkpointLines()
  expect(resumedLines.slice(0, savedLines.length)).toEqual(savedLines)
  expect(resumedLines.map((line) => JSON.parse(line))).toMatchObject([
    { type: 'plan' }, { type: 'window', index: 0 }, { type: 'window', index: 1 }
  ])
  expect(readFileSync(runFile('run.json'), 'utf8')).toBe(runMarker)

  await page.locator('.run-item-resume').click()
  await expectReadWindows(2)
  await expectFinished(runMarker)
})

test('opening the same vault during distill keeps the current run cancellable', async () => {
  test.setTimeout(30_000)

  await startRun()
  await expectReadWindows(0)
  await openVault()
  await expectReadWindows(1)
  await cancelRun()
  await expectPaused()
  await expect(page.locator('.error-banner')).toHaveCount(0)
})

test('pause during preflight, switch vaults during resume, then finish in the original vault', async () => {
  test.setTimeout(45_000)
  const anotherVault = join(fixture, 'another-vault')
  mkdirSync(anotherVault)
  writeFileSync(join(anotherVault, 'Another note.md'), '# Another note\n')

  await startRun()
  await expect(page.locator('.distill-toast')).toContainText('starting')
  await cancelRun()
  await expectPaused()
  const runMarker = readFileSync(runFile('run.json'), 'utf8')
  expect(existsSync(runFile('progress.jsonl'))).toBe(false)

  await page.locator('.run-item-resume').click()
  await expect(page.locator('.run-item-meta')).toHaveText('resuming', { timeout: 1000 })
  await openVault(anotherVault, 'Another note')
  await expect(page.locator('.distill-toast')).toBeHidden()
  await expect(page.locator('.run-item')).toHaveCount(0)
  await expect(page.locator('.distill-coverage-banner')).toHaveCount(0)
  await expect(page.locator('.error-banner')).toHaveCount(0)

  await openVault()
  await expectPaused()
  expect(existsSync(runFile('progress.jsonl'))).toBe(false)
  await page.locator('.run-item-resume').click()
  await expectReadWindows(0)
  await expectFinished(runMarker)
  await expect(page.locator('.error-banner')).toHaveCount(0)
})
