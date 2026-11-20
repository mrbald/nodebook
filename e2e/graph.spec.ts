import { test, expect, launchElectron, closeElectron } from './electron'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// The knowledge-map MVP: open a note's local graph, see its links as nodes/edges,
// click a neighbour to navigate.
const projectRoot = resolve(__dirname, '..')
const fixtureVault = join(__dirname, 'fixtures', 'vault')
const forceLongTitle = 'An unusually long Force atlas title that the overview can reveal in full on demand'
const forceLeaves = [forceLongTitle, ...Array.from({ length: 100 }, (_, i) => `Point ${String(i).padStart(3, '0')}`)]
const forceTail = 'Atlas Tail'

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
  writeFileSync(join(vaultDir, 'Source example.md'), '---\nkind: document\n---\n# Source example\n')
  writeFileSync(join(vaultDir, 'Extracted point.md'), '# Extracted point\n\nsource:: [[Source example]]\n')
  mkdirSync(join(vaultDir, 'force-atlas'))
  for (const title of forceLeaves) {
    const link = title === forceLongTitle ? `\n[[${forceTail}]]\n` : ''
    writeFileSync(join(vaultDir, 'force-atlas', `${title}.md`), `# ${title}\n${link}`)
  }
  writeFileSync(join(vaultDir, 'force-atlas', `${forceTail}.md`), `# ${forceTail}\n`)
  writeFileSync(join(vaultDir, 'Force Atlas.md'), '# Force Atlas\n\n' + forceLeaves.map((title) => `[[${title}]]`).join('\n'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'nodebook-graph-userdata-'))
  app = await launchElectron({
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
  await closeElectron(app)
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

test('map scope shows the current slice and offers depth only for a local map', async () => {
  const scope = page.getByTitle('Map scope')
  const local = page.getByRole('menuitemradio', { name: 'Local', exact: true })
  const wholeVault = page.getByRole('menuitemradio', { name: 'Whole vault', exact: true })
  const distant = page.getByRole('group', { name: 'Knowledge map notes' })
    .getByRole('button', { name: 'Routing Lab', exact: true })
  await expect(scope).toContainText('Scope: Local')
  await expect(distant).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0)
  await scope.press('Enter')
  await expect(local).toHaveAttribute('aria-checked', 'true')
  await expect(wholeVault).toHaveAttribute('aria-checked', 'false')
  await local.press('ArrowDown')
  await expect(wholeVault).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(scope).toBeFocused()
  await expect(scope).toContainText('Scope: Whole vault')
  await expect(page.locator('.graph-insp-title')).toContainText(/whole vault/i)
  await expect(distant).toBeVisible()
  await expect(page.getByRole('button', { name: 'Increase depth' })).toHaveCount(0)

  await scope.click()
  await expect(wholeVault).toHaveAttribute('aria-checked', 'true')
  await local.click()
  await expect(page.locator('.graph-insp-title')).toContainText('welcome')
  await expect(distant).toHaveCount(0)

  await expect(page.locator('.graph-depth')).toContainText('Depth 1')
  await page.getByRole('button', { name: 'Increase depth' }).click()
  await expect(page.locator('.graph-depth')).toContainText('Depth 2')
  await page.getByRole('button', { name: 'Decrease depth' }).click()
  await expect(page.locator('.graph-depth')).toContainText('Depth 1')
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
  await expect(page.locator('.graph-node')).toHaveCount(before - 1)

  await page.locator('.graph-ctl', { hasText: 'show all' }).click()
  await expect(page.locator('.graph-node')).toHaveCount(before)
})

test('colour dropdown switches to folder and the legend shows folders', async () => {
  const colour = page.getByTitle('Colour the dots by…')
  await colour.click()
  await page.getByRole('menuitemradio', { name: 'Folder', exact: true }).click()
  await expect(colour).toHaveAccessibleName('Colour: Folder')
  await expect(page.locator('.graph-legend-item', { hasText: '(root)' })).toBeVisible()
})

test('pinning a node anchors it in place across a relayout', async () => {
  const node = page.locator('.graph-node', { hasText: 'Graph Model' })
  await node.click() // select
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(page.locator('.graph-node.is-pinned')).toHaveText(/Graph Model/)

  const before = await node.getAttribute('transform')
  await page.getByRole('button', { name: 'Increase depth' }).click()
  await expect(node).toHaveAttribute('transform', before ?? '') // pinned ⇒ unmoved

  // Tidy up for the following tests: release the pin and restore depth.
  await page.getByRole('button', { name: 'Clear placements' }).click()
  await page.getByRole('button', { name: 'Decrease depth' }).click()
})

test('layout dropdown picks Tree, Routed (ELK), Groups and Blocks', async () => {
  const layout = page.getByTitle('Map layout')
  await expect(layout).toHaveAccessibleName('Layout: Force')

  await pickLayout('Tree')
  await expect(layout).toHaveAccessibleName('Layout: Tree')

  await pickLayout('Routed (ELK)')
  await expect(layout).toHaveAccessibleName('Layout: Routed (ELK)')
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout', 'routed')
  await expect(page.locator('path.graph-edge[data-automatic="true"]')).not.toHaveCount(0)

  await pickLayout('Groups')
  await expect(layout).toHaveAccessibleName('Layout: Groups')
  await expect(page.locator('.graph-node').first()).toBeVisible()

  await pickLayout('Blocks')
  await expect(layout).toHaveAccessibleName('Layout: Blocks')
  await expect(page.locator('.graph-node').first()).toBeVisible()

  await page.getByRole('button', { name: 'Fit view' }).click()
  await expect(page.getByRole('button', { name: 'Clear placements' })).toHaveCount(0)
  await expect(page.locator('.graph-node').first()).toBeVisible()
  await pickLayout('Force')
})

test('the inspector "Open ↗" leaves the map and opens the note in the editor', async () => {
  await page.locator('.graph-node.is-focus').click() // the focus node is always a real note
  await page.locator('.graph-ctl', { hasText: 'Open ↗' }).click()
  await expect(page.locator('.graph-view')).toBeHidden() // reader keeps a way back
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
  await page.getByTitle('Map scope').click()
  await page.getByRole('menuitemradio', { name: 'Whole vault', exact: true }).click()
  await expect(page.locator('.graph-node', { hasText: 'Twin' })).toHaveCount(2)
  await expect(page.locator('.graph-insp-note')).toContainText(
    'could point to more than one note'
  )
})

async function pickLayout(name: 'Force' | 'Tree' | 'Routed (ELK)' | 'Radial' | 'Groups' | 'Blocks') {
  await page.getByTitle('Map layout').click()
  await page.getByRole('menuitemradio', { name, exact: true }).click()
}

async function openRoutingLab(mode: Parameters<typeof pickLayout>[0] = 'Routed (ELK)') {
  const close = page.locator('.graph-close')
  if (await close.isVisible()) await close.click()
  await page.locator('.tree-file', { hasText: 'Routing Lab' }).click()
  await page.locator('.graph-open-btn').click()
  await pickLayout(mode)
}

test('Force expansion preserves a dragged mark, the camera and its attached edges', async () => {
  await openRoutingLab('Force')
  const canvas = page.locator('.graph-canvas[data-layout="force"]')
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const tail = canvas.getByRole('button', { name: 'Routing Tail', exact: true })
  await expect(tail).toHaveCount(0)
  const before = await branch.getAttribute('transform')
  const hit = branch.locator('.graph-force-hit')
  const box = (await hit.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const viewport = (await canvas.boundingBox())!
  const dx = x < viewport.x + viewport.width / 2 ? 24 : -24
  const dy = y < viewport.y + viewport.height / 2 ? 24 : -24
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 3 })
  await page.mouse.up()
  await expect(branch).not.toHaveAttribute('transform', before!)
  const moved = await branch.getAttribute('transform')
  const camera = canvas.locator('g').first()
  const view = await camera.getAttribute('transform')

  await hit.click()
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  await expect(tail).toBeVisible()
  await expect(branch).toHaveAttribute('transform', moved!)
  await expect(camera).toHaveAttribute('transform', view!)
  const attached = await canvas.locator('line.graph-edge').evaluateAll((edges, id) =>
    edges.filter((edge) => JSON.parse(edge.getAttribute('data-edge-key')!).includes(id)).every((edge) => {
      const [source] = JSON.parse(edge.getAttribute('data-edge-key')!)
      const endpoint = source === id ? '1' : '2'
      const node = edge.ownerSVGElement!.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id!)}"]`)!
      const matrix = node.transform.baseVal.consolidate()!.matrix
      return Math.abs(matrix.e - Number(edge.getAttribute(`x${endpoint}`))) < 0.001 &&
        Math.abs(matrix.f - Number(edge.getAttribute(`y${endpoint}`))) < 0.001
    }), await branch.getAttribute('data-node-id'))
  expect(attached).toBe(true)

  await page.getByRole('button', { name: 'Collapse', exact: true }).click()
  await expect(tail).toHaveCount(0)
  await expect(branch).toHaveAttribute('transform', moved!)
})

