import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { zipSync, strToU8 } from 'fflate'

// Verifies the "distill a document" vertical end-to-end — chunk → embed (renderer
// bridge, faked) → cluster → extract (stub chat) → ground → emit → staged run.db
// → run graph — and the firewall: the distilled notes never reach the canonical
// index. No model download, no network, no key.

const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page
let vaultDir: string
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
  '',
  '## Liberty',
  'Liberty is to faction what air is to fire, an aliment without which it expires.',
  '',
  '## Union',
  'A firm union is essential to the peace and the liberty of the several states.',
  ''
].join('\n')

test.beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-distill-userdata-'))
  // A chat provider so distill is allowed; under NODEBOOK_E2E the model is a stub.
  writeFileSync(
    join(userDataDir, 'settings.toml'),
    '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-test"\n'
  )
  // The book lives OUTSIDE the vault, so it is not itself a canonical note.
  bookPath = join(userDataDir, 'on-government.md')
  writeFileSync(bookPath, BOOK)

  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  // "Open original" hands the file to the system reader; record it instead.
  await app.evaluate(async ({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openPath = (async (p: string) => {
      g.__opened.push(p)
      return ''
    }) as typeof shell.openPath
  })

  page = await app.firstWindow()
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__NODEBOOK_FAKE_EMBED__ = true
  })
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.waitForSelector('.tree-file')
})

test.afterAll(async () => {
  await app?.close()
})

/** Distill a document by path. The renderer never names a path to `distillRun`
 *  — main hands out an opaque id per picked document — so a spec, which cannot
 *  drive the native dialog, registers the path through the NODEBOOK_E2E door. */
const distillPath = (p: string): Promise<{ runId: string; stats: { chunks: number; notes: number; dropped: number } }> =>
  page.evaluate(async (path) => {
    const id = await window.nodebook.distillRegisterPath(path)
    return window.nodebook.distillRun(id)
  }, p)

test('distills a document into a staged, cited run of notes', async () => {
  const result = await distillPath(bookPath)
  expect(result.runId).toBeTruthy()
  expect(result.stats.chunks).toBeGreaterThan(0)
  expect(result.stats.notes).toBeGreaterThan(0)
  expect(result.stats.dropped).toBe(0) // stub quotes are real substrings → grounding keeps all
})

test('staged runs are listed with note counts and merge state', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs.length).toBeGreaterThan(0)
  expect(runs[0].notes).toBeGreaterThan(0)
  expect(runs[0].merged).toBe(false)
})

test('the run map wires distilled notes to the source book', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs.length).toBeGreaterThan(0)
  const g = await page.evaluate((id) => window.nodebook.distillGraph(id), runs[0].id)
  expect(g.nodes.length).toBeGreaterThan(1)
  // Nodes are keyed by path, labelled by name — the book is a node of its own.
  expect(g.nodes.some((n) => n.label === 'on-government')).toBe(true)
  // With themes, the book is reached through them: its `source` edges come from
  // theme nodes only, so it is the root of book → themes → notes, not a star.
  // (Each note keeps its own `source::` line; only the drawing changes.)
  const src = g.edges.filter((e) => e.relation === 'source')
  expect(src.length).toBeGreaterThan(0)
  const themeIds = new Set(g.nodes.filter((n) => n.kind === 'theme').map((n) => n.id))
  expect(themeIds.size).toBeGreaterThan(0)
  for (const e of src) expect(themeIds).toContain(e.source)
})

test('FIREWALL: distilled notes never enter the canonical index', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const g = await page.evaluate((id) => window.nodebook.distillGraph(id), runs[0].id)
  const canonNames = await page.evaluate(() => window.nodebook.noteNames())
  // Not one of the run's notes (source or distilled concepts) leaked into the vault index.
  for (const node of g.nodes) expect(canonNames).not.toContain(node.label)
})

