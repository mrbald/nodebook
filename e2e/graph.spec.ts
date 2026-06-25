import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The knowledge-map MVP: open a note's local graph, see its links as nodes/edges,
// click a neighbour to navigate.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nodebook-graph-'))
  cpSync(fixtureVault, vaultDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.nodebook')
  })
  // A note with two link *types* (a wikilink + a typed field) so the legend
  // filter has something to filter.
  writeFileSync(join(vaultDir, 'Hub.md'), '# Hub\n\nSee [[Graph Model]].\n\ntopic:: science\n')
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-graph-userdata-'))
  app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, NODEBOOK_USER_DATA: userDataDir, NODEBOOK_E2E: '1' }
  })
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, vaultDir)
  page = await app.firstWindow()
  await page.waitForSelector('.open-btn')
  await page.getByRole('button', { name: 'Open vault' }).click()
  await page.locator('.tree-file', { hasText: 'welcome' }).click()
})

test.afterAll(async () => {
  await app?.close()
})

test('the ⊹ Map button opens a force-directed graph with nodes and edges', async () => {
  await page.locator('.graph-open-btn', { hasText: 'Map' }).click()
  await expect(page.locator('.graph-view')).toBeVisible()
  await expect(page.locator('.graph-insp-title')).toContainText('welcome')

  // Focus (welcome) + its two neighbours; the neighbours are themselves linked
  // (Roadmap → Graph Model), so the local slice shows all three edges.
  await expect(page.locator('.graph-node')).toHaveCount(3)
  await expect(page.locator('.graph-node.is-focus')).toHaveText(/welcome/)
  await expect(page.locator('.graph-node', { hasText: 'Graph Model' })).toBeVisible()
  await expect(page.locator('.graph-edge')).toHaveCount(3)
})

test('chrome is consistent: controls sit at the bottom, no blank right column', async () => {
  const canvas = await page.locator('.graph-canvas').boundingBox()
  const toolbar = await page.locator('.graph-toolbar').boundingBox()
  if (!canvas || !toolbar) throw new Error('no boxes')
  expect(toolbar.y).toBeGreaterThan(canvas.y) // toolbar below the canvas, like the editor
  await expect(page.locator('.app')).toHaveClass(/app--no-right/) // grid collapsed — no void
})

test('Global toggle and depth control change the slice (then restore)', async () => {
  await page.locator('.graph-ctl', { hasText: 'Global' }).click()
  await expect(page.locator('.graph-insp-title')).toContainText(/whole vault/i)
  await expect(page.locator('.graph-node').first()).toBeVisible()

  await page.locator('.graph-ctl', { hasText: 'Local' }).click()
  await expect(page.locator('.graph-insp-title')).toContainText('welcome')

  await expect(page.locator('.graph-depth')).toContainText('depth 1')
  await page.locator('.graph-depth .graph-ctl').last().click() // +
  await expect(page.locator('.graph-depth')).toContainText('depth 2')
  await page.locator('.graph-depth .graph-ctl').first().click() // −
  await expect(page.locator('.graph-depth')).toContainText('depth 1')
})

test('clicking a node selects it (inspector shows details); double-click refocuses', async () => {
  // Single click = select: the inspector shows the node; the view is unchanged.
  await page.locator('.graph-node', { hasText: 'Graph Model' }).click()
  await expect(page.locator('.graph-insp-title')).toContainText('Graph Model')
  await expect(page.locator('.graph-node.is-selected')).toHaveText(/Graph Model/)
  await expect(page.locator('.graph-insp-section', { hasText: 'Links' })).toBeVisible()
  await expect(page.locator('.graph-node.is-focus')).toHaveText(/welcome/) // still welcome

  // Double click = refocus the map on it.
  await page.locator('.graph-node', { hasText: 'Graph Model' }).dblclick()
  await expect(page.locator('.graph-node.is-focus')).toHaveText(/Graph Model/)
})

test('dragging a node moves it (interactive layout)', async () => {
  const node = page.locator('.graph-node', { hasText: 'Graph Model' }).first()
  const before = await node.getAttribute('transform')
  const box = await node.boundingBox()
  if (!box) throw new Error('no node box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 5 })
  await page.mouse.up()
  await expect(node).not.toHaveAttribute('transform', before ?? '')
})

test('Close returns to the editor', async () => {
  await page.locator('.graph-close').click()
  await expect(page.locator('.graph-view')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('clicking a link type in the legend filters it; reset restores', async () => {
  await page.locator('.tree-file', { hasText: 'Hub' }).click()
  await page.locator('.graph-open-btn').click()
  await expect(page.locator('.graph-legend-item', { hasText: 'topic' })).toBeVisible()

  const before = await page.locator('.graph-edge').count()
  await page.locator('.graph-legend-item', { hasText: 'topic' }).click()
  await expect(page.locator('.graph-legend-item.is-off', { hasText: 'topic' })).toBeVisible()
  expect(await page.locator('.graph-edge').count()).toBeLessThan(before)

  await page.locator('.graph-ctl', { hasText: 'show all' }).click()
  await expect(page.locator('.graph-legend-item.is-off')).toHaveCount(0)
})

test('right-clicking a node hides it; reset brings it back', async () => {
  const before = await page.locator('.graph-node').count()
  await page.locator('.graph-node', { hasText: 'Graph Model' }).click({ button: 'right' })
  expect(await page.locator('.graph-node').count()).toBeLessThan(before)

  await page.locator('.graph-ctl', { hasText: 'show all' }).click()
  expect(await page.locator('.graph-node').count()).toBe(before)
})

test('colour mode cycles to folder and the legend switches to folders', async () => {
  await page.locator('.graph-ctl', { hasText: 'colour' }).click() // links → folder
  await expect(page.locator('.graph-ctl', { hasText: 'colour: folder' })).toBeVisible()
  await expect(page.locator('.graph-legend-item', { hasText: '(root)' })).toBeVisible()
})

test('pinning a node anchors it in place across a relayout', async () => {
  const node = page.locator('.graph-node', { hasText: 'Graph Model' })
  await node.click() // select
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(page.locator('.graph-node.is-pinned')).toHaveText(/Graph Model/)

  const before = await node.getAttribute('transform')
  await page.locator('.graph-depth .graph-ctl').last().click() // depth + → relayout
  await expect(node).toHaveAttribute('transform', before ?? '') // pinned ⇒ unmoved

  // Tidy up for the following tests: release the pin and restore depth.
  await page.locator('.graph-ctl', { hasText: 'reset view' }).click()
  await page.locator('.graph-depth .graph-ctl').first().click() // depth −
})

test('layout cycles force → tree → radial; reset view re-fits', async () => {
  await page.locator('.graph-ctl', { hasText: 'layout: force' }).click()
  await expect(page.locator('.graph-ctl', { hasText: 'layout: tree' })).toBeVisible()
  await page.locator('.graph-ctl', { hasText: 'layout: tree' }).click()
  await expect(page.locator('.graph-ctl', { hasText: 'layout: radial' })).toBeVisible()
  await expect(page.locator('.graph-node').first()).toBeVisible()
  await page.locator('.graph-ctl', { hasText: 'reset view' }).click()
  await expect(page.locator('.graph-node').first()).toBeVisible()
})

test('the inspector "Open ↗" leaves the map and opens the note in the editor', async () => {
  await page.locator('.graph-node.is-focus').click() // the focus node is always a real note
  await page.locator('.graph-ctl', { hasText: 'Open ↗' }).click()
  await expect(page.locator('.graph-view')).toHaveCount(0) // map closed
  await expect(page.locator('.cm-content')).toBeVisible()
})
