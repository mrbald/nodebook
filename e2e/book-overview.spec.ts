import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(__dirname, '..')
const THEMES = [
  ['Rights and obligations in the early republic', 'Rights'],
  ['Institutional balance and checks on executive power', 'Balance'],
  ['The economics of public borrowing', 'Borrowing'],
  ['Territorial boundaries and treaties', 'Boundaries'],
  ['Trade routes and regional development', 'Trade'],
  ['Courts, laws and constitutional interpretation', 'Courts'],
  ['A theme with no surviving notes', 'Empty']
] as const
const QUOTE = 'The council met at dawn.'
const SOURCE = `---\nkind: document\n---\n# Source book\n\n## Chapter Two\n\n${QUOTE}\n`

let app: ElectronApplication
let page: Page
let fixture: string

function seedRun(vault: string, run: string, membersPerTheme: number, themed: boolean, split = false): void {
  const folder = join(vault, '.distill', run)
  const notes = join(folder, 'notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, 'Source book.md'), SOURCE)
  const writeNote = (name: string, fields: string): void => {
    const start = SOURCE.indexOf(QUOTE)
    const provenance = name === 'Rights 1'
      ? `---\nsource: Source book.md\ncite:\n  - chunk: 1\n    span: ${start}-${start + QUOTE.length}\n    where: "Chapter Two"\n    quote: "${QUOTE}"\n---\n`
      : ''
    writeFileSync(join(notes, `${name}.md`), `${provenance}# ${name}\n\n${fields}\n\nStaged text for ${name}.\n`)
  }
  const source = 'source:: [[Source book]]'
  const nameAt = (i: number, j: number): string => {
    if (!split || i !== 1) return `${THEMES[i][1]} ${j}`
    if (j <= 30) return `Elections district ${j}`
    if (j <= 60) return `Appointments commission ${j}`
    return `Balance ${j}`
  }
  let count = 0
  if (themed) {
    THEMES.forEach(([theme, prefix], i) => {
      writeFileSync(join(notes, `${theme}.md`), `---\nkind: theme\n---\n# ${theme}\n\n${source}\n`)
      if (prefix === 'Empty') return
      const members = split && i === 1 ? 72 : membersPerTheme
      for (let j = 1; j <= members; j++) {
        const links = j === 1 ? [`develops:: [[${nameAt(i, 2)}]]`] : []
        for (let k = i + 1; k < THEMES.length - 1; k++) {
          if (j <= k + 1) links.push(`compare:: [[${nameAt(k, j)}]]`)
        }
        if (i === 0 && j === 1) links.push('', 'See [[Independent observation]].')
        if (split && i === 1 && j === 1) links.push('rebuts:: [[Rights 1]]')
        writeNote(nameAt(i, j), [source, `part_of:: [[${theme}]]`, ...links].join('\n'))
        count++
      }
    })
    writeNote('Independent observation', source)
    writeNote('Independent argument', source)
    count += 2
  } else {
    for (let i = 1; i <= membersPerTheme; i++) writeNote(`Observation ${i}`, source)
    count = membersPerTheme
  }
  writeFileSync(join(folder, 'meta.json'), JSON.stringify({
    source: 'book.md',
    notes: count + (themed ? THEMES.length : 0),
    themes: themed ? THEMES.map(([theme]) => theme) : []
  }))
}

test.beforeAll(async () => {
  fixture = mkdtempSync(join(realpathSync(tmpdir()), 'nodebook-book-map-'))
  const vault = join(fixture, 'vault')
  mkdirSync(join(fixture, 'user-data'))
  seedRun(vault, 'The large book', 36, true)
  seedRun(vault, 'The split book', 36, true, true)
  seedRun(vault, 'The small book', 2, true)
  seedRun(vault, 'The legacy book', 203, false)
  writeFileSync(join(vault, 'Rights 1.md'), '# Rights 1\n\nCanonical copy of Rights 1. See [[Vault note]].\n')
  writeFileSync(join(vault, 'Vault note.md'), '# Vault note\n')
  await launchFixture()
})

async function launchFixture(): Promise<void> {
  const binary = process.env.NODEBOOK_SMOKE_BINARY
  app = await launchElectron({
    executablePath: binary,
    args: binary ? [] : [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: join(fixture, 'user-data'), NODEBOOK_E2E: '1' }
  })
  if (binary) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, join(fixture, 'vault'))
  page = await app.firstWindow()
  await page.getByRole('button', { name: 'Open vault' }).click()
  await expect(page.locator('.run-item')).toHaveCount(4)
}

test.afterAll(async () => {
  await closeElectron(app)
  rmSync(fixture, { recursive: true, force: true })
})

async function openRun(name: string): Promise<void> {
  const close = page.getByRole('button', { name: '✕ Close', exact: true })
  if (await close.count()) await close.click()
  await page.locator('.run-item', { has: page.getByText(name, { exact: true }) }).press('Enter')
}

const scopeTrigger = () => page.getByTitle('Book map scope')
const scopeOption = (name: 'Standalone' | 'Overlay') => page.getByRole('menuitemradio', { name, exact: true })
type BookView = 'Note map' | 'Themes'
const viewTrigger = (name: BookView) => page.getByRole('button', { name: `View: ${name}`, exact: true })
const anyViewTrigger = () => page.getByRole('button', { name: /^View: (Note map|Themes)$/ })
const viewOption = (name: BookView) => page.getByRole('menuitemradio', { name, exact: true })