test('OVERLAY unions the vault + the run with provenance, writing nothing', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const overlay = await page.evaluate((id) => window.nodebook.distillOverlayGraph(id), runs[0].id)
  const sources = new Set(overlay.nodes.map((n) => n.source))
  expect(sources.has('run')).toBe(true) // the book's nodes
  expect(sources.has('vault')).toBe(true) // your existing notes, shown alongside
  const book = overlay.nodes.find((n) => n.label === 'on-government')!
  expect(book.source).toBe('run')
  expect(book.id).toBe(book.path) // identity is the path, so nothing is collapsed
  // Same-name notes stay two dots; each is flagged and joined by a `same_name` edge.
  for (const n of overlay.nodes.filter((x) => x.sameName)) {
    const twin = overlay.nodes.find((x) => x.label === n.label && x.source !== n.source)
    expect(twin).toBeTruthy()
    expect(twin!.id).not.toBe(n.id)
  }
  for (const e of overlay.edges.filter((x) => x.relation === 'same_name')) {
    const a = overlay.nodes.find((n) => n.id === e.source)!
    const b = overlay.nodes.find((n) => n.id === e.target)!
    expect(a.label).toBe(b.label)
    expect(a.source).not.toBe(b.source)
  }
  // Overlay is a pure view — the run stays out of the canonical index.
  const canon = await page.evaluate(() => window.nodebook.noteNames())
  expect(canon).not.toContain('on-government')
})

test('File ▸ Distill a document… runs from the menu and shows the run map', async () => {
  // Point the file dialog at the book, then fire the menu command.
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, bookPath)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'distill')
  })
  // The run map renders via the reused GraphView, with nodes + a source edge.
  await expect(page.locator('.graph-view')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.graph-node').first()).toBeVisible()
  expect(await page.locator('.graph-node').count()).toBeGreaterThan(1)
  // Not `toBeVisible`: a two-node map can lay its nodes out exactly level, and
  // a horizontal SVG line has a zero-height box Playwright calls hidden. So ask
  // the geometry instead — an edge that is really drawn has a length.
  const edge = page.locator('.graph-edge').first()
  await expect(edge).toBeAttached()
  const edgeLength = await edge.evaluate((el) => (el as SVGGeometryElement).getTotalLength())
  expect(edgeLength).toBeGreaterThan(0)

  // The completion banner says what happened and that nothing is merged yet.
  await expect(page.locator('.distill-coverage-banner')).toContainText(/Staged \d+ notes?/)
  await expect(page.locator('.distill-coverage-banner')).toContainText('Merge')
  await page.locator('.distill-coverage-close').click()
})

test('a closed run map is reachable again from the sidebar "Distilled runs" list', async () => {
  // Close the run map opened by the previous test — the run must NOT be lost.
  await page.locator('.graph-close').click()
  await expect(page.locator('.graph-view')).toHaveCount(0)

  const section = page.locator('.runs-section')
  await expect(section).toBeVisible()
  await expect(section.locator('.runs-header')).toHaveText('Distilled runs')
  const row = section.locator('.run-item').first()
  await expect(row.locator('.run-item-meta')).toContainText(/\d+ notes?/)

  // Clicking the row reopens the staged run's map (the graph loads async).
  await row.click()
  await expect(page.locator('.graph-view')).toBeVisible()
  await expect.poll(() => page.locator('.graph-node').count()).toBeGreaterThan(1)
})

test('the run map groups the notes under theme nodes, drawn as diamonds', async () => {
  // The run map from the previous test is open.
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  const g = await page.evaluate((r) => window.nodebook.distillGraph(r), id)

  // Themes are notes of their own, and every distilled note hangs off one.
  const themes = g.nodes.filter((n) => n.kind === 'theme')
  expect(themes.length).toBeGreaterThan(0)
  const partOf = g.edges.filter((e) => e.relation === 'part_of')
  expect(partOf.length).toBeGreaterThan(0)
  const themeIds = new Set(themes.map((n) => n.id))
  for (const e of partOf) expect(themeIds).toContain(e.target)

  // The map draws a theme as a diamond (a rotated square, not a circle) and
  // says so in the key beside it.
  await expect.poll(() => page.locator('.graph-node rect').count()).toBeGreaterThan(0)
  await expect(page.locator('.graph-shape-key')).toContainText('theme')

  // The sidebar says what the run turned out to be about.
  await expect(page.locator('.run-item-themes').first()).toBeVisible()
  expect(runs.some((r) => (r.themes?.length ?? 0) > 0)).toBe(true)
})