test('routed links stay attached through drag, pin, fit and clearing placements', async () => {
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
  await page.getByRole('button', { name: 'Increase depth' }).click()
  await expect(canvas.getByRole('button', { name: 'Routing Tail' })).toBeVisible()
  await expect(lab).toHaveAttribute('class', /is-pinned/)
  // The centre stays pinned. Fitting the larger scene may scale the box.
  expect((await lab.getAttribute('transform'))!.split(' scale')[0]).toBe(moved!.split(' scale')[0])
  const fit = page.getByRole('button', { name: 'Fit view' })
  await fit.click()
  await expect(lab).toHaveAttribute('class', /is-pinned/)
  await expect(canvas).toHaveAttribute('data-layout', 'manual')
  const clear = page.getByRole('button', { name: 'Clear placements' })
  await clear.press('Enter')
  await expect(fit).toBeFocused()
  await expect(clear).toHaveCount(0)
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
  await expect(canvas).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText(title!)
})

test('dense Force fits the canvas and keeps lightweight, interactive marks through zoom and reset', async () => {
  const close = page.locator('.graph-close')
  if (await close.isVisible()) await close.click()
  await page.locator('.tree-file').filter({ hasText: /^Force Atlas$/ }).click()
  const worker = await page.evaluateHandle(() => {
    const send = Worker.prototype.postMessage
    const state = { requests: 0, replies: 0, holdNext: false, release: null as (() => void) | null }
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if (Array.isArray(args[0])) {
        state.requests++
        this.addEventListener('message', (event) => {
          if (event.data instanceof Map) state.replies++
        })
        if (state.holdNext) {
          state.holdNext = false
          state.release = () => { Reflect.apply(send, this, args) }
          return
        }
      }
      Reflect.apply(send, this, args)
    }
    return { state, restore: () => { Worker.prototype.postMessage = send } }
  })

  const canvas = page.locator('.graph-canvas[data-layout="force"]')
  const marks = canvas.locator('.graph-force-dot')
  const labels = canvas.locator('.graph-force-label')
  const edges = canvas.locator('.graph-edge')
  const node = canvas.getByRole('button', { name: forceLongTitle, exact: true })
  const dot = node.locator('.graph-force-dot')
  const hit = node.locator('.graph-force-hit')
  try {
    await page.locator('.graph-open-btn').click()
    await pickLayout('Force')
    await expect(marks).toHaveCount(forceLeaves.length + 1)
    await expect(canvas.locator('.is-ghost')).toHaveCount(0)
    await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
    const settledWorker = await worker.evaluate(({ state }) => ({ ...state }))
    expect(settledWorker.replies).toBeGreaterThan(0)
    await expect.poll(() => labels.count()).toBeGreaterThan(0)
    expect(await labels.count()).toBeLessThan(forceLeaves.length / 4)
    await expect(edges.first()).toHaveCSS('stroke-width', '0.75px')
    await expect(edges.first()).toHaveCSS('opacity', '0.26')
    const viewport = (await canvas.boundingBox())!
    const fit = await marks.evaluateAll((glyphs) => glyphs.map((glyph) => {
      const { x, y, width, height } = glyph.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }))
    for (const p of fit) {
      expect(p.x - viewport.x).toBeGreaterThan(20)
      expect(p.y - viewport.y).toBeGreaterThan(20)
      expect(viewport.x + viewport.width - p.x).toBeGreaterThan(20)
      expect(viewport.y + viewport.height - p.y).toBeGreaterThan(20)
    }

    const nodeId = await node.getAttribute('data-node-id')
    const caption = labels.filter({ hasText: forceLongTitle })
    const nodeGeometry = await node.getAttribute('transform')
    const camera = canvas.locator('g').first()
    const startView = await camera.getAttribute('transform')
    const dotBox = (await dot.boundingBox())!
    const hitBox = (await hit.boundingBox())!
    expect(dotBox.width).toBeLessThan(12)
    expect(hitBox.width).toBeCloseTo(22)
    await expect(caption).toHaveCount(0)
    // Click outside the visible dot, but inside its transparent hit target.
    await hit.hover({ position: { x: 11, y: 18 } })
    await expect(caption).toHaveText(forceLongTitle)
    await expect(canvas.locator('.graph-edge.is-incident')).toHaveCount(1)
    await hit.click({ position: { x: 11, y: 18 } })
    await expect(node).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.graph-insp-title')).toContainText(forceLongTitle)

    const selectedBox = (await dot.boundingBox())!
    await page.mouse.move(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2)
    await page.mouse.wheel(0, -120)
    await expect(camera).not.toHaveAttribute('transform', startView!)
    await expect(node).toHaveAttribute('transform', nodeGeometry!)
    expect((await dot.boundingBox())!.width).toBeCloseTo(selectedBox.width)
    expect(await worker.evaluate(({ state }) => state.requests)).toBe(settledWorker.requests)
    await expect(caption).toHaveAttribute('data-label-id', nodeId!)

    await page.getByRole('button', { name: 'Fit view' }).click()
    await expect(marks).toHaveCount(forceLeaves.length + 1)
    await expect(camera).toHaveAttribute('transform', startView!)
    expect(await worker.evaluate(({ state }) => state.requests)).toBe(settledWorker.requests)
    await expect(node).toHaveAttribute('transform', nodeGeometry!)
    const reset = (await dot.boundingBox())!
    expect(reset.x).toBeCloseTo(selectedBox.x)
    expect(reset.y).toBeCloseTo(selectedBox.y)

    await page.getByRole('button', { name: 'Deselect' }).click()
    await expect(caption).toHaveCount(0)
    await page.keyboard.press('Tab')
    await node.focus()
    await expect(node).toBeFocused()
    await expect(caption).toHaveText(forceLongTitle)
    await expect(canvas.locator('.graph-edge.is-incident')).toHaveCount(1)

    await page.keyboard.press('Space')
    await worker.evaluate(({ state }) => { state.holdNext = true })
    await page.getByRole('button', { name: 'Expand', exact: true }).click()
    await expect.poll(() => worker.evaluate(({ state }) => state.release !== null)).toBe(true)
    await expect(page.getByRole('status').filter({ hasText: 'Updating map…' })).toBeVisible()
    const nodes = canvas.locator('.graph-node')
    await expect(nodes).toHaveCount(forceLeaves.length + 1)
    await nodes.last().focus()
    await page.keyboard.press('ArrowRight')
    await expect(nodes.first()).toBeFocused()
    await expect(canvas.locator('.graph-node[tabindex="0"]')).toHaveCount(1)

    await worker.evaluate(({ state }) => state.release?.())
    await expect(canvas.getByRole('button', { name: forceTail, exact: true })).toHaveCount(1)
  } finally {
    await worker.evaluate((value) => value.restore())
    await worker.dispose()
  }
})

