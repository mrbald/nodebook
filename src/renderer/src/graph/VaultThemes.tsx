import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { VaultThemeNote, VaultThemesData } from '@shared/types'
import './vaultThemes.css'

const NOTE_PAGE = 80
const countNotes = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? 'note' : 'notes'}`

type OpenNote = (path: string, trigger: HTMLButtonElement) => void

function NoteList({ notes, onOpenNote }: { notes: VaultThemeNote[]; onOpenNote: OpenNote }): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(NOTE_PAGE)
  const firstNew = useRef<number | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const needle = filter.trim().toLocaleLowerCase()
  const shown = needle
    ? notes.filter(({ title, relativePath }) =>
      title.toLocaleLowerCase().includes(needle) || relativePath.toLocaleLowerCase().includes(needle)
    )
    : notes

  useLayoutEffect(() => {
    if (firstNew.current === null) return
    list.current?.children.item(firstNew.current)?.querySelector('button')?.focus()
    firstNew.current = null
  }, [limit])

  return (
    <>
      {notes.length > 12 && (
        <input
          type="search"
          className="search-box vault-theme-search"
          aria-label="Filter notes in this list"
          placeholder="Filter notes"
          value={filter}
          onChange={(event) => {
            setFilter(event.currentTarget.value)
            setLimit(NOTE_PAGE)
          }}
        />
      )}
      <ul className="vault-theme-notes" ref={list}>
        {shown.slice(0, limit).map(({ path, title, relativePath }) => (
          <li key={path}>
            <button
              type="button"
              onClick={(event) => onOpenNote(path, event.currentTarget)}
            >
              <span>{title}</span>
              <small>{relativePath}</small>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p role="status">No notes match your filter.</p>}
      {shown.length > limit && (
        <button className="graph-ctl vault-theme-action" type="button" onClick={() => {
          firstNew.current = limit
          setLimit(limit + NOTE_PAGE)
        }}>
          Show more notes ({(shown.length - limit).toLocaleString()})
        </button>
      )}
    </>
  )
}

export function VaultThemes({
  active,
  vault,
  revision,
  onOpenNote,
  onNoteMap,
  footer
}: {
  active: boolean
  vault: string
  revision: number
  onOpenNote: OpenNote
  onNoteMap: () => void
  footer: React.ReactNode
}): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const overviewButtons = useRef(new Map<string, HTMLButtonElement>())
  const returnTo = useRef<string | null>(null)
  const refreshFocus = useRef<HTMLElement | null>(null)
  const overviewScroll = useRef(0)
  const [selection, setSelection] = useState<string | null>(null)
  const [semanticRevision, setSemanticRevision] = useState(0)
  const [result, setResult] = useState<{
    vault: string
    revision: number
    semanticRevision: number
    data: VaultThemesData | null
  } | null>(null)

  useEffect(() => {
    if (active) return window.nodebook.onVaultThemesChanged(() => setSemanticRevision((value) => value + 1))
    return undefined
  }, [active])

  useEffect(() => {
    if (!active) return
    const id = crypto.randomUUID()
    let current = true
    const finish = (data: VaultThemesData | null): void => {
      if (!current) return
      const focused = document.activeElement
      refreshFocus.current = focused instanceof HTMLElement && body.current?.contains(focused) ? focused : null
      setResult({ vault, revision, semanticRevision, data })
    }
    void window.nodebook.vaultThemes(vault, id).then(finish, () => finish(null))
    return () => {
      current = false
      window.nodebook.cancelVaultThemes(id)
    }
  }, [active, vault, revision, semanticRevision])

  const snapshot = result?.vault === vault ? result : null
  const refreshing = snapshot !== null &&
    (snapshot.revision !== revision || snapshot.semanticRevision !== semanticRevision)
  const data = snapshot?.data
  const theme = selection && selection !== 'unmatched' ? data?.themes.find(({ id }) => id === selection) : undefined
  const notes = selection === 'unmatched' ? data?.unmatched : theme?.notes
  const showingList = !!notes

  useLayoutEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true })
  }, [active])

  useLayoutEffect(() => {
    const focus = refreshFocus.current
    refreshFocus.current = null
    if (focus && active && document.activeElement === document.body) {
      const target = focus.isConnected ? focus : heading.current
      target?.focus({ preventScroll: true })
    }
  }, [active, result])

  useLayoutEffect(() => {
    if (showingList && selection) {
      body.current?.scrollTo(0, 0)
      heading.current?.focus({ preventScroll: true })
    } else if (returnTo.current && selection === null) {
      body.current?.scrollTo(0, overviewScroll.current)
      const target = overviewButtons.current.get(returnTo.current) ?? heading.current
      target?.focus({ preventScroll: true })
      returnTo.current = null
    }
  }, [showingList, selection])

  const openList = (id: string): void => {
    overviewScroll.current = body.current?.scrollTop ?? 0
    setSelection(id)
  }

  const rememberButton = (id: string, button: HTMLButtonElement | null): void => {
    if (button) overviewButtons.current.set(id, button)
    else overviewButtons.current.delete(id)
  }

  return (
    <section className="vault-themes" hidden={!active} aria-label="Vault themes">
      <header className="vault-themes-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {theme?.label ?? (showingList ? 'Notes without a theme' : 'Vault themes')}
          </h1>
          {notes && <p>{countNotes(notes.length)}</p>}
          {data && !showingList && (
            <p>{data.themes.length} {data.themes.length === 1 ? 'theme' : 'themes'} · {countNotes(data.noteCount)}</p>
          )}
        </div>
        <div className="vault-themes-navigation">
          {showingList && (
            <button className="graph-ctl vault-theme-action" type="button" onClick={() => {
              returnTo.current = selection
              setSelection(null)
            }}>
              ← Back to vault themes
            </button>
          )}
          <button className="graph-ctl vault-theme-action" type="button" onClick={onNoteMap}>
            Back to note map
          </button>
        </div>
      </header>
      <div className="vault-themes-body" ref={body} aria-busy={refreshing}>
        {data === undefined && <p role="status">Loading themes…</p>}
        {data === null && <p role="status">Could not load themes. Return to the note map to try again.</p>}
        {notes && <NoteList key={selection} notes={notes} onOpenNote={(path, trigger) => {
          if (!refreshing) onOpenNote(path, trigger)
        }} />}
        {data && !notes && (
          <>
            {data.noteCount === 0 && <p>There are no indexed notes in this vault.</p>}
            {data.noteCount > 0 && data.themes.length === 0 && (
              <p>There aren’t enough notes or strong connections to identify themes.</p>
            )}
            {data.themes.length > 0 && (
              <>
                <p>
                  Grouped from {data.embeddedCount ? 'note links and available local embeddings' : 'links between notes'}.
                  Each theme is named after a representative note.
                </p>
                <ul className="vault-theme-grid">
                  {data.themes.map(({ id, label, notes, examples }) => (
                    <li key={id}>
                      <button
                        ref={(button) => rememberButton(id, button)}
                        type="button"
                        onClick={() => openList(id)}
                      >
                        <span className="vault-theme-card-title">{label}</span>
                        <span>{countNotes(notes.length)}</span>
                        <small>Also includes {examples.join(' · ')}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {data.unmatched.length > 0 && (
              <button
                ref={(button) => rememberButton('unmatched', button)}
                className="graph-ctl vault-theme-action"
                type="button"
                onClick={() => openList('unmatched')}
              >
                Notes without a theme ({data.unmatched.length.toLocaleString()})
              </button>
            )}
          </>
        )}
      </div>
      <div className="graph-toolbar">{footer}</div>
    </section>
  )
}