test('same-source re-distill gets its own run id; discarding removes only that run', async () => {
  // Distill the same book again: the id must NOT silently replace the first
  // run (a "-2" suffix de-collides). Then discard the copy.
  const before = await page.evaluate(() => window.nodebook.distillListRuns())
  await distillPath(bookPath)
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(runs.length).toBe(before.length + 1)

  const newId = runs.map((r) => r.id).find((id) => !before.some((b) => b.id === id))!
  await page.evaluate((id) => window.nodebook.distillRemove(id), newId)
  const after = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(after.map((r) => r.id)).not.toContain(newId)
  expect(after.length).toBe(before.length)
})

test('distills a PDF via pdf.js text extraction → cited notes', async () => {
  const pdfPath = join(__dirname, 'fixtures', 'sample.pdf')
  const res = await distillPath(pdfPath)
  expect(res.stats.chunks).toBeGreaterThan(0)
  expect(res.stats.notes).toBeGreaterThan(0) // extracted text flowed through the pipeline
})

test('distills an EPUB (unzip + HTML→markdown) → cited notes', async () => {
  const opf =
    '<?xml version="1.0"?><package><manifest><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
  const epub = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'content.opf': strToU8(opf),
    'chap1.xhtml': strToU8(
      '<html><body><h1>Faction</h1><p>Faction arises from the unequal distribution of property among citizens.</p></body></html>'
    )
  })
  const epubPath = join(mkdtempSync(join(tmpdir(), 'nodebook-epub-')), 'sample.epub')
  writeFileSync(epubPath, epub)
  const res = await distillPath(epubPath)
  expect(res.stats.chunks).toBeGreaterThan(0)
  expect(res.stats.notes).toBeGreaterThan(0)
})

test('the run map toggles Standalone ⟷ Overlay (overlay adds the vault notes)', async () => {
  // The run map is open from the previous test.
  await expect(page.locator('.distill-view-toggle')).toContainText('Standalone')
  const standalone = await page.locator('.graph-node').count()
  await page.locator('.distill-view-toggle').click()
  await expect(page.locator('.distill-view-toggle')).toContainText('Overlay')
  // Overlay folds in your vault's notes, so there are strictly more nodes.
  await expect.poll(() => page.locator('.graph-node').count()).toBeGreaterThan(standalone)
})

test('MERGE writes the run into the vault (now canonical); UNDO reverses it', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  expect(await page.evaluate(() => window.nodebook.noteNames())).not.toContain('on-government')
  const res = await page.evaluate((r) => window.nodebook.distillMerge(r), id)
  expect(res.count).toBeGreaterThan(0)
  // The merged notes are now real vault notes — the canonical index sees them.
  expect(await page.evaluate(() => window.nodebook.noteNames())).toContain('on-government')
  // Undo removes exactly what it wrote.
  await page.evaluate((r) => window.nodebook.distillUnmerge(r), id)
  expect(await page.evaluate(() => window.nodebook.noteNames())).not.toContain('on-government')
})

test('Merge button → confirm → Undo banner → reverses', async () => {
  // The run map is still open from the earlier tests.
  await page.locator('.distill-merge-btn').click()
  await page.locator('.modal-btn-danger').click() // confirm the merge
  await expect(page.locator('.distill-merged-banner')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.nodebook.noteNames())).toContain('on-government')
  await page.locator('.distill-undo').click()
  await expect(page.locator('.distill-merged-banner')).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => window.nodebook.noteNames()))
    .not.toContain('on-government')
})

test('UNDO never destroys your edits: an edited merged note goes to the Trash', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  await page.locator('.distill-merge-btn').click()
  await page.locator('.modal-btn-danger').click() // confirm the merge
  await expect(page.locator('.distill-merged-banner')).toBeVisible()

  // Edit one merged note through the app's own save path, as a user would.
  // (realpath: main canonicalizes the vault at open — /var → /private/var on
  // macOS — and refuses to save a path that doesn't resolve inside it.)
  const folder = join(realpathSync(vaultDir), 'Distilled', id)
  const merged = readdirSync(folder).filter((n) => n.endsWith('.md'))
  expect(merged.length).toBeGreaterThan(1)
  const edited = join(folder, merged[0])
  await page.evaluate(
    (a) => window.nodebook.saveFile(a.path, a.content),
    { path: edited, content: readFileSync(edited, 'utf8') + '\n\nMy own note.\n' }
  )

  await page.locator('.distill-undo').click()
  // The banner says what happened to the edited note…
  await expect(page.locator('.distill-coverage-banner')).toContainText('Trash')
  await expect(page.locator('.distill-merged-banner')).toBeHidden()
  // …it is out of the vault folder (moved, not deleted)…
  await expect.poll(() => existsSync(edited)).toBe(false)
  // …and every untouched note was removed, folder and all.
  await expect.poll(() => existsSync(folder)).toBe(false)
  await expect
    .poll(() => page.evaluate(() => window.nodebook.noteNames()))
    .not.toContain('on-government')
})