async function chooseScope(name: 'Standalone' | 'Overlay'): Promise<void> {
  await scopeTrigger().click()
  await scopeOption(name).click()
  await expect(scopeTrigger()).toHaveAccessibleName(new RegExp(`^Scope: ${name}`))
}

async function chooseView(name: BookView): Promise<void> {
  await anyViewTrigger().click()
  await viewOption(name).click()
  await expect(viewTrigger(name)).toBeFocused()
}

async function expectReaderFooter(): Promise<void> {
  const footer = page.locator('.book-map-pane:not([hidden]) .graph-toolbar')
  await expect(footer.getByRole('button', { name: /^Appearance:/ })).toBeVisible()
  await expect(footer.getByRole('button', { name: '✕ Close', exact: true })).toBeVisible()
  await expect(footer.getByRole('button', { name: /Merge|^(Scope|View):/ })).toHaveCount(0)
}

async function expectPopupInsideToolbarColumn(trigger: Locator, toolbar: Locator): Promise<void> {
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const popup = (await menu.boundingBox())!
  const bar = (await toolbar.boundingBox())!
  const anchor = (await trigger.boundingBox())!
  expect.soft(popup.x, 'menu starts inside the graph column').toBeGreaterThanOrEqual(bar.x)
  expect.soft(popup.x + popup.width, 'menu ends inside the graph column').toBeLessThanOrEqual(bar.x + bar.width)
  expect(popup.y + popup.height).toBeLessThan(anchor.y)

  // Include both ends of every text line in pointer hit-testing. A clipped label
  // can still have a bounding box and pass toBeVisible().
  for (const option of await menu.getByRole('menuitemradio').all()) {
    const textIsExposed = await option.evaluate((element) =>
      [...element.querySelectorAll('.status-option-label, small')].every((text) => {
        const range = document.createRange()
        range.selectNodeContents(text)
        return [...range.getClientRects()].every(({ left, right, top, height }) =>
          [left + 1, right - 1].every((x) => element.contains(document.elementFromPoint(x, top + height / 2)))
        )
      })
    )
    expect(textIsExposed, `${await option.getAttribute('aria-label')} text is exposed to pointer input`).toBe(true)
  }
}