test('Source shows and hides the document while retaining the toggle and its focus', async () => {
  const close = page.locator('.graph-close')
  if (await close.isVisible()) await close.click()
  await page.getByRole('button', { name: 'Extracted point', exact: true }).click()
  await page.locator('.graph-open-btn').click()
  const toggle = page.getByRole('button', { name: 'Source', exact: true })
  const canvas = page.getByRole('group', { name: 'Knowledge map notes' })
  const document = canvas.getByRole('button', { name: 'Source example', exact: true })
  await expect(toggle).toHaveText('Source: off')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(document).toHaveCount(0)

  await toggle.press('Enter')
  await expect(document).toBeVisible()
  await expect(toggle).toHaveText('Source: on')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(document).toHaveCount(0)
  await expect(toggle).toHaveText('Source: off')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toBeFocused()
  await close.click()
})

test('a searched note opens on its local map and reading preserves the pinned note, zoom and focus', async () => {
  await page.getByRole('button', { name: 'Whole vault map', exact: true }).click()
  await expect(page.locator('.graph-scope:visible')).toContainText('Whole vault')
  await page.getByRole('textbox', { name: 'Search notes' }).fill('claim')
  await page.getByRole('button', { name: 'Show Welcome to Nodebook on map' }).click()
  const canvas = page.locator('.graph-canvas:visible')
  const note = canvas.getByRole('button', { name: 'welcome', exact: true })
  await expect(note).toHaveClass(/is-focus/)
  await pickLayout('Force')
  await note.press('Space')
  await expect(page.locator('.graph-insp-excerpt:visible')).toContainText('claim')
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  const position = await note.getAttribute('transform')
  await note.press('+')
  const camera = () => note.evaluate((node) => node.parentElement!.getAttribute('transform'))
  const zoom = await camera()
  await note.press('Enter')
  await expect(page.locator('.cm-content')).toContainText('claim')
  await page.getByRole('button', { name: '← Back to map' }).click()
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  expect(await camera()).toBe(zoom)
  await page.getByRole('button', { name: 'Fit view', exact: true }).click()
  await expect(note).toHaveClass(/is-pinned/)
  await expect(note).toHaveAttribute('transform', position!)
  expect(await camera()).not.toBe(zoom)
  await page.getByRole('textbox', { name: 'Search notes' }).fill('')
})