// --- Phase 6: readable staging, a merge that converges, durable `.distill/` ---

/** The run's staged note names, read straight off disk (`.distill/<id>/notes`). */
const stagedNames = (id: string): string[] =>
  readdirSync(join(realpathSync(vaultDir), '.distill', id, 'notes'))
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))

test('a staged note opens READ-ONLY before merge, and its citation shows the quote', async () => {
  // The run map is open from the earlier tests. Pick a concept note (not the book).
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  const concept = stagedNames(id).find((n) => n !== 'on-government')!

  await page.locator('.graph-node', { hasText: concept }).first().click()
  await page.locator('.graph-ctl', { hasText: 'Open ↗' }).click()

  // A read-only pane — never the editor, so there is no dirty/save state at all.
  await expect(page.locator('.staged-note')).toBeVisible()
  await expect(page.locator('.staged-note-title')).toContainText(concept)
  await expect(page.locator('.staged-note-badge')).toContainText('read-only')
  await expect(page.locator('.cm-content')).toHaveCount(0)

  // Its citation resolves against the RUN's own copy of the document, and the
  // quote is highlighted in place — checkable before anything is written.
  const cite = page.locator('.staged-note-sources .source-cite').first()
  await expect(cite).toContainText('on-government')
  await cite.click()
  await expect(page.locator('.staged-source mark')).toBeVisible()
  const quoted = (await page.locator('.staged-source mark').innerText()).trim()
  expect(BOOK).toContain(quoted)

  await page.locator('.staged-note-back').click()
  await expect(page.locator('.graph-view')).toBeVisible()
})

/** A distilled concept note this run staged — never the book itself. */
const someConcept = (id: string): string => stagedNames(id).find((n) => n !== 'on-government')!

test('MERGE beside a note you already have: "Name (Book)", with the links rewritten', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  // Your own note, same name as one of the run's notes.
  const clashName = someConcept(id)
  writeFileSync(
    join(realpathSync(vaultDir), `${clashName}.md`),
    `# ${clashName}\n\nMy own reading notes. [[welcome]]\n`
  )
  await expect.poll(() => page.evaluate(() => window.nodebook.noteNames())).toContain(clashName)

  const plan = await page.evaluate((r) => window.nodebook.distillMergePlan(r), id)
  const clash = plan.entries.find((e) => e.name === clashName)!
  expect(clash.action).toBe('collides')
  expect(clash.targetName).toBe(`${clashName} (on-government)`)

  // The dialog says what will happen, and defaults to "these are two notes".
  await page.locator('.distill-merge-btn').click()
  await expect(page.locator('.merge-dialog')).toBeVisible()
  await expect(page.locator('.merge-summary')).toContainText(
    /1 note shares a name with a note you already have/
  )
  // The summary counts them; the rows below say, per note, name → new name.
  await expect(page.locator('.merge-summary')).toContainText('as shown below')
  await expect(page.locator('.merge-clashes')).toContainText(
    `${clashName} → ${clashName} (on-government)`
  )
  await expect(page.locator('.merge-clash input')).not.toBeChecked()
  await page.locator('.merge-confirm').click()
  await expect(page.locator('.distill-merged-banner')).toBeVisible()

  const folder = join(realpathSync(vaultDir), 'Distilled', id)
  expect(existsSync(join(folder, `${clashName} (on-government).md`))).toBe(true)
  expect(existsSync(join(folder, `${clashName}.md`))).toBe(false) // your note untouched
  expect(readFileSync(join(realpathSync(vaultDir), `${clashName}.md`), 'utf8')).toContain(
    'My own reading notes.'
  )
  // The document itself lands ONCE, under Sources/ — never in the run's folder.
  expect(existsSync(join(realpathSync(vaultDir), 'Sources', 'on-government.md'))).toBe(true)
  expect(existsSync(join(folder, 'on-government.md'))).toBe(false)
  // Every reference to the renamed note followed it — a `[[link]]` in another
  // note's body, and a theme note's plain-text member list (which is the run's
  // other place a note name is written). No stale name is left in your vault.
  const others = readdirSync(folder).filter((n) => n.endsWith('.md') && !n.startsWith(clashName))
  const bodies = others.map((n) => readFileSync(join(folder, n), 'utf8'))
  expect(bodies.join('\n')).toContain(`${clashName} (on-government)`)
  for (const body of bodies)
    for (const line of body.split('\n'))
      expect(line.trim()).not.toBe(`- ${clashName}`)

  // Two notes, two dots: an unconfirmed name clash is never collapsed.
  const g = await page.evaluate(() => window.nodebook.graph(null, { showSources: true }))
  const dots = g.nodes.filter((n) => n.label.startsWith(clashName))
  expect(dots.map((n) => n.label).sort()).toEqual([clashName, `${clashName} (on-government)`])
  expect(dots.every((n) => n.aliases === undefined)).toBe(true)

  await page.locator('.distill-undo').click()
  await expect(page.locator('.distill-merged-banner')).toBeHidden()
})