test('a large book shows its themes, strongest links and selected link counts', async () => {
  await openRun('The large book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  await expect(viewTrigger('Themes')).toBeVisible()
  await expect(overview.getByRole('heading', { name: 'The large book' })).toBeVisible()
  await expect(overview).toContainText('7 themes · 218 notes')
  const canvas = overview.getByRole('group', { name: 'Themes in this book' })
  const themes = canvas.getByRole('button')
  await expect(themes).toHaveCount(THEMES.length)
  await expect(themes.first()).toBeVisible()
  expect(await canvas.locator('line').count()).toBeLessThan(15)
  expect(await canvas.locator('line').count()).toBeGreaterThan(0)
  expect(await themes.evaluateAll((elements) => {
    const boxes = elements.map((element) => element.getBoundingClientRect())
    return boxes.every((a, i) => boxes.slice(i + 1).every((b) =>
      a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
    ))
  })).toBe(true)

  const rights = themes.filter({ hasText: THEMES[0][0] })
  await rights.press('Enter')
  await expect(rights).toHaveAttribute('aria-pressed', 'true')
  const details = overview.getByRole('complementary', { name: 'Theme details' })
  await expect(details.getByRole('button', { name: 'Explore 36 notes' })).toBeVisible()
  const linked = details.getByRole('list', { name: 'Linked themes' })
  await expect(linked.getByRole('listitem')).toHaveCount(5)
  await expect(linked.getByRole('button', { name: `2 pairs with ${THEMES[1][0]}` })).toBeVisible()
  await expect(linked.getByRole('button', { name: `6 pairs with ${THEMES[5][0]}` })).toBeVisible()
  await expect(details.getByRole('list', { name: 'Representative notes' }).getByRole('button')).toHaveCount(3)
  await expect(canvas.locator('line')).toHaveCount(5)
  const connected = themes.filter({ hasText: THEMES[1][0] })
  await linked.getByRole('button', { name: THEMES[1][0], exact: true }).click()
  await expect(connected).toBeFocused()
  await expect(connected).toHaveAttribute('aria-pressed', 'true')

  await themes.filter({ hasText: THEMES[6][0] }).press('Enter')
  await expect(details).toContainText('No notes in this theme.')
  await expect(details.getByRole('button', { name: /Explore/ })).toHaveCount(0)
})

test('theme members open in Force and return from a staged note with camera and focus', async () => {
  await openRun('The large book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const theme = overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes` })
  await theme.press('Enter')
  const scene = overview.locator('.book-theme-scene')
  const beforeZoom = await scene.evaluate((el) => el.style.transform)
  const viewport = overview.getByRole('group', { name: 'Themes in this book' })
  await viewport.hover({ position: { x: 3, y: 3 } })
  await page.mouse.wheel(0, -300)
  await expect.poll(() => scene.evaluate((el) => el.style.transform)).not.toBe(beforeZoom)
  const zoomed = await scene.evaluate((el) => el.style.transform)
  const bounds = (await viewport.boundingBox())!
  await page.mouse.move(bounds.x + 3, bounds.y + 3)
  await page.mouse.down()
  await page.mouse.move(bounds.x - 32, bounds.y - 17)
  await page.mouse.up()
  await expect.poll(() => scene.evaluate((el) => el.style.transform)).not.toBe(zoomed)
  const overviewCamera = await scene.evaluate((el) => el.style.transform)
  const explore = overview.getByRole('button', { name: 'Explore 36 notes' })
  await explore.press('Enter')

  const themesBack = page.getByRole('button', { name: '← Back to themes' })
  await expect(themesBack).toBeFocused()
  await expect(anyViewTrigger()).toHaveCount(0)
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(canvas.getByRole('button')).toHaveCount(36)
  await expect(canvas.getByRole('button', { name: 'Rights 36', exact: true })).toBeAttached()
  await expect(page.getByRole('button', { name: 'Global', exact: true })).toHaveCount(0)
  const note = canvas.getByRole('button', { name: 'Rights 1', exact: true })
  await note.press('Space')
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await note.hover()
  const transform = canvas.locator(':scope > g[transform]')
  const beforeMemberZoom = await transform.getAttribute('transform')
  await page.mouse.wheel(0, -300)
  await expect(transform).not.toHaveAttribute('transform', beforeMemberZoom!)
  const memberCamera = await transform.getAttribute('transform')

  await note.press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toBeVisible()
  const mapBack = page.getByRole('button', { name: '← Back to map' })
  await expect(mapBack).toBeFocused()
  await mapBack.press('Enter')
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await expect(transform).toHaveAttribute('transform', memberCamera!)

  await themesBack.press('Enter')
  await expect(explore).toBeFocused()
  await expect(theme).toHaveAttribute('aria-pressed', 'true')
  expect(await scene.evaluate((el) => el.style.transform)).toBe(overviewCamera)
})

test('pair evidence opens both notes and a connected theme, then returns focus at each level', async () => {
  await openRun('The split book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const rights = overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes`, exact: true })
  await rights.press('Enter')
  const pairCount = overview.getByRole('button', { name: `2 pairs with ${THEMES[1][0]}`, exact: true })
  await pairCount.press('Enter')
  const pairs = page.getByRole('region', { name: 'Linked note pairs' })
  const path = page.getByRole('navigation', { name: 'Book path' })
  await expect(anyViewTrigger()).toHaveCount(0)
  await expect(path).toContainText(THEMES[0][0])
  await expect(path.locator('[aria-current="page"]')).toHaveText(`Links to ${THEMES[1][0]}`)
  await expect(pairs.getByText('Rights 1 → compare → Elections district 1', { exact: true })).toBeVisible()
  await expect(pairs.getByText('Elections district 1 → rebuts → Rights 1', { exact: true })).toBeVisible()

  const sourceNote = pairs.getByRole('button', { name: 'Rights 1', exact: true })
  await sourceNote.press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toBeVisible()
  await expectReaderFooter()
  const cite = page.locator('.staged-note-sources .source-cite')
  await expect(cite).toContainText('Chapter Two')
  await cite.press('Space')
  await expect(page.locator('.staged-source mark')).toHaveText(QUOTE)
  const passageBack = page.getByRole('button', { name: '← Back to “Rights 1”' })
  await expect(passageBack).toBeFocused()
  await expectReaderFooter()
  await expect(page.getByRole('button', { name: '← Back to pairs' })).toHaveCount(0)
  await passageBack.press('Enter')
  await expect(cite).toBeFocused()
  await page.getByRole('button', { name: '← Back to pairs' }).press('Enter')
  await expect(sourceNote).toBeFocused()

  const targetNote = pairs.getByRole('button', { name: 'Elections district 1', exact: true })
  await targetNote.press('Enter')
  await expect(page.getByText('Staged text for Elections district 1.')).toBeVisible()
  await page.getByRole('button', { name: '← Back to pairs' }).press('Enter')
  await expect(targetNote).toBeFocused()

  const connectedTheme = pairs.getByRole('button', { name: `Explore ${THEMES[1][0]}` })
  await connectedTheme.press('Enter')
  const subthemes = page.getByRole('region', { name: 'Subthemes' })
  const elections = subthemes.getByRole('button', { name: 'Elections district 30 notes', exact: true })
  const all = subthemes.getByRole('button', { name: 'Show all 72 notes', exact: true })
  await expect(path.locator('[aria-current="page"]')).toHaveText(THEMES[1][0])
  await elections.press('Enter')
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas.getByRole('button')).toHaveCount(30)
  await expect(canvas.getByRole('button', { name: 'Elections district 1', exact: true })).toBeAttached()
  await expect(canvas.getByRole('button', { name: 'Appointments commission 31', exact: true })).toHaveCount(0)
  await expect(path).toContainText(THEMES[1][0])
  await expect(path.locator('[aria-current="page"]')).toHaveText('Elections district')
  await chooseScope('Overlay')
  await expect(canvas.getByRole('button', { name: 'Vault note', exact: true })).toBeAttached()
  await chooseScope('Standalone')
  await expect(canvas.getByRole('button')).toHaveCount(30)
  await expect(path.locator('[aria-current="page"]')).toHaveText('Elections district')
  await page.getByRole('button', { name: '← Back to theme', exact: true }).press('Enter')
  await expect(elections).toBeFocused()
  await all.press('Enter')
  await expect(canvas.getByRole('button')).toHaveCount(72)
  await page.getByRole('button', { name: '← Back to theme', exact: true }).press('Enter')
  await expect(all).toBeFocused()
  await page.getByRole('button', { name: '← Back to pairs', exact: true }).press('Enter')
  await expect(connectedTheme).toBeFocused()
  await page.getByRole('button', { name: '← Back to themes', exact: true }).press('Enter')
  await expect(pairCount).toBeFocused()
  await expect(rights).toHaveAttribute('aria-pressed', 'true')
})

test('an overlay note returns to the overlay opened from pairs, then Standalone restores the evidence', async () => {
  await openRun('The split book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  await overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes`, exact: true }).press('Enter')
  const pairsEntry = overview.getByRole('button', { name: `2 pairs with ${THEMES[1][0]}`, exact: true })
  await pairsEntry.press('Enter')
  const pairs = page.getByRole('region', { name: 'Linked note pairs' })
  const evidence = pairs.getByText('Rights 1 → compare → Elections district 1', { exact: true })
  await expect(evidence).toBeVisible()
  await chooseScope('Overlay')
  await expect(pairs).toHaveCount(0)

  const graph = page.getByRole('group', { name: 'Knowledge map notes' })
  const staged = graph.getByRole('button', { name: 'Rights 1', exact: true })
    .and(page.locator('[data-node-id*=".distill"]'))
  await staged.press('Space')
  await staged.press('Enter')
  await expect(page.getByRole('button', { name: '← Back to pairs', exact: true })).toHaveCount(0)
  const back = page.getByRole('button', { name: '← Back to overlay', exact: true })
  await expect(back).toBeFocused()
  await back.press('Enter')
  await expect(staged).toBeFocused()
  await expect(staged).toHaveAttribute('aria-pressed', 'true')
  await expect(scopeTrigger()).toHaveAccessibleName(/^Scope: Overlay/)

  await chooseScope('Standalone')
  await expect(evidence).toBeVisible()
  await page.getByRole('button', { name: '← Back to themes', exact: true }).press('Enter')
  await expect(pairsEntry).toBeFocused()
})

test('a small-book reader can jump to its theme and book and return to the originating note', async () => {
  await openRun('The small book')
  const map = page.getByRole('group', { name: 'Knowledge map notes' })
  const note = map.getByRole('button', { name: 'Rights 1', exact: true })
  await note.press('Space')
  await note.press('Enter')
  const reader = page.locator('.staged-note:visible')
  const theme = reader.getByRole('button', { name: `Go to theme: ${THEMES[0][0]}` })
  await theme.press('Enter')
  await expect(map.getByRole('button')).toHaveCount(2)
  await expect(page.getByRole('navigation', { name: 'Book path' })).toContainText(THEMES[0][0])
  await page.getByRole('button', { name: '← Back to note', exact: true }).press('Enter')
  await expect(theme).toBeFocused()

  const book = reader.getByRole('button', { name: 'Go to book', exact: true })
  await book.press('Enter')
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: 'Book overview' })).toHaveCount(0)
  await page.getByRole('button', { name: '← Back to note', exact: true }).press('Enter')
  await expect(book).toBeFocused()
  await reader.getByRole('button', { name: '← Back to map', exact: true }).press('Enter')
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
})