async function connectorPoints(edge: Locator, offset = 0) {
  return edge.evaluate((element, offset) => {
    const geometry = element as SVGGeometryElement
    const svg = geometry.ownerSVGElement!
    const matrix = geometry.getScreenCTM()!
    const length = geometry.getTotalLength()
    // Sample the actual curve/line in CSS pixels. Skip note hit targets and
    // clipped segments, including when the far endpoint is beyond the canvas.
    return [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0.05, 0.95].flatMap((fraction) => {
      const along = length * fraction
      const p = geometry.getPointAtLength(along).matrixTransform(matrix)
      const next = geometry.getPointAtLength(Math.min(length, along + 1)).matrixTransform(matrix)
      const vx = next.x - p.x
      const vy = next.y - p.y
      const magnitude = Math.hypot(vx, vy)
      if (!magnitude) return []
      const x = p.x - vy / magnitude * offset
      const y = p.y + vx / magnitude * offset
      const hit = document.elementFromPoint(x, y)
      return svg.contains(hit) && !hit?.closest('.graph-node') ? [{ x, y }] : []
    })
  }, offset)
}

async function connectorPoint(edge: Locator, offset = 0) {
  const [point] = await connectorPoints(edge, offset)
  if (!point) throw new Error('The connector has no unoccluded segment in the viewport')
  return point
}

