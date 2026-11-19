import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
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
  // Two different notes called "Twin", one per folder, each linked from its own
  // folder — identity is the path, so the map must draw two dots, not one.
  mkdirSync(join(vaultDir, 'left'))
  mkdirSync(join(vaultDir, 'right'))
  writeFileSync(join(vaultDir, 'left', 'Twin.md'), '# Twin\n\nThe left one.\n')
  writeFileSync(join(vaultDir, 'right', 'Twin.md'), '# Twin\n\nThe right one.\n')
  writeFileSync(join(vaultDir, 'left', 'Leftward.md'), '# Leftward\n\nSee [[Twin]].\n')
  writeFileSync(join(vaultDir, 'right', 'Rightward.md'), '# Rightward\n\nSee [[Twin]].\n')
  writeFileSync(join(vaultDir, 'Routing Lab.md'), [
    '# Routing Lab', '', 'defines:: [[Routing Branch]]', 'supports:: [[Routing Branch]]',
    'checks:: [[Routing Check]]'
  ].join('\n'))
  writeFileSync(join(vaultDir, 'Routing Branch.md'), '# Routing Branch\n\n[[Routing Lab]] · [[Routing Tail]]\n')
  writeFileSync(join(vaultDir, 'Routing Check.md'), '# Routing Check\n\n[[Routing Branch]]\n')
  writeFileSync(join(vaultDir, 'Routing Tail.md'), '# Routing Tail\n')
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