test('ticking "same as the existing note" collapses the two into one dot', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  const clashName = someConcept(id)

  await page.locator('.distill-merge-btn').click()
  await expect(page.locator('.merge-dialog')).toBeVisible()
  await page.locator('.merge-clash', { hasText: clashName }).locator('input').check()
  await page.locator('.merge-confirm').click()
  await expect(page.locator('.distill-merged-banner')).toBeVisible()

  const merged = join(realpathSync(vaultDir), 'Distilled', id, `${clashName} (on-government).md`)
  await expect.poll(() => existsSync(merged)).toBe(true)
  expect(readFileSync(merged, 'utf8')).toContain(`same_as:: [[${clashName}]]`)

  // One dot now, with the other name recorded on it.
  await expect
    .poll(async () => {
      const g = await page.evaluate(() => window.nodebook.graph(null, { showSources: true }))
      return g.nodes.filter((n) => n.label.startsWith(clashName)).length
    })
    .toBe(1)
  const g = await page.evaluate(() => window.nodebook.graph(null, { showSources: true }))
  const one = g.nodes.find((n) => n.label === clashName)!
  expect(one.aliases).toEqual([`${clashName} (on-government)`])

  // …and the map's inspector says so, in words.
  await page.locator('.graph-close').click()
  await page.locator('.tree-file', { hasText: clashName }).first().click()
  await page.locator('.graph-open-btn', { hasText: 'Map' }).click()
  await page.locator('.graph-node', { hasText: clashName }).first().click()
  await expect(page.locator('.graph-insp-aliases')).toContainText(`${clashName} (on-government)`)
  await page.locator('.graph-close').click()

  await page.evaluate((r) => window.nodebook.distillUnmerge(r), id)
})

test('the document is saved once under Sources/, and a document is never a hub', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  const root = realpathSync(vaultDir)

  await page.evaluate((r) => window.nodebook.distillMerge(r), id)
  const book = join(root, 'Sources', 'on-government.md')
  await expect.poll(() => existsSync(book)).toBe(true)

  // The book note says what it is and where it came from.
  const content = readFileSync(book, 'utf8')
  expect(content).toMatch(/^---\nkind: document\n/)
  expect(content).toContain(`document: ${JSON.stringify(bookPath)}`)
  expect(content).toMatch(/\nhash: [0-9a-f]{40}\n/)

  // The index knows it is a document, and the global map leaves it out — a book
  // is what your notes are about, not one of them.
  const global = await page.evaluate(() => window.nodebook.graph(null, {}))
  expect(global.nodes.some((n) => n.label === 'on-government')).toBe(false)
  const shown = await page.evaluate(() => window.nodebook.graph(null, { showSources: true }))
  expect(shown.nodes.find((n) => n.label === 'on-government')?.kind).toBe('document')

  // …but it is still searchable.
  const hits = await page.evaluate(() => window.nodebook.search('aliment'))
  expect(hits.some((h) => h.path.includes('on-government'))).toBe(true)

  // A second run of the same document shares that one copy.
  const again = await distillPath(bookPath)
  await page.evaluate((r) => window.nodebook.distillMerge(r), again.runId)
  await expect.poll(() => readdirSync(join(root, 'Sources')).length).toBe(1)

  // Undoing one run leaves the book for the other; undoing the last takes it.
  await page.evaluate((r) => window.nodebook.distillUnmerge(r), again.runId)
  expect(existsSync(book)).toBe(true)
  await page.evaluate((r) => window.nodebook.distillUnmerge(r), id)
  await expect.poll(() => existsSync(book)).toBe(false)
  await page.evaluate((r) => window.nodebook.distillRemove(r), again.runId)
})

