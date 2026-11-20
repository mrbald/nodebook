const STORAGE_KEY = 'nodebook.map-layout'

const labels = {
  force: 'Force',
  tree: 'Tree',
  elk: 'Routed (ELK)',
  radial: 'Radial',
  groups: 'Groups',
  blocks: 'Blocks'
}

export type MapLayout = keyof typeof labels

export const MAP_LAYOUT_OPTIONS = Object.entries(labels).map(([value, label]) => ({ value, label }))

export function isMapLayout(value: string | null): value is MapLayout {
  return value !== null && Object.hasOwn(labels, value)
}

export function readMapLayout(): MapLayout {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (isMapLayout(value)) return value
  } catch {
    // A renderer without access to storage can still choose a layout for this session.
  }
  return 'force'
}

export function saveMapLayout(layout: MapLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, layout)
  } catch {
    // The in-memory preference still applies to every map in this window.
  }
}
