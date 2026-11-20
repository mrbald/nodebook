import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const projectRoot = resolve(__dirname, '..')
const UNMATCHED_COUNT = 207
const indexedNotes: Record<string, string> = {
  Alder: '# Woodland field notes\n\n[[Ash]] and [[Beech]].\n',
  Ash: '# Ash readings\n\n[[Alder]] and [[Beech]].\n',
  Beech: '# Beech measurements\n\n[[Alder]].\n',
  Plane: '# Flight log\n\n[[Engine]] and [[Wing]].\n',
  Engine: '# Engine performance\n\n[[Plane]] and [[Wing]].\n',
  Wing: '# Wing measurements\n\n[[Plane]].\n'
}
const vectorNames = ['V1 Apple', 'V1 Pear', 'V1 Plum', 'V2 Mercury', 'V2 Venus', 'V2 Mars']
let app: ElectronApplication
let page: Page
let vault: string

test.beforeAll(async () => {
  vault = realpathSync(mkdtempSync(join(tmpdir(), 'nodebook-vault-themes-')))
  for (const [file, markdown] of Object.entries(indexedNotes)) writeFileSync(join(vault, `${file}.md`), markdown)
  for (const name of vectorNames) writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nLocal vector fixture.\n`)
  for (let i = 0; i < UNMATCHED_COUNT; i++) {
    const name = `Unsorted ${String(i).padStart(3, '0')}`
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nAn individual note.\n`)
  }
  mkdirSync(join(vault, '.distill', 'staged'), { recursive: true })
  writeFileSync(join(vault, '.distill', 'staged', 'Staged only.md'), '# Staged only\n\n[[Alder]].\n')

  const binary = process.env.NODEBOOK_SMOKE_BINARY
  app = await launchElectron({
    executablePath: binary,
    args: binary ? [] : [projectRoot],
    env: {
      ...process.env,
      NODEBOOK_USER_DATA: mkdtempSync(join(tmpdir(), 'nodebook-vault-themes-userdata-')),
      NODEBOOK_E2E: '1'
    }
  })
  if (binary) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  page = await app.firstWindow()
  await openVault(vault)
})

test.afterAll(async () => {
  await closeElectron(app)
})

async function openVault(path: string): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, path)
  await page.getByRole('button', { name: 'Open vault' }).click()
  await expect(page.getByRole('button', { name: 'Whole vault map' })).toBeVisible()
}

test('the optional Themes view preserves the whole-vault map and returns from a note to its trigger', async () => {
  await page.getByRole('button', { name: 'Whole vault map' }).click()
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
  const scene = canvas.locator(':scope > g[transform]')
  const before = await scene.getAttribute('transform')
  await canvas.hover()
  await page.mouse.wheel(0, -300)
  await expect(scene).not.toHaveAttribute('transform', before!)
  const camera = await scene.getAttribute('transform')

  const toggle = page.getByRole('button', { name: 'Themes', exact: true })
  await toggle.press('Enter')
  const themes = page.getByRole('region', { name: 'Vault themes' })
  await expect(themes.getByRole('heading', { name: 'Vault themes' })).toBeFocused()
  await expect(themes).toContainText('2 themes · 219 notes')
  await expect(themes.getByTitle('App theme')).toBeVisible()
  await expect(themes.getByRole('button', { name: /Close/ })).toBeVisible()
  await expect(canvas).toBeHidden()
  const woodland = themes.getByRole('button', { name: /Woodland field notes 3 notes/ })
  await expect(woodland).toContainText('Ash readings')
  await woodland.press('Enter')
  await expect(themes.getByRole('heading', { name: 'Woodland field notes' })).toBeFocused()
  await expect(themes.getByTitle('App theme')).toBeVisible()
  await expect(themes.getByRole('button', { name: /Close/ })).toBeVisible()
  const beech = themes.getByRole('button', { name: /Beech measurements/ })
  await beech.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Beech measurements')
  await page.getByRole('button', { name: '← Back to map', exact: true }).press('Enter')
  await expect(beech).toBeFocused()

  await themes.getByRole('button', { name: '← Back to vault themes' }).press('Enter')
  await expect(woodland).toBeFocused()
  await themes.getByRole('button', { name: 'Back to note map' }).press('Enter')
  await expect(toggle).toBeFocused()
  await expect(scene).toHaveAttribute('transform', camera!)
})

test('the unmatched list includes notes outside the normal map cap and refreshes after an edit', async () => {
  await page.getByRole('button', { name: 'Whole vault map' }).click()
  await page.getByRole('button', { name: 'Themes', exact: true }).press('Enter')
  const themes = page.getByRole('region', { name: 'Vault themes' })
  await themes.getByRole('button', { name: 'Notes without a theme (213)' }).press('Enter')
  const filter = themes.getByRole('searchbox', { name: 'Filter notes in this list' })
  await filter.fill('Staged only')
  await expect(themes).toContainText('No notes match your filter.')
  await filter.fill('Unsorted 206')
  const last = themes.getByRole('button', { name: /Unsorted 206/ })
  await expect(last).toBeVisible()
  await last.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Unsorted 206')
  await page.getByRole('button', { name: '← Back to map', exact: true }).press('Enter')
  await expect(last).toBeFocused()

  const leaf = join(vault, 'Unsorted 206.md')
  await page.evaluate(async (path) => {
    const api = window.nodebook
    await api.saveFile(path, '# Revised late title\n\nChanged while Themes was open.\n', await api.readFile(path))
  }, leaf)
  await filter.fill('Revised late title')
  await expect(themes.getByRole('button', { name: /Revised late title/ })).toBeVisible()
})