test('unassigned notes, the full map and overlay remain reachable', async () => {
  await openRun('The large book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const unassigned = overview.getByRole('button', { name: 'Unassigned notes (2)' })
  await unassigned.click()
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(canvas.getByRole('button')).toHaveCount(2)
  await expect(canvas.getByRole('button', { name: 'Independent observation' })).toBeAttached()
  await expect(canvas.getByRole('button', { name: 'Independent argument' })).toBeAttached()
  await expect(anyViewTrigger()).toHaveCount(0)

  const themesBack = page.getByRole('button', { name: '← Back to themes' })
  await themesBack.click()
  await expect(unassigned).toBeFocused()
  const map = overview.getByRole('button', { name: 'Note map', exact: true })
  await map.click()
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  expect(await canvas.getByRole('button').count()).toBeGreaterThan(36)
  await page.locator('.status-select-layout:visible').getByRole('button').click()
  await expect(page.getByRole('menuitemradio', { name: 'Routed (ELK)' })).toBeVisible()
  await page.keyboard.press('Escape')
  await themesBack.press('Enter')
  await expect(map).toBeFocused()

  await expect(page.getByRole('button', { name: /Merge/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Appearance:/ })).toBeVisible()
  const selectedTheme = overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes`, exact: true })
  await selectedTheme.press('Enter')
  const scene = overview.locator('.book-theme-scene')
  const originalCamera = await scene.evaluate((el) => el.style.transform)
  await overview.getByRole('group', { name: 'Themes in this book' }).hover({ position: { x: 3, y: 3 } })
  await page.mouse.wheel(0, -300)
  await expect.poll(() => scene.evaluate((el) => el.style.transform)).not.toBe(originalCamera)
  const overviewCamera = await scene.evaluate((el) => el.style.transform)

  const scope = scopeTrigger()
  await expect(scope).toHaveAccessibleName(/^Scope: Standalone/)
  await expect(page.locator('.status-select-book-scope')).toHaveCount(1)
  await scope.press('Enter')
  await expect(scopeOption('Standalone')).toHaveAttribute('aria-checked', 'true')
  await expect(scopeOption('Standalone')).toBeFocused()
  await expect(scopeOption('Overlay')).toHaveAttribute('aria-checked', 'false')
  await expect(scopeOption('Overlay')).toHaveAccessibleDescription('This book and your vault notes')
  await page.keyboard.press('Enter')
  await expect(overview).toBeVisible()
  await expect(scope).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)

  await scope.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(scopeOption('Overlay')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(overview).toHaveCount(0)
  await expect(anyViewTrigger()).toHaveCount(0)
  await expect(scope).toHaveAccessibleName(/^Scope: Overlay/)
  await expect(scope).toBeFocused()
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(canvas.getByRole('button', { name: 'Vault note', exact: true })).toBeAttached()
  await expect(canvas.getByRole('button', { name: 'Rights 1', exact: true })).toHaveCount(2)
  await expect(page.getByTitle('Map scope', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Increase depth' })).toBeHidden()
  await expect(page.locator('.status-select-book-scope')).toHaveCount(1)

  await scope.press('Enter')
  await expect(scopeOption('Overlay')).toHaveAttribute('aria-checked', 'true')
  await expect(scopeOption('Overlay')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(scope).toBeFocused()
  await scope.press('Enter')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Space')
  await expect(overview).toBeVisible()
  await expect(viewTrigger('Themes')).toBeVisible()
  await expect(selectedTheme).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => scene.evaluate((el) => el.style.transform)).toBe(overviewCamera)
  await expect(scope).toHaveAccessibleName(/^Scope: Standalone/)
  await expect(scope).toBeFocused()
  await expect(canvas).toHaveCount(0)
})

test('small books and large unthemed books open in the note map by default', async () => {
  await openRun('The small book')
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(viewTrigger('Note map')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Book overview' })).toHaveCount(0)

  await openRun('The legacy book')
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(anyViewTrigger()).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Book overview' })).toHaveCount(0)
})

test('the book view menu supports keyboard selection and preserves each map', async () => {
  await openRun('The small book')
  const noteMap = viewTrigger('Note map')
  const themes = viewTrigger('Themes')
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  const note = canvas.getByRole('button', { name: 'Rights 1', exact: true })
  await note.press('Space')
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
  const transform = canvas.locator(':scope > g[transform]')
  const beforeZoom = await transform.getAttribute('transform')
  await canvas.hover()
  await page.mouse.wheel(0, -300)
  await expect(transform).not.toHaveAttribute('transform', beforeZoom!)
  const noteCamera = await transform.getAttribute('transform')

  await expect(noteMap).toHaveAttribute('aria-haspopup', 'menu')
  await noteMap.press('ArrowDown')
  await expect(noteMap).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('menu', { name: 'View: Note map' })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2)
  await expect(viewOption('Note map')).toHaveAttribute('aria-checked', 'true')
  await expect(viewOption('Note map')).toBeFocused()
  await expect(viewOption('Themes')).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await expect(noteMap).toBeFocused()
  await expect(noteMap).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toHaveCount(0)

  await noteMap.press('Enter')
  await page.keyboard.press('ArrowDown')
  await expect(viewOption('Themes')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(themes).toBeFocused()
  await expect(anyViewTrigger()).toHaveCount(1)
  const overview = page.getByRole('region', { name: 'Book overview' })
  const theme = overview.getByRole('button', { name: `${THEMES[0][0]} 2 notes`, exact: true })
  await theme.press('Enter')
  await expect(theme).toHaveAttribute('aria-pressed', 'true')
  const scene = overview.locator('.book-theme-scene')
  const beforeThemeZoom = await scene.evaluate((element) => element.style.transform)
  await overview.getByRole('group', { name: 'Themes in this book' }).hover({ position: { x: 3, y: 3 } })
  await page.mouse.wheel(0, -300)
  await expect.poll(() => scene.evaluate((element) => element.style.transform)).not.toBe(beforeThemeZoom)
  const themeCamera = await scene.evaluate((element) => element.style.transform)

  await themes.press('Enter')
  await expect(viewOption('Themes')).toBeFocused()
  await expect(viewOption('Themes')).toHaveAttribute('aria-checked', 'true')
  await expect(viewOption('Note map')).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(noteMap).toBeFocused()
  await expect(page.getByRole('button', { name: '← Back to themes', exact: true })).toHaveCount(0)
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await expect(transform).toHaveAttribute('transform', noteCamera!)

  await chooseScope('Overlay')
  await expect(anyViewTrigger()).toHaveCount(0)
  await chooseScope('Standalone')
  await expect(noteMap).toBeVisible()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await expect(transform).toHaveAttribute('transform', noteCamera!)

  await chooseView('Themes')
  await expect(theme).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => scene.evaluate((element) => element.style.transform)).toBe(themeCamera)
})

test('the threshold applies when opening a themed book and zero opens its themes', async () => {
  const settings = await page.evaluate(async () => window.nodebook.readFile(await window.nodebook.settingsPath()))
  const replaceThreshold = (value: number): string =>
    settings.replace(/^themeOverviewThreshold = .*$/m, `themeOverviewThreshold = ${value}`)
  const editSettings = async (text: string): Promise<void> => {
    const editor = page.locator('.settings-body .cm-content')
    if (!(await editor.isVisible())) {
      await page.getByRole('button', { name: '⚙ Settings', exact: true }).click()
    }
    await editor.press('ControlOrMeta+A')
    await page.keyboard.insertText(text)
    await page.locator('.settings-actions').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () =>
      window.nodebook.readFile(await window.nodebook.settingsPath())
    )).toBe(text)
  }

  try {
    await openRun('The large book')
    await expect(viewTrigger('Themes')).toBeVisible()
    await editSettings(replaceThreshold(218))
    await expect(viewTrigger('Themes')).toBeVisible()
    await openRun('The large book')
    await expect(viewTrigger('Note map')).toBeVisible()
    await chooseView('Themes')
    await expect(page.getByRole('region', { name: 'Book overview' })).toContainText('7 themes · 218 notes')
    await chooseView('Note map')

    await editSettings(replaceThreshold(0))
    await expect(viewTrigger('Note map')).toBeVisible()
    await openRun('The small book')
    await expect(viewTrigger('Themes')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Book overview' })).toContainText('7 themes · 14 notes')
    await chooseView('Note map')
    await openRun('The small book')
    await expect(viewTrigger('Themes')).toBeVisible()
    await openRun('The legacy book')
    await expect(page.getByRole('group', { name: 'Knowledge map notes' })).toBeVisible()
    await expect(anyViewTrigger()).toHaveCount(0)
  } finally {
    await editSettings(settings)
  }
})

for (const [width, height] of [[1100, 700], [720, 460]]) {
  test(`the standalone book map view, colour and scope menus are readable and clickable at ${width}px`, async () => {
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
    try {
      await app.evaluate(({ BrowserWindow }, [width, height]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]
      )
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      await openRun('The small book')
      await expect(page.getByRole('group', { name: 'Knowledge map notes' })).toBeVisible()
      const toolbar = page.locator('.graph-toolbar:visible')
      const colour = toolbar.getByTitle('Colour the dots by…')
      await expect(toolbar.getByRole('button').first()).toHaveAccessibleName('Scope: Standalone')
      await expect(colour).toHaveAccessibleName('Colour: Links')
      const panel = await page.locator('.editor-pane').boundingBox()
      const toolbarBounds = await toolbar.boundingBox()
      expect(Math.abs(panel!.width - toolbarBounds!.width)).toBeLessThan(2)
      const view = viewTrigger('Note map')
      await view.click()
      await expect(viewOption('Note map')).toBeFocused()
      await expectPopupInsideToolbarColumn(view, toolbar)
      await viewOption('Themes').click()
      await expect(viewTrigger('Themes')).toBeFocused()
      await chooseView('Note map')

      await colour.click()

      const menu = page.getByRole('menu')
      const options = menu.getByRole('menuitemradio')
      await expect(options).toHaveText(['Links', 'Folder'])
      await expectPopupInsideToolbarColumn(colour, toolbar)
      await menu.getByRole('menuitemradio', { name: 'Folder', exact: true }).click()
      await expect(colour).toHaveAccessibleName('Colour: Folder')
      await expect(menu).toHaveCount(0)

      const scope = scopeTrigger()
      await scope.click()
      await expect(scopeOption('Standalone')).toBeFocused()
      await expectPopupInsideToolbarColumn(scope, toolbar)
      await scopeOption('Overlay').click()
      await expect(scope).toHaveAccessibleName('Scope: Overlay')
      await expect(scope).toBeFocused()
      await expect(menu).toHaveCount(0)
    } finally {
      await app.evaluate(({ BrowserWindow }, [width, height]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height), size
      )
    }
  })
}

test('a layout choice follows the user across maps and an app restart', async () => {
  await openRun('The large book')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  const back = page.getByRole('button', { name: '← Back to themes' })
  const chooseLayout = async (name: string): Promise<void> => {
    await page.locator('.status-select-layout:visible').getByTitle('Map layout').click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
  }

  await chooseView('Note map')
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
  const scene = canvas.locator(':scope > g[transform]')
  const before = await scene.getAttribute('transform')
  await canvas.hover()
  await page.mouse.wheel(0, -300)
  await expect(scene).not.toHaveAttribute('transform', before!)
  const noteCamera = await scene.getAttribute('transform')
  await chooseView('Themes')

  await overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes` }).press('Enter')
  await overview.getByRole('button', { name: 'Explore 36 notes' }).press('Enter')
  await expect(canvas).toHaveAttribute('data-layout', 'force')
  await chooseLayout('Routed (ELK)')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  const hidden = page.locator('.book-map-pane[hidden] .graph-canvas')
  await expect(hidden).toHaveAttribute('data-layout', 'force')
  await expect(hidden.locator(':scope > g[transform]')).toHaveAttribute('transform', noteCamera!)

  await back.click()
  await chooseView('Note map')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  await chooseScope('Overlay')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  await page.getByRole('button', { name: '✕ Close', exact: true }).click()
  await page.locator('.tree-name').filter({ hasText: /^Rights 1$/ }).click()
  await page.locator('.graph-open-btn').click()
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  await openRun('The small book')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')

  await closeElectron(app)
  await launchFixture()
  await openRun('The small book')
  const restartedCanvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(restartedCanvas).toHaveAttribute('data-layout', 'routed')
  await chooseLayout('Force')
  await expect(restartedCanvas).toHaveAttribute('data-layout', 'force')
})

