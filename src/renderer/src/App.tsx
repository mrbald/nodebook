import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownFile, SearchHit, Settings } from '@shared/types'
import { Editor, type ViewMode } from './editor/Editor'
import { BacklinksPanel } from './BacklinksPanel'
import { MapView } from './MapView'
import { ConfigEditor } from './editor/ConfigEditor'
import { getTheme } from './editor/themes'
import { FileTree, type ContextTarget } from './FileTree'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Prompt } from './Prompt'
import { Confirm } from './Confirm'
import { StatusSelect } from './StatusSelect'
import { renderMarkdown } from './markdownRender'
import { useDirtyDoc } from './useDirtyDoc'
import { useTalk } from './talk/useTalk'
import { TalkPanel } from './talk/TalkPanel'
import { TelemetryWidget } from './telemetry/TelemetryWidget'
import { GraphView } from './graph/GraphView'
import HELP_DOC from './help.md?raw'

type ThemeMode = 'system' | 'dark' | 'light'
const MODE_OPTIONS = [
  { value: 'code', label: 'Code' },
  { value: 'live', label: 'Live preview' },
  { value: 'reading', label: 'Reading' }
]
const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

/** Parse an FTS snippet's `<mark>` markers into safe React nodes (no innerHTML). */
function renderSnippet(snippet: string): React.ReactNode {
  let inMark = false
  return snippet.split(/(<mark>|<\/mark>)/).map((part, i) => {
    if (part === '<mark>') {
      inMark = true
      return null
    }
    if (part === '</mark>') {
      inMark = false
      return null
    }
    if (!part) return null
    return inMark ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>
  })
}

