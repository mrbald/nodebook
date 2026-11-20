import { describe, expect, it } from 'vitest'
import { nodePicker } from './nodePicking'

const viewport = { width: 300, height: 240 }

describe('node picker', () => {
  it('picks either center of overlapping dots across a cell boundary', () => {
    const a = { id: 'A', center: { x: 31, y: 40 } }
    const b = { id: 'B', center: { x: 33, y: 40 } }
    for (const nodes of [[a, b], [b, a]]) {
      const pick = nodePicker(nodes, viewport)
      expect(pick(a.center)).toBe(a.id)
      expect(pick(b.center)).toBe(b.id)
      expect(pick({ x: 40, y: 50 })).toBeUndefined()
    }
  })

  it('keeps the full routed card clickable and still picks the center of a tiny neighbor', () => {
    const a = { id: 'A', center: { x: 50, y: 75 }, card: { halfWidth: 45, halfHeight: 3 } }
    const b = { id: 'B', center: { x: 93, y: 82 }, card: { halfWidth: 2, halfHeight: 2 } }
    const pick = nodePicker([a, b], viewport)
    expect(pick({ x: 93, y: 78 })).toBe('A')
    expect(pick(b.center)).toBe('B')
    expect(pick({ x: 103, y: 92 })).toBe('B')
    expect(pick({ x: 106, y: 92 })).toBeUndefined()
  })

  it('picks the closest card in a true overlap and the upper card at identical centers', () => {
    const card = { halfWidth: 40, halfHeight: 15 }
    const pick = nodePicker([
      { id: 'A', center: { x: 80, y: 50 }, card },
      { id: 'B', center: { x: 85, y: 50 }, card },
      { id: 'C', center: { x: 85, y: 50 }, card }
    ], viewport)
    expect(pick({ x: 80, y: 50 })).toBe('A')
    expect(pick({ x: 85, y: 50 })).toBe('C')
  })
})