test('colour dropdown switches to folder and the legend shows folders', async () => {
  const sel = page.locator('.status-select-colour')
  await sel.locator('.status-btn').click()
  await sel.locator('.status-menu-item', { hasText: 'folder' }).click()
  await expect(sel.locator('.status-btn')).toContainText('folder')
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

test('layout dropdown picks tree / elk / radial / groups / blocks; reset view re-fits', async () => {
  const sel = page.locator('.status-select-layout')
  await expect(sel.locator('.status-btn')).toContainText('force')

  await sel.locator('.status-btn').click()
  await sel.locator('.status-menu-item', { hasText: 'tree' }).click()
  await expect(sel.locator('.status-btn')).toContainText('tree')

  await sel.locator('.status-btn').click()
  await sel.locator('.status-menu-item', { hasText: 'elk' }).click()
  await expect(sel.locator('.status-btn')).toContainText('elk')
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout', 'routed')
  await expect(page.locator('path.graph-edge[data-automatic="true"]')).not.toHaveCount(0)

  await sel.locator('.status-btn').click()
  await sel.locator('.status-menu-item', { hasText: 'groups' }).click()
  await expect(sel.locator('.status-btn')).toContainText('groups')
  await expect(page.locator('.graph-node').first()).toBeVisible()

  await sel.locator('.status-btn').click()
  await sel.locator('.status-menu-item', { hasText: 'blocks' }).click()
  await expect(sel.locator('.status-btn')).toContainText('blocks')
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

test('two notes with one name are two dots, and the panel admits the ambiguity', async () => {
  await page.locator('.tree-file', { hasText: 'Leftward' }).click()
  await page.locator('.graph-open-btn').click()
  await expect(page.locator('.graph-view')).toBeVisible()

  // Local: the link resolves to the Twin in the *linking note's own folder*.
  await expect(page.locator('.graph-node')).toHaveCount(2)
  await page.locator('.graph-node', { hasText: 'Twin' }).click()
  await expect(page.locator('.graph-insp-title')).toContainText('Twin')
  await page.locator('.graph-ctl', { hasText: 'Open ↗' }).click()
  await expect(page.locator('.cm-content')).toContainText('The left one.') // not the right one

  // Global: both Twins are drawn, and the panel says a link could mean either.
  await page.locator('.graph-open-btn').click()
  await page.locator('.graph-ctl', { hasText: 'Global' }).click()
  await expect(page.locator('.graph-node', { hasText: 'Twin' })).toHaveCount(2)
  await expect(page.locator('.graph-insp-note')).toContainText(
    'could point to more than one note'
  )
})

async function openRoutingLab() {
  const close = page.locator('.graph-close')
  if (await close.isVisible()) await close.click()
  await page.locator('.tree-file', { hasText: 'Routing Lab' }).click()
  await page.locator('.graph-open-btn').click()
  const layout = page.locator('.status-select-layout')
  await layout.locator('.status-btn').click()
  await layout.locator('.status-menu-item', { hasText: 'elk' }).click()
}

test('routed links stay distinct and attach to nodes through drag, pin and reset', async () => {
  await openRoutingLab()
  const canvas = page.locator('.graph-canvas')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  const paths = (routes: Element[]) => routes.filter((path) => {
    const [from, , to] = JSON.parse(path.getAttribute('data-edge-key')!)
    return from.endsWith('/Routing Lab.md') && to.endsWith('/Routing Branch.md')
  }).map((path) => path.getAttribute('d'))
  const connectors = page.locator('path.graph-edge')
  const automatic = await connectors.evaluateAll(paths)
  expect(automatic).toHaveLength(2)
  expect(new Set(automatic).size).toBe(2)

  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const before = await lab.getAttribute('transform')
  const box = await lab.locator('.graph-note-box').boundingBox()
  if (!box) throw Error('Routing Lab has no visible box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 74, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await expect(lab).not.toHaveAttribute('transform', before!)
  await expect(canvas).toHaveAttribute('data-layout', 'manual')
  const manual = await connectors.evaluateAll(paths)
  expect(new Set(manual).size).toBe(2)
  expect(manual).not.toEqual(automatic)

  const detached = await connectors.evaluateAll((routes) => routes.filter((path) => {
    const geometry = path as SVGPathElement
    const [from, , to] = JSON.parse(path.getAttribute('data-edge-key')!)
    return [from, to].some((id, i) => {
      const node = path.ownerSVGElement!.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`)!
      const box = node.querySelector<SVGRectElement>('.graph-note-box')!.getBBox()
      const p = geometry.getPointAtLength(i ? geometry.getTotalLength() : 0)
        .matrixTransform(node.transform.baseVal.consolidate()!.matrix.inverse())
      const dx = Math.abs(p.x) - box.width / 2
      const dy = Math.abs(p.y) - box.height / 2
      return Math.abs(Math.max(dx, dy)) > 0.1
    })
  }).length)
  expect(detached).toBe(0)

  await lab.click()
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  const moved = await lab.getAttribute('transform')
  await page.locator('.graph-depth').getByRole('button', { name: '+' }).click()
  await expect(canvas.getByRole('button', { name: 'Routing Tail' })).toBeVisible()
  await expect(lab).toHaveAttribute('class', /is-pinned/)
  // The centre stays pinned. Fitting the larger scene may scale the box.
  expect((await lab.getAttribute('transform'))!.split(' scale')[0]).toBe(moved!.split(' scale')[0])
  await page.getByRole('button', { name: /reset view/i }).click()
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  await expect(canvas.locator('.is-pinned')).toHaveCount(0)
})

test('the latest routed graph follows link filters and supports keyboard inspect and open', async () => {
  await openRoutingLab()
  const canvas = page.locator('.graph-canvas')
  await expect(canvas).toHaveAttribute('data-layout', 'routed')
  const defines = page.locator('.graph-legend-item', { hasText: 'defines' })
  const supports = page.locator('.graph-legend-item', { hasText: 'supports' })
  // Block one layout to ensure that filtering during a live request actually
  // cancels that worker, regardless of machine speed.
  const pause = await page.evaluateHandle(() => {
    const postMessage = Worker.prototype.postMessage
    const terminate = Worker.prototype.terminate
    const state = { paused: null as Worker | null, cancelled: false }
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const [message] = args
      if (!state.paused && (message as { cmd?: string })?.cmd === 'layout') {
        state.paused = this
        return
      }
      Reflect.apply(postMessage, this, args)
    }
    Worker.prototype.terminate = function (this: Worker) {
      if (state.paused === this) state.cancelled = true
      terminate.call(this)
    }
    return {
      state,
      restore() {
        Worker.prototype.postMessage = postMessage
        Worker.prototype.terminate = terminate
      }
    }
  })
  try {
    await defines.click()
    await expect(page.getByText('Arranging map…')).toBeVisible()
    await supports.click()
    await expect(canvas).toHaveAttribute('data-layout', 'routed')
    expect(await pause.evaluate(({ state }) => state.cancelled)).toBe(true)
  } finally {
    await pause.evaluate((paused) => paused.restore())
    await pause.dispose()
  }
  const edgeKeys = (await canvas.locator('path.graph-edge').evaluateAll(
    (edges) => edges.map((e) => e.getAttribute('data-edge-key'))
  )).map((key) => JSON.parse(key!)[1])
  expect(edgeKeys).not.toContain('defines')
  expect(edgeKeys).not.toContain('supports')
  expect(edgeKeys).toContain('checks')

  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  await expect(canvas.locator('.graph-node[tabindex="0"]')).toHaveCount(1)
  await lab.focus()
  await page.keyboard.press('ArrowRight')
  const focused = canvas.locator('.graph-node:focus')
  const title = await focused.getAttribute('aria-label')
  expect(title).not.toBe('Routing Lab')
  await page.keyboard.press('Space')
  await expect(page.locator('.graph-insp-title')).toContainText(title!)
  await expect(focused).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Enter')
  await expect(canvas).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText(title!)
})
