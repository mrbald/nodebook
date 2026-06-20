import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string

test.beforeAll(async () => {
  // Copy the fixture vault to a temp dir so debounced saves never mutate the
  // committed fixtures. Exclude `.nodebook/`: a stale index copied in would mix
  // fixture-path triples with the temp vault's, doubling backlinks/search rows.
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-e2e-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })

  // Launch the built app (package.json "main" -> out/main/index.js), with the
  // config dir routed to a throwaway temp folder so the test never touches the
  // real user settings.
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-e2e-userdata-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir }
  })

  // Stub the native folder picker so it returns our temp vault — Playwright
  // can't drive OS dialogs, and this keeps production code untouched.
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)

  // Stub shell.openExternal so the link test records URLs instead of launching
  // a real browser.
  await app.evaluate(async ({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shell.openExternal = (async (u: string) => {
      g.__opened.push(u)
    }) as any
  })

  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
})

test.afterAll(async () => {
  await app?.close()
})

test('opens a vault and lists its markdown recursively', async () => {
  await page.getByRole('button', { name: 'Open vault' }).click()
  await expect(page.locator('.tree-file')).toHaveCount(4)
  await expect(page.locator('.tree-folder', { hasText: 'projects' })).toBeVisible()
  await expect(page.locator('.tree-file', { hasText: 'Roadmap' })).toBeVisible()
})

test('renders wikilinks as pills in the opened note', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await expect(page.locator('.cm-wikilink')).toHaveCount(2)
  await expect(page.locator('.cm-wikilink', { hasText: 'Graph Model' })).toBeVisible()
})

test('clicking a markdown link opens it in the system browser', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await page.locator('.cm-md-link', { hasText: 'example' }).click()
  const opened = await app.evaluate(
    () => (globalThis as unknown as { __opened: string[] }).__opened
  )
  expect(opened).toContain('https://example.com')
})

test('fenced code blocks render in a monospace font', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  const fontFamily = await page.evaluate(
    () => getComputedStyle(document.querySelector('.cm-code-block') as Element).fontFamily
  )
  expect(fontFamily.toLowerCase()).toContain('mono')
})

test('`[[` shows autocomplete sourced from the vault', async () => {
  // Click into the editor, jump to the end, and open a wikilink.
  await page.locator('.cm-content').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type('[[')

  const popup = page.locator('.cm-tooltip-autocomplete')
  await expect(popup).toBeVisible()
  await expect(popup.locator('li')).toHaveCount(4)

  await page.keyboard.press('Escape')
})

test('clicking a pill navigates to that note', async () => {
  await page.locator('.cm-wikilink', { hasText: 'Graph Model' }).first().click()
  await expect(page.locator('.tree-file.active')).toHaveText('Graph Model')
  await expect(page.locator('.cm-content')).toContainText('Notes link to each other')
})

test('the backlinks panel lists linking notes and navigates', async () => {
  // We are on Graph Model.md (from the previous test); welcome.md and
  // projects/Roadmap.md both link to it.
  const panel = page.locator('.backlinks')
  await expect(panel.locator('.backlinks-relation', { hasText: 'links_to' })).toBeVisible()
  await expect(panel.locator('.backlinks-item', { hasText: 'welcome' })).toBeVisible()
  await expect(panel.locator('.backlinks-item', { hasText: 'Roadmap' })).toBeVisible()

  await panel.locator('.backlinks-item', { hasText: 'welcome' }).click()
  await expect(page.locator('.tree-file.active')).toHaveText('welcome')
})

test('the index resolves backlinks with their relation', async () => {
  const links = await page.evaluate(() => window.nodebook.backlinks('Graph Model'))
  const sources = links.map((l) => l.source_file)
  expect(sources.some((s) => s.endsWith('welcome.md'))).toBe(true)
  expect(sources.some((s) => s.endsWith('Roadmap.md'))).toBe(true)
  expect(links.every((l) => l.relation === 'links_to')).toBe(true)
})

test('the panel surfaces outbound links/properties and they navigate', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  const panel = page.locator('.backlinks')
  // welcome links out to [[Graph Model]] and [[projects/Roadmap]].
  await expect(panel.locator('.outbound-relation', { hasText: 'links_to' })).toBeVisible()
  await expect(panel.locator('.outbound-item', { hasText: 'Graph Model' })).toBeVisible()
  // A target that resolves to a note is navigable.
  await panel.locator('.outbound-item.is-link', { hasText: 'Graph Model' }).click()
  await expect(page.locator('.tree-file.active')).toHaveText('Graph Model')
})