async function nodeCenter(node: Locator) {
  return node.evaluate((element) => {
    const p = new DOMPoint().matrixTransform((element as SVGGElement).getScreenCTM()!)
    return { x: p.x, y: p.y }
  })
}

async function cameraPosition(node: Locator) {
  return node.evaluate((element) => {
    const matrix = (element.parentNode as SVGGElement).transform.baseVal.consolidate()!.matrix
    return { x: matrix.e, y: matrix.f, scale: matrix.a }
  })
}

const layoutCases = [
  ['Force', 'force'], ['Routed (ELK)', 'routed'], ['Tree', 'tree'],
  ['Radial', 'radial'], ['Groups', 'groups'], ['Blocks', 'blocks']
] as const

for (const [mode, layout] of layoutCases) {
  test(`${mode} traces an incident connector and follows its endpoint without refocusing`, async () => {
    await openRoutingLab(mode)
    const canvas = page.locator(`.graph-canvas[data-layout="${layout}"]`)
    await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
    const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
    const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
    const edge = canvas.locator('.graph-edge[data-edge-key*="defines"]')
    const preview = page.locator('.graph-edge-preview')
    const trace = canvas.locator('[data-trace-edge-key*="defines"]')
    await expect(edge).toHaveCount(1)

    // Hovering an unselected map should still keep its calm overview.
    const p = await connectorPoint(edge, 4)
    await page.mouse.move(p.x, p.y)
    await expect(preview).toHaveCount(0)
    await expect(canvas.locator('.graph-edge.is-incident')).toHaveCount(0)
    const stroke = () => edge.evaluate((shape) => getComputedStyle(shape).stroke)
    const quiet = await stroke()
    const labPoint = await nodeCenter(lab)
    await page.mouse.move(labPoint.x, labPoint.y)
    await expect(lab).toHaveAttribute('aria-pressed', 'false')
    await expect(edge).toHaveClass(/is-incident/)
    await expect.poll(stroke).not.toBe(quiet)
    await page.mouse.move(p.x, p.y)
    await expect(edge).not.toHaveClass(/is-incident/)
    await page.keyboard.press('Tab')
    await lab.focus()
    await expect(lab).toBeFocused()
    await expect(edge).toHaveClass(/is-incident/)
    await lab.press('Space')
    const before = await cameraPosition(lab)
    await page.mouse.move(p.x + 1, p.y)
    await expect(preview).toContainText('Outgoing defines')
    if (mode === 'Force') await expect(preview).toContainText('supports')
    const destination = preview.getByRole('button', { name: 'Inspect Routing Branch on the map', exact: true })
    await expect(destination).toHaveCount(1)
    await expect(trace).toHaveCSS('stroke-width', '3px')
    await expect(lab).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.graph-insp-title')).toContainText('Routing Lab')
    expect(await cameraPosition(lab)).toEqual(before)

    await page.mouse.click(p.x, p.y)
    const chooser = page.getByRole('group', { name: 'Choose a linked note', exact: true })
    if (await chooser.isVisible()) {
      await expect(lab).toHaveAttribute('aria-pressed', 'true')
      await chooser.getByRole('button', { name: 'Inspect Routing Branch on the map', exact: true }).click()
    }
    await expect(branch).toHaveAttribute('aria-pressed', 'true')
    await expect(branch).toBeFocused()
    await expect(branch).toHaveCSS('outline-style', 'none')
    await expect(lab).toHaveClass(/is-focus/)
    await expect(page.locator('.graph-insp-title')).toContainText('Routing Branch')
    expect(await cameraPosition(lab)).toEqual(before)

    // Pan begins normally even when pointer-down lands on an active connector.
    const start = await connectorPoint(edge)
    const labBeforeDrag = await nodeCenter(lab)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 32, start.y + 18, { steps: 4 })
    await page.mouse.up()
    const dragged = await cameraPosition(lab)
    const labAfterDrag = await nodeCenter(lab)
    expect(labAfterDrag.x).toBeCloseTo(labBeforeDrag.x + 32, 0)
    expect(labAfterDrag.y).toBeCloseTo(labBeforeDrag.y + 18, 0)
    expect(dragged.scale).toBe(before.scale)
    await expect(branch).toHaveAttribute('aria-pressed', 'true')
  })
}

