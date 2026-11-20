import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BookOverview } from '@shared/types'
import { bookThemeAnchors, bookThemeLayout, type Size } from './bookThemeLayout'

type Theme = BookOverview['themes'][number]
type Camera = { x: number; y: number; zoom: number }
const INITIAL_CAMERA: Camera = { x: 0, y: 0, zoom: 1 }
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

function boundedCamera(camera: Camera, viewport: Size, scene: Size): Camera {
  const axis = (position: number, space: number, length: number): number => {
    const remaining = space - camera.zoom * length
    return remaining >= 0 ? remaining / 2 : clamp(position, remaining, 0)
  }
  return {
    zoom: camera.zoom,
    x: axis(camera.x, viewport.width, scene.width),
    y: axis(camera.y, viewport.height, scene.height)
  }
}

const notesLabel = (count: number): string => `${count.toLocaleString()} ${count === 1 ? 'note' : 'notes'}`
export const pairsLabel = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? 'pair' : 'pairs'}`

export function BookOverviewView({
  title,
  overview,
  onExplore,
  onOpenNote,
  onShowPairs,
  onNoteMap,
  onUnassigned,
  controls,
  footer
}: {
  title: string
  overview: BookOverview
  onExplore: (theme: Theme, trigger: HTMLButtonElement) => void
  onOpenNote: (id: string, title: string, theme: Theme, trigger: HTMLButtonElement) => void
  onShowPairs: (source: Theme, target: Theme, count: number, trigger: HTMLButtonElement) => void
  onNoteMap: (trigger: HTMLButtonElement) => void
  onUnassigned: (trigger: HTMLButtonElement) => void
  controls?: React.ReactNode
  footer: React.ReactNode
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [camera, setCamera] = useState(INITIAL_CAMERA)
  const [geometry, setGeometry] = useState<{
    viewport: Size
    scene: ReturnType<typeof bookThemeLayout>
  } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const pan = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const anchors = useMemo(() => bookThemeAnchors(overview), [overview])

  useLayoutEffect(() => {
    const viewport = viewportRef.current!
    const measure = (): void => {
      const { clientWidth: width, clientHeight: height } = viewport
      if (!width || !height) return // detail is visible; leave the overview camera in place
      const sizes = new Map<string, Size>()
      for (const [id, button] of buttons.current) {
        sizes.set(id, { width: button.offsetWidth, height: button.offsetHeight })
      }
      setGeometry({ viewport: { width, height }, scene: bookThemeLayout(anchors, sizes, { width, height }) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    for (const button of buttons.current.values()) observer.observe(button)
    return () => observer.disconnect()
  }, [anchors])

  const maxMembers = Math.max(1, ...overview.themes.map((theme) => theme.count))
  const themes = new Map(overview.themes.map((theme) => [theme.id, theme]))
  const selected = selectedId ? themes.get(selectedId) : undefined
  const shownLinks = selected
    ? overview.links.filter((link) => link.source === selected.id || link.target === selected.id)
    : overview.links.filter((link) => link.strong)
  const linked = selected
    ? shownLinks.map((link) => ({
        theme: themes.get(link.source === selected.id ? link.target : link.source)!,
        count: link.count
      })).sort((a, b) => b.count - a.count || a.theme.label.localeCompare(b.theme.label))
    : []
  const linkedIds = new Set(linked.map(({ theme }) => theme.id))
  const view = geometry ? boundedCamera(camera, geometry.viewport, geometry.scene) : camera
  const fitZoom = geometry
    ? Math.min(1, geometry.viewport.width / geometry.scene.width, geometry.viewport.height / geometry.scene.height)
    : 1
  const setView = (next: Camera): void => {
    if (geometry) setCamera(boundedCamera(next, geometry.viewport, geometry.scene))
  }

  return (
    <section className="book-overview" aria-label="Book overview">
      <header className="book-overview-header">
        <div>
          <h1>{title}</h1>
          <p>{overview.themes.length} themes · {notesLabel(overview.noteCount)}</p>
        </div>
        <div className="book-overview-note-map">
          <button className="book-overview-action" onClick={(event) => onNoteMap(event.currentTarget)}>
            Note map
          </button>
          {overview.unassignedCount > 0 && (
            <button className="graph-ctl" onClick={(event) => onUnassigned(event.currentTarget)}>
              Unassigned notes ({overview.unassignedCount})
            </button>
          )}
        </div>
      </header>
      <div className="book-overview-body">
        <div
          className="book-theme-viewport"
          ref={viewportRef}
          role="group"
          aria-label="Themes in this book"
          onWheel={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            const x = event.clientX - bounds.left
            const y = event.clientY - bounds.top
            const zoom = clamp(view.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), Math.min(0.65, fitZoom), 3)
            const scale = zoom / view.zoom
            setView({ x: x - (x - view.x) * scale, y: y - (y - view.y) * scale, zoom })
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || (event.target as Element).closest('button')) return
            pan.current = { x: view.x, y: view.y, startX: event.clientX, startY: event.clientY }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!pan.current) return
            const { x, y, startX, startY } = pan.current
            setView({ x: x + event.clientX - startX, y: y + event.clientY - startY, zoom: view.zoom })
          }}
          onLostPointerCapture={() => { pan.current = null }}
        >
          <div className="book-theme-scene" style={{
            width: geometry?.scene.width,
            height: geometry?.scene.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
          }}>
            <svg className="book-theme-links" data-highlighted={!!selected} aria-hidden="true">
              {shownLinks.map(({ source, target, count }) => {
                const a = geometry?.scene.labels.get(source)
                const b = geometry?.scene.labels.get(target)
                if (!a || !b) return null
                return (
                  <line
                    key={JSON.stringify([source, target])}
                    className="book-theme-link"
                    x1={a.x + 12} y1={a.y + 13}
                    x2={b.x + 12} y2={b.y + 13}
                    strokeWidth={Math.min(1.6, (selected ? 0.85 : 0.55) + Math.log2(1 + count) * 0.12)}
                    vectorEffect="non-scaling-stroke"
                  />
                )
              })}
            </svg>
            {overview.themes.map((theme) => {
              const label = geometry?.scene.labels.get(theme.id)
              const dotSize = 5 + 6 * Math.sqrt(theme.count / maxMembers)
              return (
                <button
                  key={theme.id}
                  type="button"
                  className={`book-theme${linkedIds.has(theme.id) ? ' is-linked' : ''}`}
                  aria-pressed={theme.id === selectedId}
                  ref={(button) => {
                    if (button) buttons.current.set(theme.id, button)
                    else buttons.current.delete(theme.id)
                  }}
                  style={{ left: label?.x, top: label?.y, visibility: label ? undefined : 'hidden' }}
                  onFocus={() => {
                    if (!geometry || !label) return
                    const { width, height } = geometry.viewport
                    const x = clamp(view.x, 8 - label.x * view.zoom, width - 8 - (label.x + label.width) * view.zoom)
                    const y = clamp(view.y, 8 - label.y * view.zoom, height - 8 - (label.y + label.height) * view.zoom)
                    if (x !== view.x || y !== view.y) setView({ ...view, x, y })
                  }}
                  onClick={() => setSelectedId(theme.id === selectedId ? null : theme.id)}
                >
                  <span className="book-theme-dot" aria-hidden="true" style={{ width: dotSize, height: dotSize }} />
                  <span className="book-theme-title">{theme.label}</span>
                  <span className="book-theme-count">{notesLabel(theme.count)}</span>
                </button>
              )
            })}
          </div>
        </div>
        <aside className="book-overview-inspector" aria-label="Theme details">
          {selected ? (
            <>
              <h2>{selected.label}</h2>
              {selected.count > 0 ? (
                <button className="book-overview-action" onClick={(event) => onExplore(selected, event.currentTarget)}>
                  Explore {notesLabel(selected.count)}
                </button>
              ) : <p>No notes in this theme.</p>}
              {selected.examples.length > 0 && (
                <>
                  <h3>Representative notes</h3>
                  <ul className="book-note-list" aria-label="Representative notes">
                    {selected.examples.map(({ id, title }) => (
                      <li key={id}>
                        <button
                          className="book-detail-link"
                          onClick={(event) => onOpenNote(id, title, selected, event.currentTarget)}
                        >{title}</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3>Linked themes</h3>
              {linked.length > 0 && <p>Each pair of linked notes counts once.</p>}
              {linked.length > 0 ? (
                <ul className="book-overview-connections" aria-label="Linked themes">
                  {linked.map(({ theme, count }) => (
                    <li key={theme.id}>
                      <button className="book-detail-link" onClick={() => {
                        setSelectedId(theme.id)
                        buttons.current.get(theme.id)?.focus({ preventScroll: true })
                      }}>{theme.label}</button>
                      <button
                        className="graph-ctl book-pair-count"
                        aria-label={`${pairsLabel(count)} with ${theme.label}`}
                        onClick={(event) => onShowPairs(selected, theme, count, event.currentTarget)}
                      >{pairsLabel(count)}</button>
                    </li>
                  ))}
                </ul>
              ) : <p>No links to other themes.</p>}
            </>
          ) : (
            <>
              <h2>Book themes</h2>
              <p>Choose a theme to see its links and explore its notes.</p>
              {shownLinks.length > 0 && <p>The overview shows a selection of the strongest links.</p>}
            </>
          )}
        </aside>
      </div>
      <div className="book-overview-footer graph-toolbar">
        <div className="graph-controls">
          {controls}
          <button
            className="graph-ctl"
            type="button"
            disabled={!geometry || !overview.themes.length}
            onClick={() => setView({ ...INITIAL_CAMERA, zoom: fitZoom })}
          >
            Fit view
          </button>
        </div>
        {footer}
      </div>
    </section>
  )
}
