import { describe, expect, it } from 'vitest'
import { fitMapView, placeMapTitles, type MapMarker } from './mapPresentation'

describe('note map presentation', () => {
  it('centres actual coordinates and reserves canvas margins across aspect ratios', () => {
    const points = [{ x: -900, y: 1900 }, { x: 1800, y: -1400 }]
    for (const [width, height] of [[1500, 500], [280, 940]]) {
      const view = fitMapView(points, width, height)
      const a = { x: view.x + points[0].x * view.k, y: view.y + points[0].y * view.k }
      const b = { x: view.x + points[1].x * view.k, y: view.y + points[1].y * view.k }
      expect((a.x + b.x) / 2).toBeCloseTo(width / 2)
      expect((a.y + b.y) / 2).toBeCloseTo(height / 2)
      expect(Math.min(a.x, width - b.x, b.y, height - a.y)).toBeCloseTo(34)
    }
    expect(fitMapView([points[0]], 280, 940)).toEqual({ x: 1040, y: -1430, k: 1 })
  })

  it('centres small routed layouts without enlarging their cards', () => {
    expect(fitMapView([{ x: 300, y: 200 }, { x: 500, y: 350 }], 720, 460, 0.5))
      .toEqual({ x: 160, y: 92.5, k: 0.5 })
  })

  it('places priority full titles ahead of colliding quiet titles', () => {
    const measure = (title: string): number => title.length * 7
    const leader = 'A full title that has to wrap in a narrow graph'
    const titles = [
      { id: 'quiet', title: 'Quiet', width: measure('Quiet') },
      { id: 'active', title: leader, width: measure(leader) }
    ]
    const p = (): MapMarker => ({ x: 100, y: 40, halfWidth: 3, halfHeight: 3 })
    const placed = placeMapTitles(titles, new Set(['active']), p, 200, 140, 1, measure)
    expect(placed).toHaveLength(1)
    expect(placed[0].lines.length).toBeGreaterThan(1)
    expect(placed[0].lines.join(' ')).toBe(leader)
    expect(placed[0]).toMatchObject({ id: 'active', active: true })
  })

  it('tries the remaining sides when the footprint of another glyph blocks a title', () => {
    const positions = new Map([
      ['center', { x: 120, y: 65 }],
      ['below', { x: 120, y: 77 }],
      ['above', { x: 120, y: 53 }],
      ['right', { x: 133, y: 65 }]
    ])
    const titles = [...positions.keys()].map((id) => ({ id, title: 'Title', width: 40 }))
    const marker = (id: string): MapMarker => ({ ...positions.get(id)!, halfWidth: 2.5, halfHeight: 2.5 })
    for (const [count, placement] of [
      [1, { x: 94, y: 70.5 }], [2, { x: 94, y: 41.5 }],
      [3, { x: 125.5, y: 56 }], [4, { x: 62.5, y: 56 }]
    ] as const) {
      const [first] = placeMapTitles(titles.slice(0, count), new Set(), marker, 240, 130, 1, () => 40)
      expect(first).toMatchObject({ id: 'center', ...placement })
    }
  })

  it('keeps an overview title clear of a routed card edge', () => {
    const marker = (): MapMarker => ({ x: 120, y: 65, halfWidth: 25, halfHeight: 12 })
    const titles = [{ id: 'card', title: 'Title', width: 40 }]
    const [placed] = placeMapTitles(titles, new Set(['card']), marker, 240, 130, 1, () => 40)
    expect(placed).toMatchObject({ x: 94, y: 80, active: true })
  })

  it('reveals more labels as the user zooms, with deterministic priority', () => {
    const measure = (title: string): number => title.length * 7
    const titles = Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: 'Title', width: 35 }))
    const position = (id: string): MapMarker => ({
      x: 40 + Number(id) % 6 * 80, y: 40 + Math.floor(Number(id) / 6) * 55, halfWidth: 3, halfHeight: 3
    })
    const overview = placeMapTitles(titles, new Set(), position, 600, 320, 1, measure)
    const zoomed = placeMapTitles(titles, new Set(), position, 600, 320, 2, measure)
    const tallOverview = placeMapTitles(titles, new Set(), position, 760, 737, 1, measure)
    expect(overview.map(({ id }) => id)).toEqual(['0', '1', '2', '3', '4'])
    expect(zoomed).toHaveLength(20)
    expect(zoomed.slice(0, overview.length)).toEqual(overview)
    expect(tallOverview).toHaveLength(14)
  })
})