test('full-text search finds a note by its content', async () => {
  const hits = await page.evaluate(() => window.nodebook.search('claim'))
  expect(hits).toHaveLength(1)
  expect(hits[0].path).toMatch(/welcome\.md$/)
})

test('chokidar re-indexes a file created outside the app', async () => {
  writeFileSync(join(vaultDir, 'External.md'), '# External\n\nlinks [[Graph Model]] word zebra\n')

  // Poll until the watcher has picked it up (awaitWriteFinish + fs latency).
  await expect
    .poll(async () => (await page.evaluate(() => window.nodebook.search('zebra'))).length, {
      timeout: 5000
    })
    .toBe(1)

  const links = await page.evaluate(() => window.nodebook.backlinks('Graph Model'))
  expect(links.some((l) => l.source_file.endsWith('External.md'))).toBe(true)
})

test('the sidebar search box finds a note and opens it', async () => {
  await page.locator('.search-box').fill('claim') // only welcome.md contains "claim"
  await expect(page.locator('.search-results li')).toHaveCount(1)
  await expect(page.locator('.search-result-title')).toHaveText('Welcome to Nodebook')

  await page.locator('.search-results li').first().click()
  await expect(page.locator('.cm-content')).toContainText('claim')

  await page.locator('.search-box').fill('') // restore the file tree
  await expect(page.locator('.file-tree')).toBeVisible()
})

test('a .map.md renders as a collapsible tree, not the text editor', async () => {
  await page.locator('.tree-file', { hasText: 'Vault.map' }).click()
  await expect(page.locator('.map-view')).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCount(0) // editor is not shown for maps
  await expect(page.locator('.map-title')).toHaveText('Vault Map')

  // Two top-level nodes; one edge from the ## Edges section.
  await expect(page.locator('.map-view > .map-tree > .map-node')).toHaveCount(2)
  await expect(page.locator('.map-edge')).toHaveCount(1)

  // Collapsing the first node hides its child.
  const first = page.locator('.map-view > .map-tree > .map-node').first()
  await expect(first.locator('.map-node-label', { hasText: 'welcome' })).toBeVisible()
  await first.locator('.map-node-toggle').first().click()
  await expect(first.locator('.map-node-label', { hasText: 'welcome' })).toHaveCount(0)

  // Clicking a node link opens that note back in the editor.
  await page.locator('.map-link', { hasText: 'projects/Roadmap' }).click()
  await expect(page.locator('.tree-file.active')).toHaveText('Roadmap')
  await expect(page.locator('.cm-editor')).toBeVisible()
})

test('right-click → New note creates the file and opens it', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
  await page.locator('.context-menu-item', { hasText: 'New note' }).click()

  await page.locator('.modal-input').fill('Fresh Note')
  await page.locator('.modal-btn-primary').click()

  await expect(page.locator('.tree-file', { hasText: 'Fresh Note' })).toBeVisible()
  await expect(page.locator('.tree-file.active')).toHaveText('Fresh Note')
  await expect(page.locator('.cm-content')).toContainText('Fresh Note') // the `# Fresh Note` template
})

test('right-click → New folder creates an (empty) folder visible in the tree', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'New folder' }).click()
  await page.locator('.modal-input').fill('Inbox')
  await page.locator('.modal-btn-primary').click()

  await expect(page.locator('.tree-folder', { hasText: 'Inbox' })).toBeVisible()
})

test('search results show a highlighted matching snippet', async () => {
  await page.locator('.search-box').fill('claim') // only welcome.md
  await expect(page.locator('.search-result-snippet')).toBeVisible()
  await expect(page.locator('.search-result-snippet mark')).toBeVisible()
  await page.locator('.search-box').fill('')
})

