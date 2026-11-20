import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { closeElectron, expect, launchElectron, test } from './electron'

const projectRoot = resolve(__dirname, '..')
const runId = 'Legacy run'
const title = 'Legacy book'
const text = 'Русский текст о старой книге. История была записана в конце века.'
const original = Buffer.from(Array.from(text.repeat(12), (letter) => {
  const code = letter.charCodeAt(0)
  return code < 128 ? code : 0xc0 + code - 0x0410
}))
const damaged = original.toString('utf8')
const oldQuote = damaged.slice(0, 38)

async function setPicker(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
}

async function openRun(page: Page): Promise<void> {
  await page.locator('.run-item', { has: page.getByText(runId, { exact: true }) }).press('Enter')
}

async function openStagedNote(page: Page, name: string): Promise<void> {
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await canvas.getByRole('button', { name, exact: true }).press('Enter')
  await expect(page.locator('.staged-note-title:visible')).toContainText(name)
}

test('saves a verified reading copy through the staged reader and keeps old citation evidence after restart', async () => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'nodebook-reading-copy-'))
  const vault = join(fixture, 'vault')
  const userData = join(fixture, 'user-data')
  const root = join(vault, '.distill', runId)
  const notes = join(root, 'notes')
  const sourceNote = join(notes, `${title}.md`)
  const conceptNote = join(notes, 'Concept.md')
  const originalPath = join(fixture, `${title}.txt`)
  const unrelated = join(fixture, 'unrelated.txt')
  const concept = `---\nsource: ${title}\ncite:\n  - chunk: 1\n    span: 0-${oldQuote.length}\n    quote: ${JSON.stringify(oldQuote)}\n---\n# Concept\n\nsource:: [[${title}]]\n`
  const meta = JSON.stringify({ source: `${title}.txt`, notes: 1 })
  mkdirSync(notes, { recursive: true })
  mkdirSync(userData)
  writeFileSync(sourceNote, damaged)
  writeFileSync(conceptNote, concept)
  writeFileSync(join(root, 'meta.json'), meta)
  writeFileSync(originalPath, original)
  writeFileSync(unrelated, 'Unrelated text.')

  let app: ElectronApplication | undefined
  async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
    const binary = process.env.NODEBOOK_SMOKE_BINARY
    const next = await launchElectron({
      executablePath: binary,
      args: binary ? [] : [projectRoot],
      env: { ...process.env, NODEBOOK_USER_DATA: userData, NODEBOOK_E2E: '1' }
    })
    app = next
    if (binary) expect(await next.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await setPicker(next, vault)
    const page = await next.firstWindow()
    await page.getByRole('button', { name: 'Open vault' }).click()
    await openRun(page)
    return { app: next, page }
  }

  try {
    const first = await launch()
    await openStagedNote(first.page, title)
    const locate = first.page.getByRole('button', { name: 'Locate original…' })
    await expect(first.page.getByText(/source contains damaged text/)).toBeVisible()
    await setPicker(first.app, unrelated)
    await locate.click()
    await expect(first.page.getByRole('alert')).toContainText('does not match the staged source')
    expect(existsSync(join(userData, 'reading-copies'))).toBe(false)

    await setPicker(first.app, originalPath)
    await locate.click()
    await expect(first.page.getByRole('heading', { name: 'Reading copy preview' })).toBeFocused()
    const encoding = first.page.getByLabel('Text encoding')
    await encoding.selectOption('utf-8')
    await expect(first.page.getByRole('button', { name: 'Use reading copy' })).toBeDisabled()
    await encoding.selectOption('windows-1251')
    await expect(first.page.getByLabel('Decoded text preview')).toContainText(text)
    await first.page.getByRole('button', { name: 'Use reading copy' }).click()
    await expect(first.page.locator('.staged-note-rendered:visible')).toContainText(text)
    await first.page.getByRole('button', { name: 'Show run text' }).click()
    await expect(first.page.locator('.staged-note-rendered:visible')).toContainText(oldQuote)
    await first.page.getByRole('button', { name: 'Show reading copy' }).click()
    await expect(first.page.locator('.staged-note-rendered:visible')).toContainText(text)

    expect(readFileSync(sourceNote, 'utf8')).toBe(damaged)
    expect(readFileSync(conceptNote, 'utf8')).toBe(concept)
    expect(readFileSync(join(root, 'meta.json'), 'utf8')).toBe(meta)
    await closeElectron(first.app)
    app = undefined
    rmSync(originalPath)

    const { page } = await launch()
    await openStagedNote(page, title)
    await expect(page.locator('.staged-note-rendered:visible')).toContainText(text)
    await page.getByRole('button', { name: /Back to map/ }).click()
    await openStagedNote(page, 'Concept')
    await expect(page.getByText(/note was extracted from damaged text/)).toBeVisible()
    await page.locator('.source-cite:visible').click()
    await expect(page.getByText(/passage comes from the damaged source/)).toBeVisible()
    await expect(page.locator('.staged-source mark')).toHaveText(oldQuote)
  } finally {
    await closeElectron(app)
    rmSync(fixture, { recursive: true, force: true })
  }
})
