import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BookLinkEvidence, BookOverview, BookThemeDetails, BookThemeSummary } from '@shared/types'
import { StatusSelect } from '../StatusSelect'
import { StagedNoteView } from '../StagedNoteView'
import { BookOverviewView, pairsLabel } from './BookOverviewView'
import { GraphView } from './GraphView'
import type { MapLayout } from './mapLayoutPreference'
import './bookMap.css'

type GraphProps = React.ComponentProps<typeof GraphView>
type Focusable = HTMLElement | SVGElement
type Scope = { id: string | null; label: string }
type Theme = Pick<BookThemeSummary, 'id' | 'label'>
type BookView = 'note-map' | 'themes'
type BookPage =
  | { kind: 'book'; view: BookView }
  | { kind: 'all' }
  | { kind: 'theme'; theme: Theme }
  | { kind: 'members'; scope: Scope; parent?: Theme }
  | { kind: 'pairs'; source: Theme; target: Theme; count: number }
  | { kind: 'note'; path: string; label: string; trail: Crumb[]; backLabel: string }
type BookScope = 'standalone' | 'overlay'
type Visit = { page: BookPage; scope: BookScope; origin?: Focusable }
type Crumb = { key: string; label: string }

const NOTE_MAP = { kind: 'book', view: 'note-map' } as const
const THEMES = { kind: 'book', view: 'themes' } as const
const ALL: BookPage = { kind: 'all' }
const BOOK_SCOPE_OPTIONS = [
  { value: 'standalone', label: 'Standalone', description: 'This book’s staged notes' },
  { value: 'overlay', label: 'Overlay', description: 'This book and your vault notes' }
]
const BOOK_VIEW_OPTIONS = [
  { value: NOTE_MAP.view, label: 'Note map' },
  { value: THEMES.view, label: 'Themes' }
]

const pageKey = (page: BookPage): string => {
  switch (page.kind) {
    case 'book':
    case 'all': return page.kind
    case 'theme': return JSON.stringify(['theme', page.theme.id])
    case 'members': return JSON.stringify(['members', page.scope.id])
    case 'pairs': return JSON.stringify(['pairs', page.source.id, page.target.id])
    case 'note': return JSON.stringify(['note', page.path])
  }
}

const visitKey = ({ page, scope }: Visit): string =>
  scope === 'overlay' ? 'overlay' : pageKey(page)

const bookView = (page: BookPage): BookView | undefined => {
  if (page.kind === 'book') return page.view
  if (page.kind === 'all') return NOTE_MAP.view
  return undefined
}

const paneKey = (page: BookPage): string => bookView(page) ?? pageKey(page)

const themeCrumb = (theme: Theme): Crumb => ({
  key: pageKey({ kind: 'theme', theme }), label: theme.label
})

function scopeTrail(page: BookPage, title: string, overlay: boolean): Crumb[] {
  const book = { key: 'book', label: title }
  if (page.kind === 'note') return [...page.trail, { key: pageKey(page), label: page.label }]
  if (overlay) return [book, { key: 'overlay', label: 'Overlay' }]
  const key = pageKey(page)
  switch (page.kind) {
    case 'book': return [book]
    case 'all': return [book, { key, label: 'All notes' }]
    case 'theme': return [book, themeCrumb(page.theme)]
    case 'members': return [
      book, ...(page.parent ? [themeCrumb(page.parent)] : []), { key, label: page.scope.label }
    ]
    case 'pairs': return [book, themeCrumb(page.source), { key, label: `Links to ${page.target.label}` }]
  }
}

function backLabel(parent: Visit): string {
  if (parent.page.kind === 'note') return 'Back to note'
  if (parent.scope === 'overlay') return 'Back to overlay'
  switch (parent.page.kind) {
    case 'book': return parent.page.view === THEMES.view ? 'Back to themes' : 'Back to book'
    case 'all': return 'Back to all notes'
    case 'theme': return 'Back to theme'
    case 'members': return 'Back to notes'
    case 'pairs': return 'Back to pairs'
  }
}

