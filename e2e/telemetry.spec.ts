import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Telemetry is opt-in: pre-seed settings.toml with it enabled, then verify the
// widget renders, main is actually measuring, and the pfw credit link works.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-tel-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-tel-userdata-'))
  writeFileSync(join(userDataDir, 'settings.toml'), '[telemetry]\nenabled = true\n')

  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  await app.evaluate(async ({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = (async (u: string) => {
      g.__opened.push(u)
    }) as typeof shell.openExternal
  })

  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.locator('.tree-file', { hasText: 'welcome' }).click() // open a note → status bar shows
})

test.afterAll(async () => {
  await app?.close()
})

test('the widget renders in the status bar when telemetry is enabled', async () => {
  await expect(page.locator('.telemetry-mini')).toBeVisible()
})

test('main is measuring: snapshot has the lag histogram + CPU/RAM', async () => {
  const snap = await page.evaluate(() => window.nodebook.telemetrySnapshot())
  expect(snap).not.toBeNull()
  expect(snap!.lag.buckets).toHaveLength(15)
  expect(snap!.lag.count).toBeGreaterThan(0)
  expect(snap!.cpu.length).toBeGreaterThan(0)
  // A healthy loop never lands in the slowest (≥8192 ms) bucket.
  expect(snap!.lag.buckets[14]).toBe(0)
})

test('clicking opens the popover with stats and the pfw credit link', async () => {
  await page.locator('.telemetry-mini').click()
  await expect(page.locator('.telemetry-popover')).toBeVisible()
  await expect(page.locator('.telemetry-popover')).toContainText('Event-loop lag')

  await page.locator('.telemetry-credit').click()
  const opened = await app.evaluate(
    () => (globalThis as unknown as { __opened: string[] }).__opened
  )
  expect(opened).toContain('https://github.com/mrbald/pfw')
})