for (const [mode, layout] of layoutCases.filter(([, layout]) => layout !== 'force')) {
  test(`${mode} budgets labels in a dense overview and reveals titles on keyboard focus`, async () => {
    const close = page.locator('.graph-close')
    if (await close.isVisible()) await close.click()
    await page.locator('.tree-file').filter({ hasText: /^Force Atlas$/ }).click()
    await page.locator('.graph-open-btn').click()
    await pickLayout(mode)
    const canvas = page.locator(`.graph-canvas[data-layout="${layout}"]`)
    const note = canvas.getByRole('button', { name: forceLongTitle, exact: true })
    const labels = canvas.locator('.graph-screen-label')
    await expect(canvas.locator('.graph-node')).toHaveCount(forceLeaves.length + 1)
    await expect.poll(() => labels.count()).toBeGreaterThan(0)
    expect(await labels.count()).toBeLessThan(forceLeaves.length / 3)
    await expect(canvas.locator('.graph-edge.is-incident')).toHaveCount(0)
    if (layout !== 'routed') {
      await expect(canvas.locator('.graph-point-dot')).toHaveCount(forceLeaves.length + 1)
      await expect(canvas.locator('.graph-point-hit')).toHaveCount(forceLeaves.length + 1)
    }

    const id = await note.getAttribute('data-node-id')
    const title = labels.filter({ hasText: forceLongTitle })
    await page.keyboard.press('Tab')
    await note.focus()
    await expect(note).toBeFocused()
    await expect(title).toHaveAttribute('data-label-id', id!)
    await expect(title).toHaveClass(/is-active/)
    const before = await cameraPosition(note)
    const position = await note.getAttribute('transform')
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeVisible()
    await note.press('+')
    const after = await cameraPosition(note)
    expect(after.scale).toBeGreaterThan(before.scale)
    await expect(note).toHaveAttribute('transform', position!)
    await expect(note).toBeFocused()
    await note.press('Space')
    await expect(note).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.graph-insp-title')).toContainText(forceLongTitle)
  })
}

test('inspector links trace the specific relation on hover and focus, then follow by keyboard or mouse', async () => {
  await openRoutingLab()
  const canvas = page.locator('.graph-canvas[data-layout="routed"]')
  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const row = (relation: string) => page.locator(`[data-inspector-edge-key*="${relation}"]`)
  const trace = canvas.locator('[data-trace-edge-key]')
  await lab.press('Space')
  const before = await cameraPosition(lab)
  await row('defines').getByRole('button', { name: 'Routing Branch', exact: true }).hover()
  await expect(trace).toHaveCount(1)
  await expect(trace).toHaveAttribute('data-trace-edge-key', /defines/)
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  expect(await cameraPosition(lab)).toEqual(before)

  const supports = row('supports').getByRole('button', { name: 'Routing Branch', exact: true })
  await page.keyboard.press('Tab')
  await supports.focus()
  await expect(supports).toBeFocused()
  await expect(trace).toHaveAttribute('data-trace-edge-key', /supports/)
  expect(await cameraPosition(lab)).toEqual(before)
  await page.keyboard.press('Enter')
  await expect(branch).toHaveAttribute('aria-pressed', 'true')
  await expect(branch).toBeFocused()
  await expect(lab).toHaveClass(/is-focus/)

  await row('defines').getByRole('button', { name: 'Routing Lab', exact: true }).click()
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  expect(await cameraPosition(lab)).toEqual(before)
})

