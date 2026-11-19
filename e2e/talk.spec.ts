import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// Verifies the whole "talk to docs" vertical — enable → chunk → embed → store →
// hybrid search — using a deterministic in-process embedder (window flag
// __NODEBOOK_FAKE_EMBED__), so CI never downloads a model and stays offline.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string

// Set NODEBOOK_SMOKE_BINARY to exercise an actual installed package.
async function launchWithVault(userDataDir: string): Promise<void> {
  const binary = process.env.NODEBOOK_SMOKE_BINARY
  app = await electron.launch({
    executablePath: binary,
    args: binary ? [] : [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  if (binary) {
    const loaded = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath() }))
    expect(loaded.packaged).toBe(true)
    expect(loaded.path).toMatch(/[/\\]app\.asar$/)
  }
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)

  page = await app.firstWindow()
  // Swap in the deterministic embedder before anything calls getEmbedder().
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__ = true
  })
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  const note = page.locator('.tree-file').first()
  const error = page.getByRole('alert')
  await expect(note.or(error)).toBeVisible()
  if (await error.isVisible()) throw new Error(await error.innerText())
}

test.beforeAll(async () => {
  vaultDir = realpathSync(mkdtempSync(join(tmpdir(), 'nodebook-talk-')))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-talk-userdata-'))
  await launchWithVault(userDataDir)
})

test.afterAll(async () => {
  await app?.close()
})

test('off by default: an honest CTA, no dead toggles, keyword search only', async () => {
  await expect(page.locator('.talk-cta')).toBeVisible()
  await expect(page.locator('.talk-status')).toHaveCount(0)
  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(false)
})

test('enable: setup card → indexes the vault → semantic search goes live', async () => {
  await page.locator('.talk-cta').click()
  await expect(page.locator('.talk-setup')).toBeVisible()
  await page.locator('.talk-enable').click()

  // Indexing finishes and the status flips to "on".
  await expect(page.locator('.talk-status .talk-on')).toBeVisible({ timeout: 9000 })

  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(true)
  expect(status.ready).toBe(true)
  expect(status.total).toBeGreaterThan(0)
  expect(status.pending).toBe(0) // fully embedded
})

test('hybrid search surfaces a note and marks the meaning-matched hit with ✨', async () => {
  await page.locator('.search-box').fill('claim') // a word that lives in welcome.md
  await expect(page.locator('.search-results li').first()).toBeVisible()
  await expect(page.locator('.search-result-ai').first()).toBeVisible()

  // The hit opens its note.
  await page.locator('.search-results li').first().click()
  await expect(page.locator('.cm-content')).toContainText('claim')
  await page.locator('.search-box').fill('')
})

test('turn off: drops the embeddings and reverts to the CTA (reversible)', async () => {
  await page.locator('.talk-link', { hasText: 'Turn off' }).click()
  await expect(page.locator('.talk-cta')).toBeVisible()
  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.enabled).toBe(false)
  expect(status.total).toBe(0) // chunks + vectors dropped
})

test('stale embedding batches cannot write across an edit, model change, or vault reopen', async () => {
  // Enable directly after the preceding test stopped the renderer drain.
  const result = await page.evaluate(async (root) => {
    const api = window.nodebook
    const { vaultId } = await api.talkStatus()
    const { talk } = await api.readSettings()
    const { generation } = await api.talkEnable(vaultId!, talk.embed.model, 2)
    const path = (await api.createFile(root, 'Race'))!
    const original = await api.readFile(path)
    await api.saveFile(path, 'Before embedding.', original)
    const stale = (await api.talkPending(generation!, 100)).find((c) => c.text === 'Before embedding.')!
    await api.saveFile(path, 'After editing.', 'Before embedding.')
    const edited = (await api.talkPending(generation!, 100)).find((c) => c.text === 'After editing.')!
    const staleRows = [{ id: stale.id, vector: [1, 0] }]
    await api.talkPutEmbeddings(generation!, staleRows)
    const pendingAfterEdit = await api.talkPending(generation!, 100)

    const settingsPath = await api.settingsPath()
    const settings = await api.readFile(settingsPath)
    const newModel = 'test/new-model'
    await api.saveFile(settingsPath, settings.replace(talk.embed.model, newModel), settings)
    const afterModel = await api.talkEnable(vaultId!, newModel, 2)
    await api.talkPutEmbeddings(generation!, [{ id: edited.id, vector: [1, 0] }])
    const beforeReopen = await api.talkPending(afterModel.generation!, 100)

    await api.openVault(root)
    const reopened = await api.talkStatus()
    await api.talkPutEmbeddings(afterModel.generation!, [{ id: beforeReopen[0].id, vector: [1, 0] }])
    const afterReopen = await api.talkPending(reopened.generation!, 100)

    return { stale, edited, pendingAfterEdit, generation, afterModel, beforeReopen, reopened, afterReopen }
  }, vaultDir)
  expect(result.stale.id).not.toEqual(result.edited.id)
  expect(result.pendingAfterEdit).toContainEqual(result.edited)
  expect(result.afterModel.generation).not.toEqual(result.generation)
  expect(result.beforeReopen).toContainEqual(expect.objectContaining({ text: 'After editing.' }))
  expect(result.reopened.generation).not.toEqual(result.afterModel.generation)
  expect(result.afterReopen).toEqual(result.beforeReopen)
})

test('a cold launch with semantic search enabled can open and search a vault', async () => {
  await app.close()
  const profile = mkdtempSync(join(tmpdir(), 'nodebook-talk-cold-'))
  writeFileSync(join(profile, 'settings.toml'), '[talk]\nenabled = true\n')
  await launchWithVault(profile)
  await expect(page.locator('.talk-status .talk-on')).toBeVisible()
  await page.locator('.search-box').fill('claim')
  await expect(page.locator('.search-result-ai').first()).toBeVisible()
  const status = await page.evaluate(() => window.nodebook.talkStatus())
  expect(status.ready).toBe(true)
  expect(status.total).toBeGreaterThan(0)
  expect(status.pending).toBe(0)
})