export default function App() {
  const [vault, setVault] = useState<string | null>(null)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const [active, setActive] = useState<MarkdownFile | null>(null)
  const [doc, setDoc] = useState<string | null>(null)
  const [noteNames, setNoteNames] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [telemetryOn, setTelemetryOn] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [graphEpoch, setGraphEpoch] = useState(0)
  const talk = useTalk()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsPath, setSettingsPath] = useState<string | null>(null)
  const [settingsDoc, setSettingsDoc] = useState<string | null>(null)
  // Bumped on "reset to defaults" to force the settings editor to remount with
  // the restored text (and reset its dirty baseline).
  const [settingsEpoch, setSettingsEpoch] = useState(0)
  // Non-null while "Reveal defaults" is showing the read-only defaults reference.
  const [defaultsDoc, setDefaultsDoc] = useState<string | null>(null)
  const [editorTheme, setEditorTheme] = useState('dark')
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [autosave, setAutosave] = useState({ delayMs: 0, onSwitch: true })
  const [dirs, setDirs] = useState<string[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [prompt, setPrompt] = useState<{
    title: string
    initialValue?: string
    confirmLabel?: string
    onConfirm: (value: string) => void
  } | null>(null)
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)
  // The markdown view mode (Code / Live / Reading), persisted across file switches.
  const [editorMode, setEditorMode] = useState<ViewMode>('live')
  const settingsRef = useRef<Settings | null>(null)
  // Off-screen container that holds the fully-rendered note for Print / Export-PDF.
  const printRef = useRef<HTMLDivElement | null>(null)

  // Apply a theme to the whole app (CSS vars) and surface its name so the
  // editors reconfigure their own compartment to match.
  const applyTheme = (name: string, fontSize: number): void => {
    const root = document.documentElement
    const th = getTheme(name)
    for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(k, v)
    root.style.setProperty('--editor-font-size', `${fontSize}px`)
    root.style.colorScheme = th.dark ? 'dark' : 'light'
    setEditorTheme(name)
  }

  const resolveThemeName = (s: Settings): string => {
    if (!s.theme.followSystem) return s.theme.name
    const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return osDark ? s.theme.dark : s.theme.light
  }

  const applySettings = (s: Settings): void => {
    settingsRef.current = s
    applyTheme(resolveThemeName(s), s.editor.fontSize)
    setAutosave({ delayMs: s.editor.autosaveDelayMs, onSwitch: s.editor.autosaveOnSwitch })
    setTelemetryOn(s.telemetry.enabled)
    // The quick selector collapses the theme config to system / dark / light.
    setThemeMode(s.theme.followSystem ? 'system' : getTheme(s.theme.name).dark ? 'dark' : 'light')
  }

  const pickThemeMode = (mode: string): void => {
    void window.nodebook.setThemeMode(mode as ThemeMode).then(applySettings)
  }

  // Own telemetry measurement at the app level so it tracks the setting, not the
  // status-bar widget's mount state (which comes and goes with the view).
  useEffect(() => {
    void window.nodebook.telemetryApply(telemetryOn)
  }, [telemetryOn])

  useEffect(() => {
    void window.nodebook.readSettings().then((s) => {
      applySettings(s)
      setEditorMode(s.editor.defaultMode) // notes open in the configured mode
    })
    // Live-follow OS appearance changes when followSystem is on.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const s = settingsRef.current
      if (s && s.theme.followSystem) applyTheme(resolveThemeName(s), s.editor.fontSize)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
    // Mount-once: load settings + attach the OS-appearance listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Save controllers (one per editor buffer) ---------------------------
  const noteSaver = useDirtyDoc({
    docKey: active?.path ?? null,
    initialDoc: doc,
    persist: (content) => {
      if (active) void window.nodebook.saveFile(active.path, content)
    },
    autosaveDelayMs: autosave.delayMs,
    autosaveOnSwitch: autosave.onSwitch
  })

  const configSaver = useDirtyDoc({
    docKey: settingsPath == null ? null : `${settingsPath}#${settingsEpoch}`,
    initialDoc: settingsDoc,
    persist: (content) => {
      if (!settingsPath) return
      void window.nodebook
        .saveFile(settingsPath, content)
        .then(() => window.nodebook.readSettings())
        .then(applySettings)
    },
    autosaveDelayMs: autosave.delayMs,
    autosaveOnSwitch: autosave.onSwitch
  })

  // Flush the editor we're leaving, if autosave-on-switch is enabled.
  const flushCurrent = useCallback(() => {
    if (settingsOpen) {
      if (configSaver.onSwitchEnabled()) configSaver.saveNow()
    } else if (active) {
      if (noteSaver.onSwitchEnabled()) noteSaver.saveNow()
    }
  }, [settingsOpen, active, configSaver, noteSaver])

  // ⌘S / Ctrl+S saves the current editor now (explicit; ignores the toggle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (settingsOpen) configSaver.saveNow()
        else noteSaver.saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, configSaver, noteSaver])

  // Synchronously flush on window close so nothing is lost. Closing is the
  // terminal action, so we flush a dirty buffer regardless of the
  // autosave-on-switch setting (that setting governs saves during normal work,
  // not the last-chance flush on quit — no editor should drop your buffer).
  useEffect(() => {
    const onBeforeUnload = (): void => {
      if (settingsOpen && settingsPath && configSaver.dirty) {
        const c = configSaver.getContent()
        if (c != null) window.nodebook.saveFileNow(settingsPath, c)
      } else if (active && noteSaver.dirty) {
        const c = noteSaver.getContent()
        if (c != null) window.nodebook.saveFileNow(active.path, c)
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [settingsOpen, settingsPath, active, configSaver, noteSaver])

  // Window title reflects unsaved state.
  const currentDirty = settingsOpen ? configSaver.dirty : noteSaver.dirty
  useEffect(() => {
    document.title = `${currentDirty ? '● ' : ''}Nodebook`
  }, [currentDirty])

  const enterVault = useCallback(
    async (dir: string) => {
      flushCurrent()
      setVault(dir)
      setActive(null)
      setDoc(null)
      setSettingsOpen(false)
      setHelpOpen(false)
      setGraphOpen(false)
      setQuery('')
      // openVault builds/refreshes the index and returns files + dirs.
      const listing = await window.nodebook.openVault(dir)
      setFiles(listing.files)
      setDirs(listing.dirs)
      setNoteNames(await window.nodebook.noteNames())
      talk.onVaultOpened() // resume embedding for the newly-opened vault
    },
    [flushCurrent, talk]
  )

  const openVault = useCallback(async () => {
    const dir = await window.nodebook.pickVault()
    if (dir) void enterVault(dir)
  }, [enterVault])

  const newVault = useCallback(async () => {
    const dir = await window.nodebook.createVault()
    if (dir) void enterVault(dir)
  }, [enterVault])

  // Re-list files + dirs (after a create/rename/delete, or an external change).
  const relist = useCallback(async (): Promise<MarkdownFile[]> => {
    if (!vault) return []
    const l = await window.nodebook.listVault(vault)
    setFiles(l.files)
    setDirs(l.dirs)
    setNoteNames(await window.nodebook.noteNames())
    return l.files
  }, [vault])

  // Live-refresh the tree when files/dirs change on disk, and keep the knowledge
  // map current when the index content changes (a save added/removed a link).
  useEffect(() => {
    if (!vault) return
    const offVault = window.nodebook.onVaultChanged(() => {
      void relist()
      setGraphEpoch((e) => e + 1)
    })
    const offIndex = window.nodebook.onIndexChanged(() => setGraphEpoch((e) => e + 1))
    return () => {
      offVault()
      offIndex()
    }
  }, [vault, relist])

  const openFile = useCallback(
    async (f: MarkdownFile) => {
      flushCurrent() // save the editor we're leaving
      const content = await window.nodebook.readFile(f.path)
      setActive(f)
      setDoc(content)
      setSettingsOpen(false)
      setHelpOpen(false)
    },
    [flushCurrent]
  )

  const { ready: talkReady, searchSemantic } = talk
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    let ignore = false
    const t = setTimeout(async () => {
      // When semantic search is live, fuse keyword + meaning; else keyword only.
      const hits = talkReady ? await searchSemantic(q) : await window.nodebook.search(q)
      if (!ignore) setResults(hits)
    }, 150)
    return () => {
      ignore = true
      clearTimeout(t)
    }
  }, [query, talkReady, searchSemantic])

  // Resolve a wikilink target to a vault file and open it. Match on bare name
  // first, then on the extension-less relative path (e.g. [[projects/Roadmap]]).
  const openLink = useCallback(
    (target: string) => {
      const f =
        files.find((x) => x.name === target) ??
        files.find((x) => x.rel.replace(/\.md$/i, '') === target)
      if (f) void openFile(f)
    },
    [files, openFile]
  )

  // A wikilink resolves to a real note (same rule as openLink) → not a "ghost".
  const linkExists = useCallback(
    (target: string) =>
      files.some((x) => x.name === target || x.rel.replace(/\.md$/i, '') === target),
    [files]
  )

  const openSettings = useCallback(async () => {
    flushCurrent() // save the note we're leaving
    const p = await window.nodebook.settingsPath()
    const content = await window.nodebook.readFile(p)
    setSettingsPath(p)
    setSettingsDoc(content)
    setDefaultsDoc(null) // start with the defaults reference hidden
    setSettingsOpen(true)
    setHelpOpen(false)
    setGraphOpen(false)
  }, [flushCurrent])

  // Open a note clicked in the graph, keeping the map open so it recenters.
  const openPathInGraph = useCallback(
    (path: string) => {
      const f = files.find((x) => x.path === path)
      if (f) void openFile(f)
    },
    [files, openFile]
  )

  const openHelp = useCallback(() => {
    flushCurrent()
    setGraphOpen(false)
    setSettingsOpen(false)
    setHelpOpen(true)
  }, [flushCurrent])

  const resetSettingsToDefaults = useCallback(() => {
    setConfirm({
      message: 'Reset all settings to factory defaults? Your customizations will be lost.',
      onConfirm: () => {
        setConfirm(null)
        void window.nodebook.resetSettings().then(async (toml) => {
          setSettingsDoc(toml)
          setSettingsEpoch((e) => e + 1) // remount editor + reset dirty baseline
          applySettings(await window.nodebook.readSettings())
        })
      }
    })
    // applySettings only closes over stable setters + module helpers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Toggle the read-only defaults reference beside the editable config. Purely a
  // view — it never writes the file (that's what "Reset to defaults" is for).
  const revealDefaults = useCallback(() => {
    if (defaultsDoc !== null) setDefaultsDoc(null)
    else void window.nodebook.defaultSettings().then(setDefaultsDoc)
  }, [defaultsDoc])

  // Render the note's *current* (possibly unsaved) text into the off-screen
  // print container. CodeMirror virtualizes off-screen lines, so we can't print
  // the editor directly — markdown-it gives us the whole document at once, and
  // setting innerHTML is synchronous so Print/printToPDF see it immediately.
  const fillPrint = useCallback(() => {
    if (printRef.current) printRef.current.innerHTML = renderMarkdown(noteSaver.getContent() ?? doc ?? '')
  }, [noteSaver, doc])

  const exportPdf = useCallback(async () => {
    fillPrint()
    await window.nodebook.exportPdf(active?.name ?? 'note')
  }, [fillPrint, active])

  // Application-menu commands (also drive the ⌘E / ⌘P accelerators).
  useEffect(() => {
    return window.nodebook.onMenuCommand((cmd) => {
      // ⌘E toggles between writing (Live) and Reading; ⌘1/2/3 pick a mode.
      if (cmd === 'toggle-read') setEditorMode((m) => (m === 'reading' ? 'live' : 'reading'))
      else if (cmd === 'mode-code') setEditorMode('code')
      else if (cmd === 'mode-live') setEditorMode('live')
      else if (cmd === 'mode-reading') setEditorMode('reading')
      else if (cmd === 'help') openHelp()
      else if (cmd === 'export-pdf') void exportPdf()
      else if (cmd === 'print') {
        fillPrint()
        window.print()
      }
    })
  }, [exportPdf, fillPrint, openHelp])

  // Absolute directory a "new" action should create into.
  const dirOf = (target: ContextTarget): string => {
    if (!vault) return ''
    if (target.kind === 'folder') return `${vault}/${target.path}`
    if (target.kind === 'file') return target.file.path.replace(/\/[^/]*$/, '')
    return vault
  }

  // Absolute path + display name of a rename/delete target (file or folder).
  const pathOf = (target: ContextTarget): string =>
    target.kind === 'file' ? target.file.path : `${vault}/${(target as { path: string }).path}`
  const labelOf = (target: ContextTarget): string =>
    target.kind === 'file'
      ? target.file.name
      : (target as { path: string }).path.split('/').pop() ?? ''

  const newNoteIn = (dir: string): void => {
    setPrompt({
      title: 'New note name',
      onConfirm: (name) => {
        setPrompt(null)
        void window.nodebook.createFile(dir, name).then(async (p) => {
          if (!p) return
          const files = await relist()
          const nf = files.find((f) => f.path === p)
          if (nf) void openFile(nf)
        })
      }
    })
  }

  const newFolderIn = (dir: string): void => {
    setPrompt({
      title: 'New folder name',
      onConfirm: (name) => {
        setPrompt(null)
        void window.nodebook.createDir(dir, name).then((p) => {
          if (p) void relist()
        })
      }
    })
  }

  const renameTarget = (target: ContextTarget): void => {
    const oldPath = pathOf(target)
    setPrompt({
      title: 'Rename',
      initialValue: labelOf(target),
      confirmLabel: 'Rename',
      onConfirm: (name) => {
        setPrompt(null)
        void window.nodebook.rename(oldPath, name).then(async (newPath) => {
          if (!newPath) return
          const files = await relist()
          // Reconcile the open file: reopen if it was the renamed file; close if
          // it moved under a renamed folder and its old path is gone.
          if (!active) return
          if (target.kind === 'file' && active.path === oldPath) {
            const nf = files.find((f) => f.path === newPath)
            if (nf) void openFile(nf)
          } else if (!files.some((f) => f.path === active.path)) {
            setActive(null)
            setDoc(null)
          }
        })
      }
    })
  }

  const deleteTarget = (target: ContextTarget): void => {
    const path = pathOf(target)
    setConfirm({
      message: `Delete “${labelOf(target)}”? This cannot be undone.`,
      onConfirm: () => {
        setConfirm(null)
        void window.nodebook.deletePath(path).then(async () => {
          const files = await relist()
          if (active && !files.some((f) => f.path === active.path)) {
            setActive(null)
            setDoc(null)
          }
        })
      }
    })
  }

  const onTreeContextMenu = (target: ContextTarget, x: number, y: number): void => {
    const dir = dirOf(target)
    const items: ContextMenuItem[] = [
      { label: 'New note', onClick: () => newNoteIn(dir) },
      { label: 'New folder', onClick: () => newFolderIn(dir) }
    ]
    if (target.kind !== 'root') {
      items.push({ label: 'Rename', onClick: () => renameTarget(target) })
      items.push({ label: 'Delete', onClick: () => deleteTarget(target) })
    }
    setMenu({ x, y, items })
  }

  // The right panel (backlinks) only shows when editing a note; collapse the grid
  // to two columns otherwise (map / settings / help / empty) so the centre fills
  // the width instead of leaving a blank third column.
  const showRightPanel = !!active && !settingsOpen && !helpOpen && !graphOpen
  return (
    <div className={`app${showRightPanel ? '' : ' app--no-right'}`}>
      <aside className="sidebar">
        <div className="vault-actions">
          <button className="open-btn" onClick={openVault}>
            Open vault
          </button>
          <button className="open-btn" onClick={newVault}>
            New vault
          </button>
        </div>
        {vault && (
          <div className="vault-path" title={vault}>
            {vault.split('/').pop()}
          </div>
        )}
        {vault && (
          <input
            className="search-box"
            placeholder="Search notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {vault && <TalkPanel talk={talk} />}
        {query.trim() ? (
          <ul className="search-results">
            {results.length === 0 ? (
              <li className="search-empty">No matches.</li>
            ) : (
              results.map((hit) => {
                const f = files.find((x) => x.path === hit.path)
                return (
                  <li
                    key={hit.path}
                    className={active?.path === hit.path ? 'active' : ''}
                    onClick={() => { if (f) void openFile(f) }}
                  >
                    <div className="search-result-title">
                      {hit.semantic && (
                        <span className="search-result-ai" title="Matched by meaning">
                          ✨{' '}
                        </span>
                      )}
                      {hit.title}
                    </div>
                    <div className="search-result-path">{f?.rel ?? hit.path}</div>
                    {hit.snippet && (
                      <div className="search-result-snippet">{renderSnippet(hit.snippet)}</div>
                    )}
                  </li>
                )
              })
            )}
          </ul>
        ) : (
          <FileTree
            files={files}
            dirs={dirs}
            active={active}
            dirty={!settingsOpen && noteSaver.dirty}
            onOpen={openFile}
            onContextMenu={onTreeContextMenu}
          />
        )}
        {/* Settings are app-global (userData/settings.toml), not per-vault — so
            this is always available, even before a vault is opened. */}
        <button className="settings-btn" onClick={openSettings}>
          ⚙ Settings
        </button>
      </aside>

      <main className="editor-pane">
        {helpOpen ? (
          <div className="settings-pane">
            <div className="settings-header">
              <span className="settings-title">Help — Markdown &amp; Syntax</span>
              <button className="settings-reset" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
            <div className="settings-body">
              <Editor
                key="help"
                initialDoc={HELP_DOC}
                noteNames={[]}
                onChange={() => {}}
                theme={editorTheme}
                mode="reading"
                onOpenUrl={(url) => void window.nodebook.openExternal(url)}
              />
            </div>
          </div>
        ) : settingsOpen && settingsDoc !== null ? (
          <div className="settings-pane">
            <div className="settings-header">
              <span className="settings-title">Settings</span>
              <div className="settings-actions">
                <button
                  className="settings-reveal"
                  onClick={revealDefaults}
                  title="Show every option with its default value, read-only, for reference"
                >
                  {defaultsDoc !== null ? 'Hide defaults' : 'Reveal defaults'}
                </button>
                <button className="settings-reset" onClick={resetSettingsToDefaults}>
                  Reset to defaults
                </button>
              </div>
            </div>
            <div className={`settings-body${defaultsDoc !== null ? ' settings-body--split' : ''}`}>
              <ConfigEditor
                key={`settings-${settingsEpoch}`}
                initialDoc={settingsDoc}
                onChange={configSaver.onChange}
                theme={editorTheme}
              />
              {defaultsDoc !== null && (
                <aside className="settings-defaults">
                  <div className="settings-defaults-label">Defaults — read-only reference</div>
                  <ConfigEditor initialDoc={defaultsDoc} theme={editorTheme} readOnly />
                </aside>
              )}
            </div>
          </div>
        ) : graphOpen && active ? (
          <GraphView
            focusPath={active.path}
            focusName={active.name}
            vaultRoot={vault}
            talkReady={talk.ready}
            onOpen={openPathInGraph}
            onOpenInEditor={(path) => {
              const f = files.find((x) => x.path === path)
              if (f) {
                setGraphOpen(false)
                void openFile(f)
              }
            }}
            onClose={() => setGraphOpen(false)}
            reloadKey={graphEpoch}
            statusSlot={
              <>
                <StatusSelect
                  kind="theme"
                  title="App theme"
                  value={themeMode}
                  options={THEME_OPTIONS}
                  onChange={pickThemeMode}
                />
                <TelemetryWidget enabled={telemetryOn} />
              </>
            }
          />
        ) : active && doc !== null ? (
          active.rel.endsWith('.map.md') ? (
            <MapView key={active.path} content={doc} onOpen={openLink} />
          ) : (
            <div className="note-pane">
              <div className="note-content">
                <Editor
                  key={active.path}
                  initialDoc={noteSaver.getContent() ?? doc ?? ''}
                  noteNames={noteNames}
                  onChange={noteSaver.onChange}
                  onOpenLink={openLink}
                  onOpenUrl={(url) => void window.nodebook.openExternal(url)}
                  linkExists={linkExists}
                  theme={editorTheme}
                  mode={editorMode}
                />
              </div>
              <div className="status-bar">
                <StatusSelect
                  kind="theme"
                  title="App theme"
                  value={themeMode}
                  options={THEME_OPTIONS}
                  onChange={pickThemeMode}
                />
                <StatusSelect
                  kind="mode"
                  title="View mode"
                  value={editorMode}
                  options={MODE_OPTIONS}
                  onChange={(v) => setEditorMode(v as ViewMode)}
                />
                <button
                  className="status-btn graph-open-btn"
                  title="Show this note in the knowledge map"
                  onClick={() => setGraphOpen(true)}
                >
                  ⊹ Map
                </button>
                <TelemetryWidget enabled={telemetryOn} />
              </div>
              {/* Off-screen; populated only for Print / Export-PDF. */}
              <div className="print-reader" ref={printRef} />
            </div>
          )
        ) : (
          <div className="empty">{vault ? 'Select a note' : 'Open a vault to begin'}</div>
        )}
      </main>

      {showRightPanel && <BacklinksPanel active={active} files={files} onOpen={openFile} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {prompt && (
        <Prompt
          title={prompt.title}
          initialValue={prompt.initialValue}
          confirmLabel={prompt.confirmLabel}
          onConfirm={prompt.onConfirm}
          onCancel={() => setPrompt(null)}
        />
      )}
      {confirm && (
        <Confirm
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