test('a narrow theme overview keeps its full labels readable with keyboard focus', async () => {
  await openRun('The large book')
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(550, 420))
    const overview = page.getByRole('region', { name: 'Book overview' })
    await expect(overview).toBeVisible()
    await expect.poll(() => overview.evaluate((element) => element.clientWidth)).toBeLessThan(350)
    await overview.getByRole('button', { name: 'Fit view', exact: true }).click()
    await expect.poll(() => overview.locator('.book-theme-scene').evaluate((element) => {
      const view = element.parentElement!.getBoundingClientRect()
      const scene = element.getBoundingClientRect()
      return scene.left >= view.left - 1 && scene.right <= view.right + 1 &&
        scene.top >= view.top - 1 && scene.bottom <= view.bottom + 1
    })).toBe(true)
    await expect(overview.getByRole('button', { name: 'Clear placements', exact: true })).toHaveCount(0)
    const themes = overview.getByRole('group', { name: 'Themes in this book' }).getByRole('button')
    await expect(themes).toHaveCount(THEMES.length)
    for (const theme of await themes.all()) {
      await theme.focus()
      await expect(theme).toBeFocused()
      await expect.poll(() => theme.evaluate((element) => {
        const label = element.querySelector('.book-theme-title')!
        const viewport = element.closest('.book-theme-viewport')!.getBoundingClientRect()
        const bounds = label.getBoundingClientRect()
        return parseFloat(getComputedStyle(label).fontSize) >= 13 &&
          bounds.left >= viewport.left && bounds.right <= viewport.right &&
          bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
      })).toBe(true)
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, height), size
    )
  }
})