test('settled local vectors refresh an open list and an edited note loses its old embedding', async () => {
  await page.getByRole('button', { name: 'Whole vault map' }).click()
  await page.getByRole('button', { name: 'Themes', exact: true }).press('Enter')
  const themes = page.getByRole('region', { name: 'Vault themes' })
  await themes.getByRole('button', { name: 'Notes without a theme (213)' }).press('Enter')
  const filter = themes.getByRole('searchbox', { name: 'Filter notes in this list' })
  await filter.fill('Unsorted 050')

  const evidence = await page.evaluate(async (root) => {
    const api = window.nodebook
    const { vaultId } = await api.talkStatus()
    const { talk } = await api.readSettings()
    const { generation } = await api.talkEnable(vaultId!, talk.embed.model, 2)
    const before = await api.vaultThemes(root, crypto.randomUUID())
    const pending = await api.talkPending(generation!, 500)
    const batch = pending.map(({ id, text }) => ({
      id,
      vector: /^V1 /.test(text) ? [1, 0] : /^V2 /.test(text) ? [0, 1] : [0, 0]
    }))
    const status = await api.talkPutEmbeddings(generation!, batch)
    const after = await api.vaultThemes(root, crypto.randomUUID())
    return { before, after, status, batch, generation }
  }, vault)
  expect(evidence.before).toMatchObject({ embeddedCount: 0 })
  expect(evidence.status.pending).toBe(0)
  expect(evidence.after).toMatchObject({ embeddedCount: 6 })
  expect(evidence.after?.themes).toHaveLength(4)
  await expect(themes.getByText('207 notes', { exact: true })).toBeVisible()
  await expect(filter).toHaveValue('Unsorted 050')
  await expect(filter).toBeFocused()

  const edited = await page.evaluate(async ({ root, batch, generation }) => {
    const api = window.nodebook
    const path = `${root}/V1 Apple.md`
    await api.saveFile(path, '# Revised apple\n\nFresh unembedded content.\n', await api.readFile(path))
    await api.talkPutEmbeddings(generation!, batch)
    const edited = await api.vaultThemes(root, crypto.randomUUID())
    await api.talkDisable()
    return edited
  }, { root: vault, batch: evidence.batch, generation: evidence.generation })
  expect(edited).toMatchObject({ embeddedCount: 5 })
  expect(edited?.themes).toHaveLength(3)
  expect(edited?.unmatched).toContainEqual(expect.objectContaining({ title: 'Revised apple' }))
})

test('a cold themes request leaves main responsive, rejects superseded titles, and can be cancelled', async () => {
  const race = await page.evaluate(async (root) => {
    const api = window.nodebook
    const path = `${root}/Unsorted 205.md`
    const first = '# Before the racing save\n'
    const latest = '# After the racing save\n'
    await api.saveFile(path, first, await api.readFile(path))
    const order: string[] = []
    const work = api.vaultThemes(root, crypto.randomUUID()).then((result) => {
      order.push('themes')
      return result
    })
    await api.saveFile(path, latest, first)
    order.push('save')
    const result = await work
    const title = result?.unmatched.find((note) => note.path === path)?.title

    await api.saveFile(path, '# A further edit\n', latest)
    const id = crypto.randomUUID()
    const pending = api.vaultThemes(root, id)
    api.cancelVaultThemes(id)
    return { order, title, cancelled: await pending }
  }, vault)
  expect(race.order).toEqual(['save', 'themes'])
  expect(race.title).toBe('After the racing save')
  expect(race.cancelled).toBeNull()
})

test('a vault with insufficient evidence still gives access to every note and the note map', async () => {
  const tiny = realpathSync(mkdtempSync(join(tmpdir(), 'nodebook-tiny-vault-themes-')))
  writeFileSync(join(tiny, 'First.md'), '# First note\n\n[[Second]].\n')
  writeFileSync(join(tiny, 'Second.md'), '# Second note\n\n[[First]].\n')
  await openVault(tiny)
  await expect(page.locator('.tree-file', { hasText: 'First' })).toBeVisible()
  await page.getByRole('button', { name: 'Whole vault map' }).click()
  const toggle = page.getByRole('button', { name: 'Themes', exact: true })
  await toggle.press('Enter')
  const themes = page.getByRole('region', { name: 'Vault themes' })
  await expect(themes).toContainText('There aren’t enough notes or strong connections to identify themes.')
  await expect(themes.getByTitle('App theme')).toBeVisible()
  await themes.getByRole('button', { name: 'Notes without a theme (2)' }).press('Enter')
  await expect(themes.getByRole('button', { name: /First note/ })).toBeVisible()
  await expect(themes.getByRole('button', { name: /Second note/ })).toBeVisible()
  await themes.getByRole('button', { name: 'Back to note map' }).press('Enter')
  await expect(toggle).toBeFocused()
  await toggle.press('Enter')
  await themes.getByRole('button', { name: /Close/ }).press('Enter')
  await expect(themes).toBeHidden()
  await expect(toggle).toBeHidden()
})