test('following a visible Force stroke pans an offscreen endpoint into view without zooming or centering', async () => {
  await openRoutingLab('Force')
  const canvas = page.locator('.graph-canvas[data-layout="force"]')
  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const edge = canvas.locator('.graph-edge[data-edge-key*="defines"]')
  await expect(edge).toHaveCount(1)
  await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
  await lab.press('Space')
  const bounds = (await canvas.boundingBox())!
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const offscreen = ({ x, y }: { x: number; y: number }) =>
    x < bounds.x || x > right || y < bounds.y || y > bottom
  for (let step = 0; step < 20 && !offscreen(await nodeCenter(branch)); step++) {
    await page.keyboard.press('+')
  }
  const outside = await nodeCenter(branch)
  expect(offscreen(outside)).toBe(true)
  const before = await cameraPosition(lab)
  const hit = await connectorPoint(edge)
  await page.mouse.move(hit.x, hit.y)
  await expect(page.locator('.graph-edge-preview[data-offscreen]')).toBeVisible()
  expect(await cameraPosition(lab)).toEqual(before)
  await page.mouse.click(hit.x, hit.y)
  await expect(branch).toHaveAttribute('aria-pressed', 'true')
  await expect(lab).toHaveClass(/is-focus/)
  const after = await cameraPosition(lab)
  const inside = await nodeCenter(branch)
  expect(after.scale).toBe(before.scale)
  expect(offscreen(inside)).toBe(false)
  // The destination lands inside the nearest viewport edge.
  if (outside.x < bounds.x) expect(inside.x - bounds.x).toBeLessThan(60)
  if (outside.x > right) expect(right - inside.x).toBeLessThan(60)
  if (outside.y < bounds.y) expect(inside.y - bounds.y).toBeLessThan(60)
  if (outside.y > bottom) expect(bottom - inside.y).toBeLessThan(60)
  if (outside.x > bounds.x + 30 && outside.x < right - 30) expect(after.x).toBe(before.x)
  if (outside.y > bounds.y + 30 && outside.y < bottom - 30) expect(after.y).toBe(before.y)
  await page.getByRole('button', { name: 'Back to previous note' }).press('Enter')
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  await expect(lab).toBeFocused()
  expect(await cameraPosition(lab)).toEqual(before)
})

