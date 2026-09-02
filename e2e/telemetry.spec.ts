import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { LAG_BUCKETS } from '../src/main/telemetry'

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
  // A chat provider too, so the distill test below can run (the model is a stub
  // under NODEBOOK_E2E) — the point is what indexing a whole book costs main.
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[telemetry]\nenabled = true\n\n[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )

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
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__ = true
  })
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

test('merging a whole book never stalls the app', async () => {
  // A real 21-page PDF: convert, distil, then merge it into the vault. The
  // merge indexes every new note on the main process — including the book
  // itself, ~77 KB of prose. A `kind: document` note takes the cheap path
  // (title + full text for search, no markdown parse, no knowledge edges), so
  // this must never cost the user a visible freeze.
  const paper = join(__dirname, 'fixtures', 'distill', 'paper.pdf')
  const run = await page.evaluate(async (path) => {
    const id = await window.nodebook.distillRegisterPath(path)
    return window.nodebook.distillRun(id)
  }, paper)
  expect(run.stats.notes).toBeGreaterThan(0)

  const merged = await page.evaluate((r) => window.nodebook.distillMerge(r), run.runId)
  expect(merged.count).toBeGreaterThan(0)

  const snap = await page.evaluate(() => window.nodebook.telemetrySnapshot())
  expect(snap).not.toBeNull()
  // The two slowest buckets (≥4096 ms and ≥8192 ms) stay empty: nothing this
  // run did held the event loop for seconds at a time.
  expect(snap!.lag.buckets.slice(LAG_BUCKETS - 2)).toEqual([0, 0])
})