export function BookMap({
  runId,
  themeOverviewThreshold,
  vaultRoot,
  layoutPreference,
  onLayoutChange,
  onOpenVaultNote,
  onClose,
  mergeAction,
  statusSlot,
  active = true,
  vaultRevision
}: {
  runId: string
  themeOverviewThreshold: number
  vaultRoot: string | null
  layoutPreference: MapLayout
  onLayoutChange: (layout: MapLayout) => void
  onOpenVaultNote: (path: string, trigger?: Focusable) => void
  onClose: () => void
  mergeAction?: React.ReactNode
  statusSlot: React.ReactNode
  active?: boolean
  vaultRevision?: number
}): React.JSX.Element {
  const [openingThreshold] = useState(themeOverviewThreshold)
  const [overview, setOverview] = useState<BookOverview | null | undefined>(undefined)
  const [history, setHistory] = useState<Visit[]>([{ page: NOTE_MAP, scope: 'standalone' }])
  const [notesOpened, setNotesOpened] = useState(false)
  const [overlayOpened, setOverlayOpened] = useState(false)
  const views = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<(() => Focusable | null | undefined) | null>(null)
  const current = history[history.length - 1]
  const showingOverlay = current.scope === 'overlay'
  const visibleKey = showingOverlay ? 'overlay' : paneKey(current.page)
  const previous = history[history.length - 2]

  useEffect(() => {
    let live = true
    const open = (data: BookOverview | null): void => {
      if (!live) return
      const usable = data?.themes.length ? data : null
      const page = usable && usable.noteCount > openingThreshold ? THEMES : NOTE_MAP
      setOverview(usable)
      setHistory([{ page, scope: 'standalone' }])
      setNotesOpened(page === NOTE_MAP)
    }
    void window.nodebook.distillBookOverview(runId).then(open, () => open(null))
    return () => { live = false }
  }, [runId, openingThreshold])

  useLayoutEffect(() => {
    if (!active || !restoreFocus.current) return
    const target = restoreFocus.current()
    restoreFocus.current = null
    target?.focus({ preventScroll: true })
  }, [active, history, overview, visibleKey])

  const visibleControl = (selector: string): Focusable | null | undefined => {
    const pane = views.current?.querySelector('.book-map-pane:not([hidden])')
    return pane?.querySelector<Focusable>(selector)
  }

  const goTo = (page: BookPage, origin: Focusable | undefined): void => {
    restoreFocus.current = () => visibleControl('[data-book-entry]') ??
      visibleControl('.book-overview-action, .graph-close')
    setHistory([...history, { page, scope: 'standalone', origin }])
  }

  const backTo = (index: number): void => {
    const origin = history[index + 1].origin
    restoreFocus.current = () => {
      if (origin?.isConnected && views.current?.contains(origin) && !origin.closest('[hidden]')) return origin
      return visibleControl('[data-book-entry], .graph-node[tabindex="0"], .graph-close')
    }
    setHistory(history.slice(0, index + 1))
  }
  const goBack = (): void => backTo(history.length - 2)

  const openStagedNote = (path: string, label: string, backLabel: string, origin?: Focusable, theme?: Theme): void => {
    const trail = scopeTrail(current.page, runId, showingOverlay)
    if (theme) trail.push(themeCrumb(theme))
    goTo({ kind: 'note', path, label, trail, backLabel }, origin)
  }

  const openGraphNote: GraphProps['onOpenInEditor'] = (path, trigger, node) => {
    const origin = trigger ?? (document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement
      ? document.activeElement : undefined)
    if (node.source === 'vault') onOpenVaultNote(path, origin)
    else {
      const label = node.label ?? (path.split(/[/\\]/).pop() ?? path).replace(/\.md$/i, '')
      openStagedNote(path, label, showingOverlay ? 'Back to overlay' : 'Back to map', origin)
    }
  }

  const openTheme = (theme: Theme, trigger: Focusable): void => goTo({ kind: 'theme', theme }, trigger)
  const openAll = (trigger: HTMLButtonElement): void => {
    setNotesOpened(true)
    goTo(ALL, trigger)
  }
  const openBook = (trigger: HTMLButtonElement): void => {
    const visit = history.slice().reverse().find(({ page }) => bookView(page) !== undefined)
    goTo(visit && bookView(visit.page) === THEMES.view ? THEMES : NOTE_MAP, trigger)
  }

  const navigation = (page: BookPage, inOverlay = false): React.JSX.Element => {
    const trail = scopeTrail(page, runId, inOverlay)
    const parentKeys = history.slice(0, -1).map(visitKey)
    return (
      <nav className="book-map-navigation" aria-label="Book path">
        {previous && page.kind !== 'note' && (
          <button className="graph-ctl book-back-to-themes" onClick={goBack} data-book-entry>
            ← {backLabel(previous)}
          </button>
        )}
        <ol>
          {trail.map(({ key, label }, i) => {
            const last = i === trail.length - 1
            const target = parentKeys.lastIndexOf(key)
            return (
              <li key={key} aria-current={last ? 'page' : undefined}>
                {!last && target >= 0 ? (
                  <button className="book-detail-link" onClick={() => backTo(target)}>{label}</button>
                ) : <span>{label}</span>}
              </li>
            )
          })}
        </ol>
      </nav>
    )
  }

  const scopeSelect = (
    <StatusSelect
      kind="book-scope"
      title="Book map scope"
      prefix="Scope: "
      value={current.scope}
      options={BOOK_SCOPE_OPTIONS}
      onChange={(scope) => {
        if (scope === current.scope || (scope !== 'standalone' && scope !== 'overlay')) return
        restoreFocus.current = () => visibleControl('.status-select-book-scope .status-btn')
        if (scope === 'overlay') setOverlayOpened(true)
        setHistory([...history.slice(0, -1), { ...current, scope }])
      }}
    />
  )
  const currentBookView = bookView(current.page)
  const viewSelect = !showingOverlay && overview && currentBookView && (
    <StatusSelect
      kind="book-view"
      title="Book view"
      prefix="View: "
      value={currentBookView}
      options={BOOK_VIEW_OPTIONS}
      onChange={(view) => {
        if ((view !== NOTE_MAP.view && view !== THEMES.view) || view === currentBookView) return
        restoreFocus.current = () => visibleControl('.status-select-book-view .status-btn')
        if (view === NOTE_MAP.view) setNotesOpened(true)
        const parents = history.slice(0, -1)
        // The header shortcut leaves a route back to Themes. The selector also
        // returns to that visit, with focus on the destination selector.
        setHistory(current.page.kind === 'all' ? parents : [
          ...parents, { ...current, page: view === THEMES.view ? THEMES : NOTE_MAP }
        ])
      }}
    />
  )
  const status = (
    <>
      {mergeAction}
      {statusSlot}
    </>
  )

  const loadNotes = useCallback<NonNullable<GraphProps['loadGraph']>>((focus, options) =>
    window.nodebook.distillGraph(runId, focus, options), [runId])
  const loadOverlay = useCallback<NonNullable<GraphProps['loadGraph']>>((focus, options) =>
    window.nodebook.distillOverlayGraph(runId, focus, options), [runId])

  const graphProps: GraphProps = {
    focusPath: null,
    focusName: '',
    vaultRoot,
    layoutPreference,
    onLayoutChange,
    talkReady: false,
    runId,
    scopeLabel: runId,
    onOpenInEditor: openGraphNote,
    onClose,
    emptyMessage: 'This run staged no notes with matching source quotes.'
  }
  // The overview and visited note/overlay maps are reusable. The remaining
  // views stay mounted only while in the Back path, including across deep jumps.
  const pages = new Map<string, BookPage>([[THEMES.view, THEMES]])
  if (notesOpened) pages.set(NOTE_MAP.view, NOTE_MAP)
  for (const { page } of history) pages.set(paneKey(page), page)

  return (
    <div className="book-map-views" ref={views} hidden={!active}>
      {[...pages].map(([key, page]) => {
        const visible = key === visibleKey
        const paneActive = visible && active
        const graph = {
          ...graphProps,
          active: paneActive,
          scopeSlot: paneActive ? <>{scopeSelect}{viewSelect}</> : undefined,
          statusSlot: paneActive ? status : undefined
        }
        const showNavigation = key !== THEMES.view || (visible && !!previous)
        return (
          <div className="book-map-pane" key={key} hidden={!visible}>
            {showNavigation && navigation(page)}
            {key === NOTE_MAP.view && (overview === undefined ? (
              <div className="book-details">
                <div className="graph-empty" role="status">Loading book map…</div>
                <div className="graph-toolbar"><div className="graph-toolbar-right">
                  {paneActive && statusSlot}
                  <button className="graph-close" onClick={onClose}>✕ Close</button>
                </div></div>
              </div>
            ) : (
              <GraphView {...graph}
                readOnly collectionScope loadGraph={loadNotes} defaultShowSources
                focusName={page.kind === 'all' ? 'All notes' : ''}
              />
            ))}
            {key === THEMES.view && overview && (
              <BookOverviewView
                title={runId}
                overview={overview}
                onExplore={openTheme}
                onOpenNote={(path, title, theme, trigger) => openStagedNote(path, title, 'Back to themes', trigger, theme)}
                onShowPairs={(source, target, count, trigger) => goTo({ kind: 'pairs', source, target, count }, trigger)}
                onNoteMap={openAll}
                onUnassigned={(trigger) => goTo({ kind: 'members', scope: { id: null, label: 'Unassigned notes' } }, trigger)}
                controls={graph.scopeSlot}
                footer={<span className="graph-toolbar-right">
                  {paneActive && status}
                  <button className="graph-close" onClick={onClose}>✕ Close</button>
                </span>}
              />
            )}
            {page.kind === 'theme' && (
              <BookTheme
                graph={graph} runId={runId} theme={page.theme}
                onOpenMembers={(scope, trigger) => goTo({ kind: 'members', scope, parent: page.theme }, trigger)}
                onOpenNote={(path, label, trigger) => openStagedNote(path, label, 'Back to subthemes', trigger)}
              />
            )}
            {page.kind === 'members' && <MemberMap graph={graph} runId={runId} scope={page.scope} parent={page.parent} />}
            {page.kind === 'pairs' && (
              <BookPairs
                runId={runId}
                page={page}
                graph={graph}
                onOpenNote={(path, label, trigger) => openStagedNote(path, label, 'Back to pairs', trigger)}
                onOpenTheme={openTheme}
              />
            )}
            {page.kind === 'note' && (
              <>
                <StagedNoteView
                  runId={runId}
                  path={page.path}
                  name={page.label}
                  backLabel={page.backLabel}
                  onBack={goBack}
                  onOpenBook={openBook}
                  onOpenTheme={openTheme}
                />
                {paneActive && <BookFooter onClose={onClose}>{statusSlot}</BookFooter>}
              </>
            )}
          </div>
        )
      })}
      {overlayOpened && (
        <div className="book-map-pane" hidden={!showingOverlay}>
          {navigation(current.page, true)}
          <GraphView
            {...graphProps}
            scopeLabel={`${runId} · Overlay`}
            reloadKey={vaultRevision}
            loadGraph={loadOverlay}
            defaultShowSources
            showOriginOption
            active={showingOverlay && active}
            scopeSlot={showingOverlay && active ? scopeSelect : undefined}
            statusSlot={showingOverlay && active ? status : undefined}
          />
        </div>
      )}
    </div>
  )
}