test('overlapping connectors to different destinations let the reader choose', async () => {
  await openRoutingLab('Force')
  const canvas = page.locator('.graph-canvas[data-layout="force"]')
  await expect(canvas).not.toHaveAttribute('aria-busy', 'true')
  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const check = canvas.getByRole('button', { name: 'Routing Check', exact: true })
  const bounds = (await canvas.boundingBox())!
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const place = async (node: Locator, x: number, y: number) => {
    const previous = await nodeCenter(node)
    await page.mouse.move(previous.x, previous.y)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => {
      const actual = await nodeCenter(node)
      return Math.hypot(actual.x - x, actual.y - y)
    }).toBeLessThan(2)
  }
  const y = Math.round(center.y)
  // Two collinear spokes produce a deterministic ambiguous point away from notes.
  await place(lab, Math.round(center.x - 130), y)
  await place(branch, Math.round(center.x + 20), y)
  await place(check, Math.round(center.x + 120), y)
  await lab.press('Space')
  const before = await cameraPosition(lab)
  const point = { x: Math.round(center.x - 55), y }
  const preview = page.locator('.graph-edge-preview')
  const inspectBranch = preview.getByRole('button', { name: 'Inspect Routing Branch on the map' })
  const inspectCheck = preview.getByRole('button', { name: 'Inspect Routing Check on the map' })
  await page.mouse.move(point.x, point.y)
  await expect(inspectBranch).toBeVisible()
  await expect(inspectCheck).toBeVisible()
  await page.mouse.click(point.x, point.y)
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  expect(await cameraPosition(lab)).toEqual(before)
  await inspectCheck.click()
  await expect(check).toHaveAttribute('aria-pressed', 'true')
  await expect(lab).toHaveClass(/is-focus/)
  expect(await cameraPosition(lab)).toEqual(before)

  // Make the same two destinations offscreen. Rim indicators must not insert a
  // second keyboard stop for a destination already offered by the chooser.
  const back = page.getByRole('button', { name: 'Back to previous note' })
  await back.press('Enter')
  const right = bounds.x + bounds.width
  for (let step = 0; step < 20 && (await nodeCenter(branch)).x <= right; step++) {
    await page.keyboard.press('+')
  }
  expect((await nodeCenter(branch)).x).toBeGreaterThan(right)
  expect((await nodeCenter(check)).x).toBeGreaterThan(right)
  const clippedView = await cameraPosition(lab)
  await page.mouse.click(point.x, point.y)
  const chooser = page.getByRole('group', { name: 'Choose a linked note', exact: true })
  const options = chooser.getByRole('button')
  await expect(options).toHaveCount(2)
  await expect(options.first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(options.last()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(chooser).toHaveCount(0)
  await expect(preview.locator('[data-edge-preview-target]:focus')).toHaveCount(0)
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  expect(await cameraPosition(lab)).toEqual(clippedView)
})

async function followRimAcrossCanvas(overNode: boolean) {
  await openRoutingLab()
  const canvas = page.locator('.graph-canvas[data-layout="routed"]')
  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const edges = canvas.locator('path.graph-edge[data-edge-key*="Routing Lab.md"][data-edge-key*="Routing Branch.md"]')
  await expect(edges).toHaveCount(3)
  await lab.press('Space')
  const bounds = (await canvas.boundingBox())!
  const clipped = ({ x, y }: { x: number; y: number }) =>
    x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height
  for (let step = 0; step < 20 && !clipped(await nodeCenter(branch)); step++) {
    await page.keyboard.press('+')
  }
  expect(clipped(await nodeCenter(branch))).toBe(true)
  const view = await cameraPosition(lab)
  const rim = page.locator('.graph-edge-preview[data-offscreen]')
    .getByRole('button', { name: 'Inspect Routing Branch on the map', exact: true })
  const approach = async () => {
    const candidates = overNode ? [edges.and(canvas.locator('[data-edge-key*="supports"]'))] : await edges.all()
    for (const edge of candidates) {
      if (!/L.*L/.test((await edge.getAttribute('d'))!)) continue
      for (const point of await connectorPoints(edge)) {
        await page.mouse.move(point.x, point.y)
        if (!(await rim.isVisible())) continue
        const box = (await rim.boundingBox())!
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        const steps = Math.ceil(Math.hypot(x - point.x, y - point.y) / 5)
        if (steps < 7) continue
        const crossesNote = await page.evaluate(({ point, x, y, steps }) => {
          for (let step = 1; step <= steps; step++) {
            if (document.elementFromPoint(point.x + (x - point.x) * step / steps,
              point.y + (y - point.y) * step / steps)?.closest('.graph-node')) return true
          }
          return false
        }, { point, x, y, steps })
        if (crossesNote === overNode) return { x, y, steps }
      }
    }
    throw new Error(`No bent connector approaches the rim ${overNode ? 'across a note' : 'through open canvas'}`)
  }
  const { x, y, steps } = await approach()
  await page.mouse.move(x, y, { steps })
  await expect(rim).toBeVisible()
  await expect(lab).toHaveAttribute('aria-pressed', 'true')
  expect(await cameraPosition(lab)).toEqual(view)
  await rim.click()
  await expect(branch).toHaveAttribute('aria-pressed', 'true')
  expect((await cameraPosition(lab)).scale).toBe(view.scale)
}

test('the Routed rim action remains reachable across open canvas', async () => {
  await followRimAcrossCanvas(false)
})

test('the Routed rim action remains reachable when the pointer briefly crosses a note', async () => {
  await followRimAcrossCanvas(true)
})

test('following reveals a clipped ELK card that nearly fills the canvas width', async () => {
  await openRoutingLab()
  const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const canvas = page.locator('.graph-canvas[data-layout="routed"]')
  const lab = canvas.getByRole('button', { name: 'Routing Lab', exact: true })
  const branch = canvas.getByRole('button', { name: 'Routing Branch', exact: true })
  const card = branch.locator('.graph-note-box')
  await lab.press('Space')
  try {
    const originalCanvas = (await canvas.boundingBox())!
    for (let step = 0; step < 26 && (await card.boundingBox())!.width < originalCanvas.width * 0.65; step++) {
      await page.keyboard.press('+')
    }
    const width = (await card.boundingBox())!.width
    expect(width).toBeGreaterThan(originalCanvas.width * 0.6)
    await page.setViewportSize({ width: Math.round(originalSize.width - originalCanvas.width + width + 12), height: originalSize.height })
    await expect.poll(async () => {
      const bounds = (await canvas.boundingBox())!
      const spare = bounds.width - (await card.boundingBox())!.width
      return spare > 0 && spare < 24
    }).toBe(true)
    const bounds = (await canvas.boundingBox())!
    const outside = (await card.boundingBox())!
    expect(bounds.width - outside.width).toBeLessThan(24)
    expect(outside.x < bounds.x || outside.x + outside.width > bounds.x + bounds.width).toBe(true)
    const before = await cameraPosition(lab)
    await page.locator('[data-inspector-edge-key*="defines"]')
      .getByRole('button', { name: 'Routing Branch', exact: true }).click()
    await expect(branch).toHaveAttribute('aria-pressed', 'true')
    const inside = (await card.boundingBox())!
    expect(inside.x).toBeGreaterThanOrEqual(bounds.x - 1)
    expect(inside.x + inside.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
    expect((await cameraPosition(lab)).scale).toBe(before.scale)
  } finally {
    await page.setViewportSize(originalSize)
  }
})