test('overlay colour distinguishes twin origins and changes when a different mode is selected', async () => {
  await openRun('The small book')
  await chooseScope('Overlay')
  const map = page.locator('.graph-view:visible')
  const layout = map.getByTitle('Map layout')
  await layout.click()
  await page.getByRole('menuitemradio', { name: 'Force', exact: true }).click()
  const colour = map.getByTitle('Colour the dots by…')
  await expect(colour).toHaveAccessibleName('Colour: Origin')
  const twins = map.getByRole('button', { name: 'Rights 1', exact: true })
  await expect(twins).toHaveCount(2)
  const staged = twins.and(map.locator('[data-node-id*=".distill"]'))
  const vault = twins.and(map.locator('[data-node-id]:not([data-node-id*=".distill"])'))
  const stagedDot = staged.locator('.graph-force-dot')
  const vaultDot = vault.locator('.graph-force-dot')
  await expect(stagedDot).toHaveCSS('fill', 'rgb(122, 162, 247)')
  const vaultOrigin = await vaultDot.evaluate((node) => getComputedStyle(node).fill)
  expect(vaultOrigin).not.toBe('rgb(122, 162, 247)')
  await expect(map.locator('.graph-inspector').getByText('Staged note', { exact: true })).toBeVisible()
  await expect(map.locator('.graph-inspector').getByText('Vault note', { exact: true })).toBeVisible()

  await colour.click()
  await expect(page.getByRole('menuitemradio', { name: 'Origin', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitemradio', { name: 'Folder', exact: true }).click()
  await expect(colour).toHaveAccessibleName('Colour: Folder')
  await expect(stagedDot).not.toHaveCSS('fill', 'rgb(122, 162, 247)')
  await expect(vaultDot).not.toHaveCSS('fill', vaultOrigin)

  await colour.click()
  await page.getByRole('menuitemradio', { name: 'Links', exact: true }).click()
  await expect(colour).toHaveAccessibleName('Colour: Links')
  await expect(vaultDot).not.toHaveCSS('fill', vaultOrigin)
  await staged.press('Space')
  await expect(map.locator('.graph-insp-stat')).toContainText('Staged note')
  await vault.press('Space')
  await expect(map.locator('.graph-insp-stat')).toContainText('Vault note')
})

test('overlay opens the intended staged or vault note even when their names match', async () => {
  await openRun('The small book')
  const scope = scopeTrigger()
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  await expect(canvas.getByRole('button', { name: 'Rights 1', exact: true })).toHaveCount(1)
  await expect(canvas.getByRole('button', { name: 'Vault note', exact: true })).toHaveCount(0)
  await chooseScope('Overlay')
  const twins = page.getByRole('group', { name: 'Knowledge map notes' }).getByRole('button', { name: 'Rights 1', exact: true })
  await expect(twins).toHaveCount(2)
  await expect(canvas.getByRole('button', { name: 'Vault note', exact: true })).toBeAttached()
  const staged = twins.and(page.locator('[data-node-id*=".distill"]'))
  const vault = twins.and(page.locator('[data-node-id]:not([data-node-id*=".distill"])'))
  await staged.press('Space')
  await expect(page.locator('.graph-insp-edge', { hasText: 'Independent observation' })).toContainText('links_to')
  await expect(page.getByRole('button', { name: '+ name', exact: true })).toHaveCount(0)
  const stagedPath = await staged.getAttribute('data-node-id')
  await expect(page.evaluate((path) => window.nodebook.typeRelation(path!, 'about', 'Rights 2'), stagedPath))
    .rejects.toThrow('Only a note in the open vault')
  const open = page.getByRole('button', { name: 'Open ↗' })
  await open.press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '← Back to overlay' }).press('Enter')
  await expect(open).toBeFocused()
  await expect(scope).toHaveAccessibleName(/^Scope: Overlay/)

  await staged.press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toBeVisible()
  await page.locator('.run-item', { has: page.getByText('The small book', { exact: true }) }).press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toHaveCount(0)
  await expect(scope).toHaveAccessibleName(/^Scope: Standalone/)
  await chooseScope('Overlay')
  await expect(twins).toHaveCount(2)
  await vault.press('Space')
  await expect(vault).toHaveAttribute('aria-pressed', 'true')
  await vault.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Canonical copy of Rights 1.')
  await expect(page.getByRole('group', { name: 'Knowledge map notes' })).toHaveCount(0)
  await page.locator('.cm-content').press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('reader_check:: [[Vault note]]')
  await page.getByRole('button', { name: '← Back to The small book', exact: true }).press('Enter')
  await expect(vault).toBeFocused()
  await expect(vault).toHaveAttribute('aria-pressed', 'true')
  await expect(scope).toHaveAccessibleName(/^Scope: Overlay/)
  await expect(page.locator('.graph-view:visible .graph-insp-edge', { hasText: 'reader_check' })).toContainText('Vault note')
  await vault.press('Enter')
  await page.locator('.run-item').filter({ has: page.getByText('The small book', { exact: true }) }).press('Enter')
  await expect(scope).toHaveAccessibleName(/^Scope: Standalone/)
  await expect(page.getByRole('button', { name: /Back to overlay/ })).toHaveCount(0)
})

test('sidebar note navigation leaves the book, theme, staged note and overlay', async () => {
  const tree = page.locator('.file-tree')
  const rights = tree.getByRole('button', { name: 'Rights 1', exact: true })
  const vaultNote = tree.getByRole('button', { name: 'Vault note', exact: true })
  const editor = page.locator('.cm-content')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const map = page.getByRole('group', { name: 'Knowledge map notes' })

  await openRun('The large book')
  await expect(overview).toBeVisible()
  await rights.click()
  await expect(editor).toContainText('Canonical copy of Rights 1.')

  await openRun('The large book')
  await overview.getByRole('button', { name: `${THEMES[0][0]} 36 notes` }).press('Enter')
  await overview.getByRole('button', { name: 'Explore 36 notes' }).press('Enter')
  await expect(map).toBeVisible()
  await vaultNote.press('Enter')
  await expect(editor).toContainText('Vault note')

  await openRun('The small book')
  await map.getByRole('button', { name: 'Rights 1', exact: true }).press('Enter')
  await expect(page.locator('.staged-note').getByText('Staged text for Rights 1.', { exact: true })).toBeVisible()
  await rights.press('Space')
  await expect(editor).toContainText('Canonical copy of Rights 1.')

  await openRun('The small book')
  await chooseScope('Overlay')
  await expect(map.getByRole('button', { name: 'Rights 1', exact: true })).toHaveCount(2)
  await vaultNote.click()
  await expect(editor).toContainText('Vault note')
  await expect(map).toHaveCount(0)

  await page.getByRole('button', { name: '⊹ Map' }).click()
  await expect(map).toBeVisible()
  await rights.press('Enter')
  await expect(editor).toContainText('Canonical copy of Rights 1.')
})

test('book mode keeps Find Note available and disables hidden editor commands', async () => {
  const nativeMenuStates = (): Promise<Record<string, boolean | undefined>> =>
    app.evaluate(({ Menu }, labels) => {
      const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []) ?? []
      return Object.fromEntries(labels.map((label) => [label, items.find((item) => item.label === label)?.enabled]))
    }, ['Find Note…', 'New Note', 'Save', 'Export PDF…', 'Print…', 'Knowledge Map', 'Code', 'Live', 'Reading', 'Toggle Reading'])

  await page.locator('.file-tree').getByRole('button', { name: 'Vault note', exact: true }).click()
  await expect.poll(nativeMenuStates).toMatchObject({ Save: true, 'Export PDF…': true, 'Knowledge Map': true })
  await openRun('The large book')
  await expect(page.getByRole('region', { name: 'Book overview' })).toBeVisible()
  await expect.poll(nativeMenuStates).toEqual({
    'Find Note…': true,
    'New Note': true,
    Save: false,
    'Export PDF…': false,
    'Print…': false,
    'Knowledge Map': false,
    Code: false,
    Live: false,
    Reading: false,
    'Toggle Reading': false
  })

  const search = page.getByRole('textbox', { name: 'Search notes' })
  await search.fill('canonical copy')
  await expect(page.locator('.search-result-title')).toHaveText('Rights 1')
  await search.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('Canonical copy of Rights 1.')
  await expect.poll(nativeMenuStates).toMatchObject({ Save: true, 'Export PDF…': true, 'Knowledge Map': true })
  await search.fill('')
})