function MemberMap({ graph, runId, scope, parent }: {
  graph: GraphProps
  runId: string
  scope: Scope
  parent?: Theme
}): React.JSX.Element {
  const loadGraph = useCallback<NonNullable<GraphProps['loadGraph']>>((_, options) =>
    window.nodebook.distillThemeGraph(runId, scope.id, options?.cap), [runId, scope.id])
  return (
    <GraphView {...graph}
      themeMembers
      readOnly
      focusName={scope.label}
      scopeLabel={[runId, parent?.label, scope.label].filter(Boolean).join(' · ')}
      emptyMessage="This collection has no notes to show."
      loadGraph={loadGraph}
    />
  )
}

function BookTheme({ graph, runId, theme, onOpenMembers, onOpenNote }: {
  graph: GraphProps
  runId: string
  theme: Theme
  onOpenMembers: (scope: Scope, trigger: HTMLButtonElement) => void
  onOpenNote: (path: string, label: string, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [details, setDetails] = useState<BookThemeDetails | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void window.nodebook.distillBookTheme(runId, theme.id).then(
      (data) => { if (live) setDetails(data) },
      () => { if (live) setDetails(null) }
    )
    return () => { live = false }
  }, [runId, theme.id])

  if (details !== undefined && !details?.subthemes.length) {
    return <MemberMap graph={graph} runId={runId} scope={theme} />
  }
  const groups = details?.subthemes ?? []
  const count = groups.reduce((total, child) => total + child.count, details?.remainder?.count ?? 0)
  return (
    <div className="book-details">
      <section className="book-details-body" aria-label="Subthemes">
        {details === undefined ? <p role="status">Loading theme…</p> : (
          <>
            <h1>{theme.label}</h1>
            <button
              className="book-overview-action"
              onClick={(event) => onOpenMembers({ ...theme, label: 'All notes' }, event.currentTarget)}
            >Show all {count.toLocaleString()} notes</button>
            <ul className="book-subthemes">
              {[...groups, ...(details.remainder ? [details.remainder] : [])].map((group) => (
                <li key={group.id}>
                  <button className="book-detail-link" onClick={(event) => onOpenMembers(group, event.currentTarget)}>
                    {group.label}
                    <span>{group.count.toLocaleString()} notes</span>
                  </button>
                  {group.examples.length > 0 && (
                    <ul className="book-note-list">
                      {group.examples.map(({ id, title }) => (
                        <li key={id}>
                          <button className="book-detail-link" onClick={(event) => onOpenNote(id, title, event.currentTarget)}>
                            {title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <BookFooter scopeSlot={graph.scopeSlot} onClose={graph.onClose}>{graph.statusSlot}</BookFooter>
    </div>
  )
}

function BookPairs({ runId, page, graph, onOpenNote, onOpenTheme }: {
  runId: string
  page: Extract<BookPage, { kind: 'pairs' }>
  graph: GraphProps
  onOpenNote: (path: string, label: string, trigger: HTMLButtonElement) => void
  onOpenTheme: (theme: Theme, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [evidence, setEvidence] = useState<BookLinkEvidence | null | undefined>(undefined)
  const { source, target, count } = page
  useEffect(() => {
    let live = true
    void window.nodebook.distillBookLink(runId, source.id, target.id).then(
      (data) => { if (live) setEvidence(data) },
      () => { if (live) setEvidence(null) }
    )
    return () => { live = false }
  }, [runId, source.id, target.id])
  return (
    <div className="book-details">
      <section className="book-details-body" aria-label="Linked note pairs">
        <h1>{pairsLabel(count)} between themes</h1>
        <p>{source.label} ↔ {target.label}</p>
        <button className="book-overview-action" onClick={(event) => onOpenTheme(target, event.currentTarget)}>
          Explore {target.label}
        </button>
        {evidence === undefined ? <p role="status">Loading note pairs…</p> : !evidence?.pairs.length ? (
          <p role="status">These note pairs are unavailable.</p>
        ) : (
          <ol className="book-pairs">
            {evidence.pairs.map((pair) => (
              <li key={JSON.stringify([pair.source.id, pair.target.id])}>
                <div className="book-pair-endpoints">
                  {[pair.source, pair.target].map(({ id, title }) => (
                    <button key={id} className="book-detail-link" onClick={(event) => onOpenNote(id, title, event.currentTarget)}>
                      {title}
                    </button>
                  ))}
                </div>
                <ul className="book-pair-relations">
                  {pair.relationships.map((relation, i) => {
                    const from = relation.originalSource ?? (pair.source.id === relation.source ? pair.source : pair.target)
                    const to = relation.originalTarget ?? (pair.source.id === relation.target ? pair.source : pair.target)
                    return <li key={i}>{from.title} <span>→ {relation.relation} →</span> {to.title}</li>
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
      <BookFooter scopeSlot={graph.scopeSlot} onClose={graph.onClose}>{graph.statusSlot}</BookFooter>
    </div>
  )
}

function BookFooter({ children, scopeSlot, onClose }: { children: React.ReactNode; scopeSlot?: React.ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <div className="graph-toolbar book-details-footer">
      {scopeSlot}
      <span className="graph-toolbar-right">
        {children}
        <button className="graph-close" onClick={onClose}>✕ Close</button>
      </span>
    </div>
  )
}
