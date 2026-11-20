import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

test('an attendance claim opens its figure before merge, after moving the PDF, and after restarting', async () => {
  test.setTimeout(90_000)
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'nodebook-figure-reader-')))
  const vault = join(temp, 'vault')
  const profile = join(temp, 'profile')
  mkdirSync(vault)
  mkdirSync(profile)
  writeFileSync(join(profile, 'settings.toml'), '[talk.chat]\nprovider = "openai-compat"\nmodel = "stub-vision"\nbaseUrl = "http://localhost:1234/v1"\n')
  const original = join(temp, 'Attendance.pdf')
  copyFileSync(join(__dirname, 'fixtures/distill/attendance-chart.pdf'), original)

  let app: ElectronApplication | undefined
  let page: Page
  const launch = async (): Promise<void> => {
    const binary = process.env.NODEBOOK_SMOKE_BINARY
    app = await launchElectron({ executablePath: binary, args: binary ? [] : [resolve(__dirname, '..')],
      env: { ...process.env, NODEBOOK_USER_DATA: profile, NODEBOOK_E2E: '1' } })
    if (binary) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    page = await app.firstWindow()
    await page.evaluate(() => { Object.assign(window, { __NODEBOOK_FAKE_EMBED__: true }) })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, vault)
    await page.getByRole('button', { name: 'Open vault', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Whole vault map' })).toBeVisible()
  }
  const loadedImage = async (): Promise<void> => {
    const image = page.getByRole('dialog').locator('.figure-image img')
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)
  }
  try {
    await launch()
    await app!.evaluate(({ BrowserWindow, dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
    }, original)
    await page!.getByRole('dialog').getByRole('button', { name: 'Distill', exact: true }).click()
    await page!.getByRole('button', { name: 'Continue with extracted text' }).click()
    const canvas = page!.getByRole('group', { name: 'Knowledge map notes' })
    await expect(canvas).toBeVisible({ timeout: 25000 })
    const [run] = await page!.evaluate(() => window.nodebook.distillListRuns())
    const source = join(vault, '.distill', run.id, 'notes', 'Attendance.md')
    const [figure] = await page!.evaluate(({ path, run }) => window.nodebook.noteFigures(path, run), { path: source, run: run.id })
    expect(figure.location).toContain('2')
    const relative = `figures/${figure.id}.${figure.ext}`
    expect(readFileSync(source, 'utf8')).toContain(`](${relative})`)
    const bytes = readFileSync(join(dirname(source), relative))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(figure.id)
    const wrong = await page!.evaluate(({ path, run, id }) =>
      window.nodebook.figureBytes(path, id, run), { path: original, id: figure.id, run: run.id })
    expect(wrong).toBeNull()

    // The PDF's first page points the reader to the chart on its next page.
    const claim = canvas.getByRole('button', { name: /the chart on the next/i }).first()
    await claim.press('Enter')
    await page!.getByRole('region', { name: 'Source figures' }).getByRole('button').first().click()
    await loadedImage()
    let dialog = page!.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Actual size' }).click()
    await expect(dialog.getByRole('button', { name: 'Fit figure' })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('heading', { name: 'AI interpretation' })).toHaveCount(0)
    await dialog.getByRole('button', { name: /Analyze figure/ }).click()
    await expect(dialog).toContainText('This is a test analysis of the selected figure.')
    await dialog.getByRole('button', { name: 'Close figure' }).click()
    await page!.getByRole('button', { name: '← Back to map' }).click()
    await canvas.getByRole('button', { name: 'Attendance', exact: true }).press('Enter')
    const thumbnail = page!.locator('.staged-note-rendered:visible img[data-figure-id]')
    await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)
    await thumbnail.press('Enter')
    await loadedImage()
    await page!.getByRole('button', { name: 'Close figure' }).click()
    await page!.evaluate((run) => window.nodebook.distillMerge(run), run.id)
    const canonical = join(vault, 'Sources', 'Attendance.md')
    expect(readFileSync(canonical, 'utf8')).toContain(`](${relative})`)
    expect(readFileSync(join(dirname(canonical), relative))).toEqual(bytes)
    await page!.evaluate((id) => window.nodebook.distillRemove(id), run.id)
    renameSync(original, join(temp, 'moved-away.pdf'))
    expect(existsSync(original)).toBe(false)
    await closeElectron(app)
    app = undefined
    await launch()

    // Locate the figure through the normal vault search and enter its source.
    const verifyOcr = process.env.NODEBOOK_TEST_OCR === '1' && process.platform === 'darwin'
    if (verifyOcr) expect(figure.ocr).toMatch(/participants per quarter/i)
    await page!.getByRole('textbox', { name: 'Search notes' }).fill(verifyOcr ? 'participants per quarter' : figure.label.split(/\s+/)[0])
    await page!.getByRole('button', { name: /^View figure ·/ }).first().click()
    await loadedImage()
    dialog = page!.getByRole('dialog')
    await expect(dialog).toContainText('This is a test analysis of the selected figure.')
    await dialog.getByRole('button', { name: 'Close figure' }).click()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'mode-reading'))
    const inline = page!.locator('.cm-source-figure img')
    await expect.poll(() => inline.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)

    // A purely visual document can be saved offline, even without a configured chat provider.
    const visual = join(temp, 'Photo.html')
    writeFileSync(visual, `<html><body><img src="data:image/png;base64,${bytes.toString('base64')}"></body></html>`)
    writeFileSync(join(profile, 'settings.toml'), '[talk.chat]\nprovider = "none"\n')
    const saved = await page!.evaluate(async (file) => {
      const api = window.nodebook
      const id = await api.distillRegisterPath(file)
      const preview = await api.distillEstimate(id)
      const run = await api.distillRun(id, '', undefined, preview.preparedId)
      return { calls: preview.calls, stats: run.stats, figures: run.figures?.length }
    }, visual)
    expect(saved).toMatchObject({ calls: 0, stats: { notes: 0, calls: 0 }, figures: 1 })
  } finally {
    await closeElectron(app)
    rmSync(temp, { recursive: true, force: true })
  }
})
