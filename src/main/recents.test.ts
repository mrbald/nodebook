import { describe, it, expect } from 'vitest'
import { pushRecent } from './recents'

describe('pushRecent', () => {
  it('prepends a new path (most-recent-first)', () => {
    expect(pushRecent(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b'])
  })

  it('de-duplicates, moving an existing path to the front', () => {
    expect(pushRecent(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c'])
  })

  it('caps the list at max, dropping the oldest', () => {
    expect(pushRecent(['/a', '/b', '/c'], '/d', 3)).toEqual(['/d', '/a', '/b'])
  })

  it('handles an empty list', () => {
    expect(pushRecent([], '/a')).toEqual(['/a'])
  })
})