test('right-click → Rename renames a file (input pre-filled)', async () => {
  // make a throwaway note to rename
  await page.locator('.tree-file', { hasText: 'welcome' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'New note' }).click()
  await page.locator('.modal-input').fill('ToRename')
  await page.locator('.modal-btn-primary').click()
  await expect(page.locator('.tree-file', { hasText: 'ToRename' })).toBeVisible()

  await page.locator('.tree-file', { hasText: 'ToRename' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Rename' }).click()
  await expect(page.locator('.modal-input')).toHaveValue('ToRename')
  await page.locator('.modal-input').fill('Renamed')
  await page.locator('.modal-btn-primary').click()

  await expect(page.locator('.tree-file', { hasText: 'Renamed' })).toBeVisible()
  await expect(page.locator('.tree-file', { hasText: 'ToRename' })).toHaveCount(0)
})

test('right-click → Delete removes a file after confirm', async () => {
  await page.locator('.tree-file', { hasText: 'Renamed' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Delete' }).click()
  await expect(page.locator('.modal-message')).toContainText('Delete')
  await page.locator('.modal-btn-danger').click()

  await expect(page.locator('.tree-file', { hasText: 'Renamed' })).toHaveCount(0)
})

test('autosave is off by default: file stays dirty until ⌘S', async () => {
  await page.locator('.tree-file', { hasText: 'Graph Model' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type(' edited')

  // Dirty indicator shows, and stays — no delay-autosave.
  await expect(page.locator('.tree-file.active .tree-dirty')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page.locator('.tree-file.active .tree-dirty')).toBeVisible()

  // ⌘S saves and clears the indicator.
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.locator('.tree-file.active .tree-dirty')).toHaveCount(0)
})

test('autosave-on-switch flushes the edit when you leave the file', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+ArrowDown`) // doc end
  await page.keyboard.type('\nSWITCHSAVE')

  // Leaving welcome flushes it (autosaveOnSwitch is on by default); coming back
  // shows the persisted edit.
  await page.locator('.tree-file', { hasText: 'Graph Model' }).click()
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await expect(page.locator('.cm-content')).toContainText('SWITCHSAVE')
})

async function switchMode(label: string): Promise<void> {
  await page.locator('.status-select-mode .status-btn').click()
  await page.locator('.status-select-mode .status-menu-item', { hasText: label }).click()
}

test('three view modes: Code (raw), Live (default), Reading (read-only) — switch via status bar', async () => {
  // Pin the theme so the highlight-color assertion below is deterministic.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await expect.poll(bg).toBe('#1e1e22')

  // Default is Live: pills render and the editor is editable.
  await expect(page.locator('.status-select-mode .status-btn')).toContainText('Live preview')
  await expect(page.locator('.cm-wikilink')).toHaveCount(2)
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')

  // Code: raw markdown (pills gone, heading '#' visible), still editable.
  await switchMode('Code')
  await expect(page.locator('.status-select-mode .status-btn')).toContainText('Code')
  await expect(page.locator('.cm-wikilink')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('[[Graph Model]]')
  await expect(page.locator('.cm-content')).toContainText('# Welcome')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')

  // Code mode is genuinely syntax-highlighted: the heading line renders colored
  // <span>s — the heading text in the theme heading color (dark = #7aa2f7).
  const headingColors = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-content .cm-line')].find((l) =>
      l.textContent?.includes('Welcome to Nodebook')
    )
    return [...(line?.querySelectorAll('span') ?? [])].map((s) => getComputedStyle(s).color)
  })
  expect(headingColors).toContain('rgb(122, 162, 247)')

  // Reading: styled, pills back, heading '#' hidden ("no formatting symbols"),
  // and read-only.
  await switchMode('Reading')
  await expect(page.locator('.cm-wikilink')).toHaveCount(2)
  await expect(page.locator('.cm-content')).not.toContainText('# Welcome')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

  // A wikilink still navigates in Reading mode.
  await page.locator('.cm-wikilink', { hasText: 'Graph Model' }).first().click()
  await expect(page.locator('.tree-file.active')).toHaveText('Graph Model')

  // Back to Live to keep editing (mode persists across files, so reset it here).
  await switchMode('Live preview')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
})

const opened = (): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
const clearOpened = (): Promise<void> =>
  app.evaluate(() => {
    ;(globalThis as unknown as { __opened: string[] }).__opened = []
  })

test('Code mode: ⌘/Ctrl-click follows links (bracket AND bare URL), plain click does not', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  await switchMode('Code')
  const mod = MOD === 'Meta' ? 'Meta' : 'Control'

  // A markdown link and a bare GFM-autolinked URL behave identically.
  const mdLink = page.locator('.cm-source-link', { hasText: 'example' }).first()
  const bareUrl = page.locator('.cm-source-link', { hasText: 'pritunl' }).first()

  // Plain click just places the cursor — neither navigates.
  await clearOpened()
  await mdLink.click()
  await bareUrl.click()
  expect(await opened()).toHaveLength(0)

  // ⌘/Ctrl-click follows each via the system browser.
  await clearOpened()
  await mdLink.click({ modifiers: [mod] })
  await bareUrl.click({ modifiers: [mod] })
  const urls = await opened()
  expect(urls).toContain('https://example.com')
  expect(urls).toContain('https://docs.pritunl.com/kb/vpn')

  // Affordance is honest: the underline/pointer only appears while ⌘/Ctrl held.
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-mod-held/)
  await page.keyboard.down(mod)
  await expect(page.locator('.cm-editor')).toHaveClass(/cm-mod-held/)
  await page.keyboard.up(mod)
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-mod-held/)

  await switchMode('Live preview')
})

async function switchTheme(label: string): Promise<void> {
  await page.locator('.status-select-theme .status-btn').click()
  await page.locator('.status-select-theme .status-menu-item', { hasText: label }).click()
}

test('theme selector (status bar) switches the whole-app theme', async () => {
  await page.locator('.tree-file', { hasText: 'welcome' }).click()

  await switchTheme('Light')
  await expect.poll(bg).toBe('#ffffff')
  await expect(page.locator('.status-select-theme .status-btn')).toContainText('Light')

  await switchTheme('Dark')
  await expect.poll(bg).toBe('#1e1e22')

  // Restore followSystem so the later settings tests start from the default.
  await switchTheme('System')
})

test('Export PDF writes a .pdf file', async () => {
  const pdfPath = join(tmpdir(), 'nodebook-e2e-export.pdf')
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, pdfPath)

  await page.locator('.tree-file', { hasText: 'welcome' }).click()
  // Drive the File ▸ Export PDF menu command (no toolbar button anymore).
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'export-pdf')
  })

  await expect.poll(() => existsSync(pdfPath), { timeout: 5000 }).toBe(true)
})

const bg = (): Promise<string> =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--bg'))
const fontSizeVar = (): Promise<string> =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--editor-font-size'))

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function rewriteSettings(toml: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+a`)
  await page.keyboard.type(toml)
  await page.keyboard.press(`${MOD}+s`) // autosave is off by default; save explicitly
}

test('settings open as a TOML editor and the whole app recolors per theme', async () => {
  // followSystem is on by default; force OS dark → the "dark" theme.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(bg, { timeout: 3000 }).toBe('#1e1e22')

  await page.locator('.settings-btn').click()
  await expect(page.locator('.cm-content')).toContainText('followSystem')
  await expect(page.locator('.backlinks')).toHaveCount(0) // panel hidden while settings open

  // Explicit theme (followSystem off): the app chrome var recolors, not just
  // the editor — and font size applies live.
  await rewriteSettings('[editor]\nfontSize = 18\n[theme]\nfollowSystem = false\nname = "dracula"\n')
  await expect.poll(bg, { timeout: 3000 }).toBe('#282a36') // dracula bg
  expect(await fontSizeVar()).toBe('18px')
})

test('followSystem flips the theme live when the OS appearance changes', async () => {
  await rewriteSettings(
    '[theme]\nfollowSystem = true\ndark = "nord"\nlight = "solarized-light"\n'
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(bg, { timeout: 3000 }).toBe('#2e3440') // nord

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(bg, { timeout: 3000 }).toBe('#fdf6e3') // solarized-light
})

test('Settings: "Reset to defaults" restores the factory file', async () => {
  // Make a non-default change and save it.
  await rewriteSettings('[editor]\nfontSize = 22\n')
  await expect.poll(fontSizeVar, { timeout: 3000 }).toBe('22px')

  // Reset → confirm → both the live settings and the editor text revert.
  await page.locator('.settings-reset').click()
  await page.locator('.modal-btn-danger').click()
  await expect.poll(fontSizeVar, { timeout: 3000 }).toBe('15px')
  await expect(page.locator('.cm-content')).toContainText('defaultMode') // shipped default
})