test('a citation says where the passage is, and the document opens its original', async () => {
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  await page.evaluate((r) => window.nodebook.distillMerge(r), id)
  const root = realpathSync(vaultDir)

  // Open a merged concept note: its Sources panel names the passage, not offsets.
  const concept = someConcept(id)
  const merged = readdirSync(join(root, 'Distilled', id)).find((n) => n.startsWith(concept))!
  if (await page.locator('.graph-close').count()) await page.locator('.graph-close').click()
  await page.locator('.tree-file', { hasText: merged.replace(/\.md$/, '') }).first().click()
  const cite = page.locator('.backlinks .source-cite').first()
  await expect(cite).toBeVisible()
  // The heading path's tail — the document's `## Faction`-style sections — not
  // a pair of character offsets.
  await expect(cite.locator('.source-span')).not.toContainText('–')
  await expect(cite.locator('.source-quote')).toBeVisible()

  // Clicking it opens the book note and selects the quote, so the recorded
  // spans really do land on the right words inside the `kind: document` note.
  await cite.click()
  await expect(page.locator('.cm-content')).toContainText('Faction arises')
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible()

  // The document's own note offers to open the file it was converted from.
  await expect(page.locator('.source-open-original')).toBeVisible()
  await expect(page.locator('.source-document-path')).toContainText('on-government.md')
  await page.locator('.source-open-original').click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toContain(bookPath)

  await page.evaluate((r) => window.nodebook.distillUnmerge(r), id)
})

test('a legacy .nodebook/distill run migrates to .distill, and a lost run.db rebuilds', async () => {
  const root = realpathSync(vaultDir)
  // A run staged by an older release, under the directory documented as a cache.
  const legacy = join(root, '.nodebook', 'distill', 'legacy-run')
  mkdirSync(join(legacy, 'notes'), { recursive: true })
  writeFileSync(join(legacy, 'notes', 'Legacy Book.md'), '# Legacy Book\n')
  writeFileSync(
    join(legacy, 'notes', 'Legacy Note.md'),
    '# Legacy Note\n\nsource:: [[Legacy Book]]\n'
  )
  writeFileSync(join(legacy, 'meta.json'), JSON.stringify({ source: 'legacy.md', notes: 1 }))

  // A finished run whose db was deleted — the markdown is the source of truth.
  const runs = await page.evaluate(() => window.nodebook.distillListRuns())
  const id = runs[0].id
  for (const f of ['run.db', 'run.db-wal', 'run.db-shm'])
    rmSync(join(root, '.distill', id, f), { force: true })

  await page.evaluate((dir) => window.nodebook.openVault(dir), root)

  const after = await page.evaluate(() => window.nodebook.distillListRuns())
  expect(after.map((r) => r.id)).toContain('legacy-run')
  expect(existsSync(join(root, '.distill', 'legacy-run', 'notes', 'Legacy Note.md'))).toBe(true)
  expect(existsSync(legacy)).toBe(false)

  // Both maps still render: the migrated run, and the one that lost its db.
  const migrated = await page.evaluate(() => window.nodebook.distillGraph('legacy-run'))
  expect(migrated.nodes.length).toBeGreaterThan(1)
  const rebuilt = await page.evaluate((r) => window.nodebook.distillGraph(r), id)
  expect(rebuilt.nodes.length).toBeGreaterThan(1)
})
