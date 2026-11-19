import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// "Ask" (talk-to-docs P2): retrieve grounding chunks → stream a cited answer.
// Under NODEBOOK_E2E the chat model is a deterministic stub, with Talk off.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let beta: string
const evidence = 'The Betaquartz release is scheduled for early May.'

test.beforeAll(async () => {
  test.setTimeout(45_000) // launch + open + enable/index can take a few seconds
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-ask-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  for (const folder of ['alpha', 'beta']) mkdirSync(join(vaultDir, folder))
  writeFileSync(join(vaultDir, 'alpha/Twin.md'), '# Twin\n\nThe other entry.\n')
  beta = join(vaultDir, 'beta/Twin.md')
  writeFileSync(beta, `# Twin\n\n${evidence}\n`)
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-ask-userdata-'))
  writeFileSync(join(userDataDir, 'settings.toml'), '[talk.chat]\nprovider = "none"\n')
  app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      NODEBOOK_USER_DATA: userDataDir,
      NODEBOOK_E2E: '1',
      NODEBOOK_E2E_CHAT_DELAY_MS: '500'
    }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

test('saving a provider enables keyword-only Ask and its citations select the exact note passage', async () => {
  await page.locator('.ask-cta').click()
  const editor = page.locator('.settings-pane .cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText('[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n')
  await page.keyboard.press('ControlOrMeta+S')
  await expect(page.locator('.ask-open-btn')).toBeVisible()
  expect(await page.evaluate(() => window.nodebook.talkStatus())).toMatchObject({
    enabled: false,
    ready: false,
    total: 0
  })
  await page.locator('.ask-open-btn').click()
  await expect(page.locator('.ask-pane')).toBeVisible()

  await page.locator('.ask-input').fill('Betaquartz')
  await page.locator('.ask-send').click()

  await expect(page.locator('.ask-answer')).toContainText('Based on your notes')
  await expect(page.locator('.ask-source')).toHaveText('beta/Twin')

  // The original offsets have drifted, but the quote is still unique.
  writeFileSync(beta, `# Twin\n\nA new preface.\n\n${evidence}\n`)
  const cite = page.locator('.ask-answer-rendered .ask-citation')
  await expect(cite).toHaveText('beta/Twin')
  await cite.click()
  await expect(page.locator('.ask-pane')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText(evidence)
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible()

  await page.locator('.ask-open-btn').click()
  await page.locator('.ask-input').fill('unmatchedanchor987')
  await page.locator('.ask-send').click()
  await expect(page.locator('.ask-answer-rendered')).toHaveText(
    'I couldn’t find any passages in your notes to answer that question.'
  )
  await expect(page.locator('.ask-source')).toHaveCount(0)
})

test('Ask requests are isolated by ID and cancelled at a vault switch', async () => {
  const otherVault = realpathSync(mkdtempSync(join(tmpdir(), 'nodebook-ask-other-')))
  const result = await page.evaluate(async (root) => {
    const api = window.nodebook
    const { vaultId } = await api.talkStatus()
    const req = {
      id: 'same-id',
      vaultId: vaultId!,
      question: 'Betaquartz',
      generation: null,
      vector: []
    }
    const tokens: string[] = []
    const asked = api.ask(req, (token) => tokens.push(token)).then(
      () => 'completed',
      (err: unknown) => String(err)
    )
    const duplicate = await api.ask(req, (token) => tokens.push(token)).then(
      () => 'completed',
      (err: unknown) => String(err)
    )
    await api.openVault(root)
    const aborted = await asked
    const late = await api.ask(req, (token) => tokens.push(token)).then(
      () => 'completed',
      (err: unknown) => String(err)
    )
    return { aborted, duplicate, late, tokens }
  }, otherVault)
  expect(result.duplicate).toContain('already running')
  expect(result.aborted).toMatch(/abort/i)
  expect(result.late).toContain('vault changed')
  expect(result.tokens).toEqual([])
})