test('a vault draft stays put when opening a book is cancelled at a save conflict', async () => {
  const vaultNote = page.locator('.file-tree').getByRole('button', { name: 'Vault note', exact: true })
  const rights = page.locator('.file-tree').getByRole('button', { name: 'Rights 1', exact: true })
  const editor = page.locator('.cm-content')
  const dialog = page.getByRole('dialog')
  const overview = page.getByRole('region', { name: 'Book overview' })
  const path = join(fixture, 'vault', 'Vault note.md')

  await vaultNote.click()
  await expect(editor).toContainText('Vault note')
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.insertText('Local draft.')
  await expect(editor).toContainText('Local draft.')
  writeFileSync(path, '# Vault note\n\nExternal revision.\n')

  await openRun('The large book')
  await expect(dialog).toContainText('changed on disk')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overview).toHaveCount(0)
  await expect(editor).toContainText('Local draft.')
  expect(await page.evaluate((file) => window.nodebook.readFile(file), path)).toContain('External revision.')

  await openRun('The large book')
  await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click()
  await expect(overview).toBeVisible()
  await rights.click()
  await expect(editor).toContainText('Canonical copy of Rights 1.')
  expect(await page.evaluate((file) => window.nodebook.readFile(file), path)).toContain('Local draft.')
})


test('dismissing the merge banner keeps the current book merged and its undo available', async () => {
  await openRun('The small book')
  const merge = page.getByRole('button', { name: 'Merge book…', exact: true })
  await merge.click()
  await page.getByRole('dialog').locator('.merge-confirm').click()
  const banner = page.locator('.distill-merged-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(merge).toHaveCount(0)
  const undo = page.getByRole('button', { name: 'Undo merge', exact: true })
  await expect(undo).toBeVisible()
  await openRun('The large book')
  await expect(merge).toBeVisible()
  await expect(undo).toHaveCount(0)
  await openRun('The small book')
  await expect(merge).toHaveCount(0)
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await undo.click()
  await expect(merge).toBeVisible()
  await page.getByRole('button', { name: '✕ Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open run The small book', exact: true })).toBeFocused()
})
