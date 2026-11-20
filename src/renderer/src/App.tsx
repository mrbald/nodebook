import type { FigureSearchHit } from '@shared/figureSearch'
import { FigureDialog, OpenFigure, type FigureTarget } from './Figures'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_THEME_OVERVIEW_THRESHOLD,
  type DistillDocument,
  type Citation,
  type DistillEstimate,
  type DistillMergePlan,
  type DistillMergeStatus,
  type DistillRunInfo,
  type DistillRunResult,
  type MarkdownFile,
  type SearchHit,
  type Settings
} from '@shared/types'
import { Editor, type ViewMode } from './editor/Editor'
import { BacklinksPanel } from './BacklinksPanel'
import {
  parseCitations,
  parseDocumentNote,
  resolveAskPassage,
  resolveCitationSpan,
  type NoteCitation,
  type NoteDocument
} from './citations'
import { MapView } from './MapView'
import { ConfigEditor } from './editor/ConfigEditor'
import { getTheme } from './editor/themes'
import { FileTree, type ContextTarget } from './FileTree'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Prompt, type PromptPreset } from './Prompt'
import { ImportPrompt } from './ImportPrompt'
import { Confirm } from './Confirm'
import { MergeDialog } from './MergeDialog'
import { StatusSelect } from './StatusSelect'
import { renderMarkdown } from './markdownRender'
import { useDirtyDoc } from './useDirtyDoc'
import { describePdfExtraction } from '@shared/pdfExtraction'
import { targetResolver } from '@shared/markdown/resolveTarget'
import { useTalk } from './talk/useTalk'
import { getEmbedder } from './talk/embedder'
import { TalkPanel } from './talk/TalkPanel'
import { AskPanel } from './AskPanel'
import { TelemetryWidget } from './telemetry/TelemetryWidget'
import { BookMap } from './graph/BookMap'
import { GraphView } from './graph/GraphView'
import { readMapLayout, saveMapLayout, type MapLayout } from './graph/mapLayoutPreference'
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

/** Three ready-made ways to read a document. They are fixed strings, so a lens
 *  is reproducible: the same words reach the model every time, and a run's
 *  `meta.json` records which reading it was. The field stays editable — these
 *  are a starting point, not a menu. */
const FOCUS_LENSES = [
  {
    label: 'Arguments',
    value:
      'the arguments the author makes, the evidence given for each, and the objections answered'
  },
  { label: 'Timeline', value: 'what happens, in order: events, dates, and what led to what' },
  {
    label: 'People',
    value: 'the people, places and organisations named, and how they are connected'
  }
]

/** One open one-line dialog (`Prompt.tsx`), as the app asks for it. */
interface PromptRequest {
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  presets?: PromptPreset[]
  maxLength?: number
  allowEmpty?: boolean
  onConfirm: (value: string) => void
}

interface ActiveDistill {
  runId?: string
  pausing: boolean
  settled: boolean
}

function figureCoverageText(kept = 0, skipped = 0, uninspected = 0): string {
  return [
    kept && `Preserved ${kept} figure${kept === 1 ? '' : 's'}.`,
    skipped && `Could not preserve ${skipped} figure candidate${skipped === 1 ? '' : 's'}.`,
    uninspected && `Visuals were not inspected on ${uninspected} PDF page${uninspected === 1 ? '' : 's'}.`
  ].filter(Boolean).join(' ')
}

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

/** Pick a meaningful return target if navigation began outside the map canvas. */
function visibleMapControl(): HTMLElement | SVGElement | undefined {
  const host = document.querySelector('.reader-map-host:not([hidden])')
  if (!host) return undefined
  for (const selector of ['[aria-pressed="true"]', '[tabindex="0"]', 'button:not(:disabled)']) {
    const candidate = [...host.querySelectorAll<HTMLElement | SVGElement>(selector)]
      .find((element) => element.getClientRects().length > 0)
    if (candidate) return candidate
  }
  return undefined
}

export default function App() {
  const printGeneration = useRef(0)
  const [viewFigure, setViewFigure] = useState<FigureTarget | null>(null)
  const [preparingImport, setPreparingImport] = useState<string | null>(null)
  const [vault, setVault] = useState<string | null>(null)
  const currentVault = useRef<{ dir: string } | null>(null)
  const switchingVault = useRef(false)
  const [files, setFiles] = useState<MarkdownFile[]>([])
  const [active, setActive] = useState<MarkdownFile | null>(null)
  const [doc, setDoc] = useState<string | null>(null)
  // Bumped when the active note's file changes on disk under a clean buffer,
  // to remount the editor on the fresh bytes (the island reads its doc once).
  const [noteEpoch, setNoteEpoch] = useState(0)
  // A pending "jump to a cited span" — the source path + range to reveal once open.
  const [pendingReveal, setPendingReveal] = useState<{ path: string; from: number; to: number } | null>(
    null
  )
  const [noteNames, setNoteNames] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [figureHits, setFigureHits] = useState<FigureSearchHit[]>([])
  const [results, setResults] = useState<SearchHit[]>([])
  const [telemetryOn, setTelemetryOn] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [mapAnchor, setMapAnchor] = useState<MarkdownFile | null>(null)
  const [startGlobal, setStartGlobal] = useState(false)
  const [graphEpoch, setGraphEpoch] = useState(0)
  const [mapLayout, setMapLayout] = useState(readMapLayout)
  const [themeOverviewThreshold, setThemeOverviewThreshold] = useState(DEFAULT_THEME_OVERVIEW_THRESHOLD)
  const pickMapLayout = (layout: MapLayout): void => {
    setMapLayout(layout)
    saveMapLayout(layout)
  }
  // A finished distill run, shown as its own map; and live progress while running.
  const [distillRun, setDistillRun] = useState<{
    runId: string
    opening: number
  } | null>(null)
  // Keep the originating map mounted while a reader follows notes in the editor.
  const [readerOrigin, setReaderOrigin] = useState<{
    book: typeof distillRun
    trigger?: HTMLElement | SVGElement
  } | null>(null)
  const [graphOpening, setGraphOpening] = useState(0)
  const mapLauncher = useRef<HTMLElement | SVGElement | null>(null)
  const focusOnClose = useRef<(() => HTMLElement | SVGElement | null) | null>(null)
  useLayoutEffect(() => {
    const restore = focusOnClose.current
    if (restore && !graphOpen && !distillRun) {
      focusOnClose.current = null
      restore()?.focus({ preventScroll: true })
    }
  }, [graphOpen, distillRun])
  const closeMap = (): void => {
    const run = distillRun
    const launcher = mapLauncher.current
    focusOnClose.current = () => {
      if (run) {
        const row = document.querySelector<HTMLElement>(`.run-item[data-run-id="${CSS.escape(run.runId)}"] .run-item-open`)
        if (row && row.getClientRects().length) return row
      } else if (launcher?.isConnected && launcher.getClientRects().length) return launcher
      return document.querySelector<HTMLElement>('.graph-open-btn') ?? document.querySelector<HTMLElement>('.vault-map-link')
    }
    setDistillRun(null)
    setGraphOpen(false)
  }
  const [citationOrigin, setCitationOrigin] = useState<{
    note: MarkdownFile; citation: number; scrollTop: number
  } | null>(null)
  const restoreCitation = useRef<typeof citationOrigin>(null)
  const returnFocus = useRef<{ trigger?: HTMLElement | SVGElement } | null>(null)
  const bookOpening = useRef(0)
  const currentDistillRun = useRef(distillRun)
  currentDistillRun.current = distillRun
  const [runMerge, setRunMerge] = useState<{
    run: NonNullable<typeof distillRun>
    status: DistillMergeStatus
    dismissed: boolean
  } | null>(null)
  const mergeRead = useRef(0)
  // The merge dialog's plan: what merging this run would do, fetched before the
  // confirm so the user decides with the collisions in front of them.
  const [mergePlan, setMergePlan] = useState<{
    run: NonNullable<typeof distillRun>
    plan: DistillMergePlan
  } | null>(null)
  // What just happened to the last distill run: how many notes were staged (and
  // why zero, when zero) plus the sampling-coverage honesty note — or that the
  // run was cancelled, or its merge undone.
  const [distillDoneNote, setDistillDoneNote] = useState<string | null>(null)
  // Staged (unmerged or merged) distill runs, listed in the sidebar so a run
  // is never lost once its map is closed.
  const [stagedRuns, setStagedRuns] = useState<DistillRunInfo[]>([])
  const currentRuns = useRef<DistillRunInfo[]>([])
  const runListRequest = useRef(0)
  const discardingRuns = useRef(new Set<string>())
  const activeDistill = useRef<ActiveDistill | null>(null)
  const [distilling, setDistilling] = useState<{
    runId?: string
    phase: string
    done: number
    total: number
    pausing?: boolean
    settled?: boolean
  } | null>(null)
  // What the run ahead will cost, worked out from the document before it starts
  // (shown on the progress toast, so "reading a book" is never a black box).
  const pendingImport = useRef<string | null>(null)
  const pickingImport = useRef(false)
  const [importDocument, setImportDocument] = useState<DistillDocument | null>(null)
  const [distillEstimate, setDistillEstimate] = useState<DistillEstimate | null>(null)
  const talk = useTalk()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
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
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  // `seq` is what gives the rendered <Prompt> its key. Without it React reuses
  // the mounted instance when one prompt replaces another, and the new dialog
  // opens holding the previous one's typed text — a half-typed note name became
  // the focus of a distill run. `openPrompt` stamps it, so no caller can forget.
  const promptSeq = useRef(0)
  const [prompt, setPrompt] = useState<(PromptRequest & { seq: number }) | null>(null)
  const openPrompt = useCallback((p: PromptRequest): void => {
    setPrompt({ ...p, seq: ++promptSeq.current })
  }, [])
  const [confirm, setConfirm] = useState<{
    message: string
    confirmLabel?: string
    importId?: string
    discardRunId?: string
    onConfirm: () => void
  } | null>(null)
  const [savePrompt, setSavePrompt] = useState<{
    seq: number
    message: string
    saveLabel: string
    canDiscard: boolean
    resolve: (decision: 'save' | 'discard' | 'cancel') => void
  } | null>(null)
  const navigation = useRef(false)
  const navigationVersion = useRef(0)
  const [navigating, setNavigating] = useState(false)
  // The markdown view mode (Code / Live / Reading), persisted across file switches.
  const [editorMode, setEditorMode] = useState<ViewMode>('live')
  const settingsRef = useRef<Settings | null>(null)
  // Off-screen container that holds the fully-rendered note for Print / Export-PDF.
  const printRef = useRef<HTMLDivElement | null>(null)
  // The sidebar search box, so File ▸ Find Note… (⌘K) can focus it.
  const searchList = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // Non-blocking syntax feedback for the settings editor (set on save).
  const [settingsError, setSettingsError] = useState<string | null>(null)
  // Where to scroll the Help doc on open (Help ▸ Keyboard Shortcuts).
  const [helpReveal, setHelpReveal] = useState<{ from: number; to: number } | null>(null)

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
    const prev = settingsRef.current
    settingsRef.current = s
    setThemeOverviewThreshold(s.distill.themeOverviewThreshold)
    if (prev?.talk.chat.provider !== s.talk.chat.provider) void talk.refreshCanAsk()
    applyTheme(resolveThemeName(s), s.editor.fontSize)
    setAutosave({ delayMs: s.editor.autosaveDelayMs, onSwitch: s.editor.autosaveOnSwitch })
    setTelemetryOn(s.telemetry.enabled)
    // The quick selector collapses the theme config to system / dark / light.
    setThemeMode(s.theme.followSystem ? 'system' : getTheme(s.theme.name).dark ? 'dark' : 'light')
    // A live [talk.embed] change (settings save or "Reset to defaults"; prev is
    // null on the mount-time load, where the enable path handles it). Deferred
    // while a distill run is embedding — swapping models mid-run would mix two
    // vector spaces inside one clustering.
    const modelChanged = prev !== null && prev.talk.embed.model !== s.talk.embed.model
    const threadsChanged = prev !== null && prev.talk.embed.threads !== s.talk.embed.threads
    if (modelChanged || threadsChanged) {
      pendingEmbedSwap.current = {
        modelChanged: modelChanged || pendingEmbedSwap.current?.modelChanged === true
      }
      if (!activeDistill.current) runPendingEmbedSwap()
    }
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

  // A [talk.embed] settings change waiting to be applied. A ref (nothing
  // renders it), checked against activeDistill so a change saved mid-distill
  // is deferred to the run's end — swapping the embedder inside one run would
  // cluster vectors from two different models. `modelChanged` is sticky across
  // coalesced changes: any model change in the batch means a full re-index.
  const pendingEmbedSwap = useRef<{ modelChanged: boolean } | null>(null)
  const runPendingEmbedSwap = (): void => {
    const swap = pendingEmbedSwap.current
    if (!swap) return
    pendingEmbedSwap.current = null
    void talk.onEmbedConfigChanged(swap.modelChanged)
  }
  const distillBusy = distilling !== null
  useEffect(() => {
    if (!activeDistill.current) runPendingEmbedSwap()
    // runPendingEmbedSwap is stable enough (talk callbacks are memoized); this
    // must fire exactly on distill-run boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distillBusy])

  // Answer distill's embed requests with the renderer's WASM embedder (the same
  // one "talk" uses). Main bridges here because the embedder lives in the
  // renderer; this keeps a distilled run's chunks off the canonical store.
  useEffect(() => {
    return window.nodebook.onDistillEmbedRequest(async (texts) => {
      const model = settingsRef.current?.talk.embed.model ?? DEFAULT_EMBED_MODEL
      const emb = await getEmbedder(model, { threads: settingsRef.current?.talk.embed.threads })
      const vecs = await emb.embed(texts)
      return vecs.map((v) => Array.from(v))
    })
  }, [])

  const askToSave = useCallback(
    (message: string, saveLabel: string, canDiscard: boolean) =>
      new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
        setSavePrompt({
          seq: ++promptSeq.current,
          message,
          saveLabel,
          canDiscard,
          resolve: (decision) => {
            setSavePrompt(null)
            resolve(decision)
          }
        })
      }),
    []
  )

  const saveDocument = useCallback(
    async (path: string, name: string, content: string, expected: string | null) => {
      try {
        for (;;) {
          const result = await window.nodebook.saveFile(path, content, expected)
          if (result.status === 'saved') return true
          const decision = await askToSave(
            result.content === null
              ? `“${name}” was removed from disk while you were editing. Restore it with your version?`
              : `“${name}” changed on disk while you were editing. Overwrite it with your version?`,
            result.content === null ? 'Restore' : 'Overwrite',
            false
          )
          if (decision !== 'save') return false
          // Only overwrite the version for which the user just gave approval.
          expected = result.content
        }
      } catch (err) {
        setError(`Couldn't save “${name}”: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },
    [askToSave]
  )

  const noteSaver = useDirtyDoc({
    docKey: active ? `${active.path}#${noteEpoch}` : null,
    initialDoc: doc,
    persist: (content, expected) =>
      active ? saveDocument(active.path, active.name, content, expected) : Promise.resolve(false),
    autosaveDelayMs: autosave.delayMs
  })

  const configSaver = useDirtyDoc({
    docKey: settingsPath == null ? null : `${settingsPath}#${settingsEpoch}`,
    initialDoc: settingsDoc,
    persist: async (content, expected) => {
      if (!settingsPath || !(await saveDocument(settingsPath, 'Settings', content, expected))) {
        return false
      }
      try {
        setSettingsError(await window.nodebook.validateSettings(content))
        applySettings(await window.nodebook.readSettings())
      } catch (err) {
        setError(`Settings were saved but could not be applied: ${String(err)}`)
      }
      return true
    },
    autosaveDelayMs: autosave.delayMs
  })
  const { hasChanges: configHasChanges } = configSaver

  const noteVisible =
    active !== null && doc !== null && !settingsOpen && !helpOpen && !askOpen && !distillRun && !graphOpen
  const canSave = noteVisible || (settingsOpen && settingsDoc !== null)

  const saveCurrent = useCallback(() => {
    if (navigation.current || !canSave) return
    void (settingsOpen ? configSaver : noteSaver).saveNow()
  }, [canSave, settingsOpen, configSaver, noteSaver])

  // Keep the current editor mounted and pause edits until the save decision
  // and the navigation complete. Cancel or a write failure leaves it intact.
  const navigate = useCallback(
    async <T,>(action: () => T | Promise<T>, reason?: 'close' | 'discard-note'): Promise<T | null> => {
      if (navigation.current) return null
      navigation.current = true
      navigationVersion.current += 1
      setNavigating(true)
      let approved = false
      try {
        const useConfig = settingsOpen && reason !== 'discard-note'
        const saver = useConfig ? configSaver : noteSaver
        const pending = saver.pauseAutosave()
        let discard = false
        if (pending) {
          if (!(await pending)) return null
        } else if (saver.hasChanges()) {
          let decision: 'save' | 'discard' | 'cancel' = 'save'
          if (reason === 'discard-note') decision = 'discard'
          else if (!autosave.onSwitch) {
            decision = await askToSave(
              `Save your changes to “${useConfig ? 'Settings' : active?.name}”?`,
              'Save',
              true
            )
          }
          if (decision === 'cancel' || (decision === 'save' && !(await saver.saveNow()))) return null
          discard = decision === 'discard'
        }
        const result = await action()
        if (result !== null && discard) saver.discard()
        approved = result !== null
        return result
      } finally {
        // The native close acknowledgement is still in flight after we return.
        if (reason !== 'close' || !approved) {
          navigation.current = false
          setNavigating(false)
        }
      }
    },
    [settingsOpen, configSaver, noteSaver, autosave.onSwitch, askToSave, active]
  )

  // Native close and quit both wait for the renderer's normal save decision.
  // Keep the subscription mounted while renders update the decision callback.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => window.nodebook.onCloseRequested(async () => {
    return (await navigateRef.current(() => true, 'close')) === true
  }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (canSave && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveCurrent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canSave, saveCurrent])

  // Window title reflects unsaved state.
  const currentDirty = settingsOpen ? configSaver.dirty : noteSaver.dirty
  useEffect(() => {
    document.title = `${currentDirty ? '● ' : ''}Nodebook`
  }, [currentDirty])

  const replaceRuns = useCallback((runs: DistillRunInfo[]) => {
    currentRuns.current = runs
    setStagedRuns(runs)
  }, [])

  const refreshRuns = useCallback(async (owner = currentVault.current) => {
    if (!owner || currentVault.current !== owner || switchingVault.current) return
    const request = ++runListRequest.current
    const isCurrent = (): boolean =>
      currentVault.current === owner && !switchingVault.current && runListRequest.current === request
    try {
      const runs = await window.nodebook.distillListRuns()
      if (isCurrent()) replaceRuns(runs)
    } catch (err) {
      if (isCurrent()) setError(`Couldn't list distilled runs: ${String(err)}`)
    }
  }, [replaceRuns])

  const enterVault = useCallback(
    (dir: string) => navigate(async () => {
      const switching = dir !== currentVault.current?.dir
      switchingVault.current = switching
      try {
        const listing = await window.nodebook.openVault(dir)
        if (switching) {
          currentVault.current = { dir }
          replaceRuns([])
          discardingRuns.current = new Set()
          setDistillDoneNote(null)
        }
        switchingVault.current = false
        setReaderOrigin(null)
        setCitationOrigin(null)
        pendingImport.current = null
        setImportDocument(null)
        setViewFigure(null)
        setPreparingImport(null)
        setConfirm((request) => request?.importId || (switching && request?.discardRunId) ? null : request)
        setVault(dir)
        setActive(null)
        setDoc(null)
        setSettingsOpen(false)
        setHelpOpen(false)
        setAskOpen(false)
        setGraphOpen(false)
        setQuery('')
        setFiles(listing.files)
        setDirs(listing.dirs)
        setDistillRun(null)
        await Promise.all([
          window.nodebook.noteNames().then(setNoteNames),
          refreshRuns()
        ])
        talk.onVaultOpened() // resume embedding for the newly-opened vault
        return true
      } catch (err) {
        switchingVault.current = false
        if (switching) void refreshRuns()
        setError(`Couldn't open vault: ${String(err)}`)
        return null
      }
    }),
    [navigate, refreshRuns, replaceRuns, talk]
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

  // Reload a *clean* open buffer when its file changes on disk (an external
  // edit, or a relation typed from the map). Content is compared first, so our
  // own save echoing back through the watcher is a no-op. A dirty buffer is
  // left alone — that conflict is handled at save time (see noteSaver).
  const { hasChanges: noteHasChanges, getContent: getNoteContent } = noteSaver
  useEffect(() => {
    let ignore = false
    const unsubscribe = window.nodebook.onFileChanged((path) => {
      if (!active || path !== active.path || navigation.current || noteHasChanges()) return
      void window.nodebook
        .readFile(path)
        .then((content) => {
          if (ignore || navigation.current || noteHasChanges() || content === getNoteContent()) return
          setDoc(content)
          setNoteEpoch((e) => e + 1) // remount the editor on the fresh bytes
        })
        .catch(() => {
          // vanished mid-read — the vault:changed relist will reconcile
        })
    })
    return () => {
      ignore = true
      unsubscribe()
    }
  }, [active, noteHasChanges, getNoteContent])

  const readAndOpen = useCallback(
    async (f: MarkdownFile) => {
      try {
        const content = await window.nodebook.readFile(f.path)
        setActive(f)
        setDoc(content)
        setPendingReveal(null)
        setCitationOrigin(null)
        setNoteEpoch((e) => e + 1)
        setSettingsOpen(false)
        setHelpOpen(false)
        setAskOpen(false)
        setError(null)
        return content
      } catch {
        // The file was moved/deleted out from under us — surface it calmly and
        // refresh the tree rather than letting a raw rejection bubble up.
        setError(`Couldn't open "${f.name}" — it may have been moved or deleted.`)
        void relist()
        return null
      }
    },
    [relist]
  )

  const openFile = useCallback(
    (f: MarkdownFile, destination: 'editor' | 'graph' | 'new-map' = 'editor',
      trigger?: HTMLElement | SVGElement) => navigate(async () => {
      const content = await readAndOpen(f)
      if (content === null) return null
      if (destination === 'editor') {
        if (distillRun || graphOpen) {
          setReaderOrigin({ book: distillRun, trigger: trigger ?? visibleMapControl() })
        }
        setGraphOpen(false)
      } else {
        setReaderOrigin(null)
        setMapAnchor(f)
        setStartGlobal(false)
        if (destination === 'new-map') {
          mapLauncher.current = trigger ?? null
          setGraphOpening((n) => n + 1)
        }
        setGraphOpen(true)
      }
      setDistillRun(null)
      return content
    }),
    [navigate, readAndOpen, graphOpen, distillRun]
  )

  const { ready: talkReady, searchSemantic } = talk
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setFigureHits([])
      return
    }
    let ignore = false
    const t = setTimeout(async () => {
      // When semantic search is live, fuse keyword + meaning; else keyword only.
      const [hits, figures] = await Promise.all([
        talkReady ? searchSemantic(q) : window.nodebook.search(q),
        window.nodebook.searchFigures(q).catch(() => [])
      ])
      if (!ignore) {
        setResults(hits)
        setFigureHits(figures)
      }
    }, 150)
    return () => {
      ignore = true
      clearTimeout(t)
    }
  }, [query, talkReady, searchSemantic])

  const noteByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  const openPathInEditor = useCallback((path: string, trigger?: HTMLElement | SVGElement): void => {
    const file = noteByPath.get(path)
    if (file) void openFile(file, 'editor', trigger)
    else setError(`Couldn't open the selected note — it may have been moved or deleted.`)
  }, [noteByPath, openFile])
  const backToMap = (): void => {
    if (!readerOrigin) return
    void navigate(() => {
      setCitationOrigin(null)
      returnFocus.current = { trigger: readerOrigin.trigger }
      setDistillRun(readerOrigin.book)
      setGraphOpen(readerOrigin.book === null)
      setReaderOrigin(null)
      return true
    })
  }
  useLayoutEffect(() => {
    if (!returnFocus.current || navigating) return
    const { trigger } = returnFocus.current
    returnFocus.current = null
    const target = trigger?.isConnected && !trigger.closest('[hidden]') ? trigger :
      visibleMapControl()
    target?.focus({ preventScroll: true })
  }, [navigating, readerOrigin])

  const resolveTarget = useMemo(() => targetResolver([...noteByPath.keys()]), [noteByPath])
  const resolveFile = useCallback(
    (target: string) => noteByPath.get(resolveTarget(target, active?.path ?? '').id),
    [noteByPath, resolveTarget, active?.path]
  )
  const openLink = useCallback(
    (target: string) => {
      const file = resolveFile(target)
      if (file) void openFile(file)
    },
    [resolveFile, openFile]
  )
  const linkExists = useCallback((target: string) => !!resolveFile(target), [resolveFile])

  // Provenance: a distilled note carries `cite:` spans in its frontmatter.
  // Clicking one opens its source note scrolled to + selecting the cited range.
  const citations = useMemo<NoteCitation[]>(
    () => (active ? parseCitations(doc ?? '') : []),
    [active, doc]
  )
  // A `kind: document` note IS a converted book, and remembers the file it came
  // from — that is what "Open original" opens. The renderer only ever hands
  // main the HASH; main owns the path (see `distill:openOriginal`).
  const sourceDocument = useMemo<NoteDocument | null>(
    () => (active ? parseDocumentNote(doc ?? '') : null),
    [active, doc]
  )
  const openOriginal = useCallback(() => {
    const hash = sourceDocument?.hash
    if (!hash) return
    void window.nodebook.distillOpenOriginal(hash).then((err) => {
      if (err) setError(err)
    })
  }, [sourceDocument])
  // Self-healing: the recorded [start,end) can drift once the source note is
  // edited after a distill run. Re-verify against the source's current
  // content before revealing — relocate via the quote if it moved, or open
  // without a selection (and say so) if it can't be found at all. A citation
  // from before quotes were captured (c.quote undefined) is trusted as-is.
  const backToCitingNote = (): void => {
    if (!citationOrigin) return
    void navigate(async () => {
      if (await readAndOpen(citationOrigin.note) === null) return null
      restoreCitation.current = citationOrigin
      return true
    })
  }
  useLayoutEffect(() => {
    if (navigating || !restoreCitation.current) return
    const entry = restoreCitation.current
    const frame = requestAnimationFrame(() => {
      restoreCitation.current = null
      const scroller = document.querySelector('.note-content .cm-scroller')
      if (scroller) scroller.scrollTop = entry.scrollTop
      document.querySelectorAll<HTMLElement>('.sources .source-cite')[entry.citation]?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [navigating, active?.path])
  const openCitation = useCallback(
    (c: NoteCitation, citationIndex: number) => {
      const f = resolveFile(c.source)
      if (!f || !active) return
      const scrollTop = document.querySelector('.note-content .cm-scroller')?.scrollTop ?? 0
      const origin = { note: active, citation: citationIndex, scrollTop }
      void openFile(f).then((content) => {
        if (content === null) return
        setCitationOrigin(origin)
        const res = resolveCitationSpan(content, c)
        if (res.status === 'not-found') {
          setPendingReveal(null)
          setError(`Couldn't locate the cited passage in "${f.name}" — the source may have changed.`)
        } else {
          setPendingReveal({ path: f.path, from: res.start, to: res.end })
        }
      })
    },
    [resolveFile, openFile, active]
  )
  const openAskPassage = useCallback(
    (c: Citation): void => {
      const f = files.find((x) => x.path === c.path)
      if (!f) {
        setError(`Couldn't open "${c.title}" — it may have been moved or deleted.`)
        return
      }
      void openFile(f).then((content) => {
        if (content === null) return
        const res = resolveAskPassage(content, c)
        if (res) {
          setPendingReveal({ path: c.path, from: res.start, to: res.end })
        } else {
          setPendingReveal(null)
          setError(`Couldn't locate the cited passage in "${c.title}" — the source may have changed.`)
        }
      })
    },
    [files, openFile]
  )
  const revealRange = useMemo(
    () =>
      active && pendingReveal && pendingReveal.path === active.path
        ? { from: pendingReveal.from, to: pendingReveal.to }
        : null,
    [active, pendingReveal]
  )

  const openSettings = useCallback(() => {
    if (settingsOpen) return
    void navigate(async () => {
      try {
        const p = await window.nodebook.settingsPath()
        const content = await window.nodebook.readFile(p)
        setSettingsPath(p)
        setSettingsDoc(content)
        setSettingsEpoch((e) => e + 1)
        setSettingsError(null) // fresh open — feedback comes from the next save
        setDefaultsDoc(null) // start with the defaults reference hidden
        setSettingsOpen(true)
        setHelpOpen(false)
        setGraphOpen(false)
        setAskOpen(false)
        return true
      } catch (err) {
        setError(`Couldn't open settings: ${String(err)}`)
        return null
      }
    })
  }, [navigate, settingsOpen])

  // Explicitly recenter the vault map on a different note.
  const openPathInGraph = useCallback(
    (path: string) => {
      const f = noteByPath.get(path)
      if (f) void openFile(f, 'graph')
    },
    [noteByPath, openFile]
  )

  const openHelp = useCallback(
    (section?: string) => {
      void navigate(() => {
        setGraphOpen(false)
        setSettingsOpen(false)
        setAskOpen(false)
        // Help ▸ Keyboard Shortcuts opens the same doc scrolled to its section.
        if (section === 'shortcuts') {
          const at = HELP_DOC.indexOf('## Keyboard shortcuts')
          setHelpReveal(at >= 0 ? { from: at, to: at } : null)
        } else {
          setHelpReveal(null)
        }
        setHelpOpen(true)
      })
    },
    [navigate]
  )

  const openAsk = useCallback(() => {
    void navigate(() => {
      setGraphOpen(false)
      setSettingsOpen(false)
      setHelpOpen(false)
      setAskOpen(true)
    })
  }, [navigate])

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
  const fillPrint = useCallback(async () => {
    const container = printRef.current
    if (!container || !active) return false
    const generation = ++printGeneration.current
    container.innerHTML = renderMarkdown(noteSaver.getContent() ?? doc ?? '', { path: active.path, print: true })
    const figures = Array.from(container.querySelectorAll<HTMLImageElement>('img[src^="nodebook-figure:"]'))
    await Promise.allSettled(figures.map((image) => image.decode()))
    return printRef.current === container && printGeneration.current === generation
  }, [noteSaver, doc, active])

  useLayoutEffect(() => { printGeneration.current++ }, [active?.path])

  const exportPdf = useCallback(async () => {
    if (!await fillPrint()) return
    await window.nodebook.exportPdf(active?.name ?? 'note')
    // Empty the imperatively-filled container once the PDF is written — the
    // rendered HTML must not linger in the DOM (React doesn't know about it).
    if (printRef.current) printRef.current.innerHTML = ''
  }, [fillPrint, active])

  // Same cleanup for ⌘P: the browser fires afterprint when the dialog closes.
  useEffect(() => {
    const clear = (): void => {
      if (printRef.current) printRef.current.innerHTML = ''
    }
    window.addEventListener('afterprint', clear)
    return () => window.removeEventListener('afterprint', clear)
  }, [])

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
  const activeRef = useRef(active)
  activeRef.current = active
  const activeWithin = (target: ContextTarget): MarkdownFile | null => {
    const note = activeRef.current
    if (!note) return null
    if (target.kind === 'file' && target.file.path === note.path) return note
    if (target.kind === 'folder' && note.rel.startsWith(`${target.path}/`)) return note
    return null
  }

  const newNoteIn = useCallback(
    (dir: string): void => {
      openPrompt({
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
    },
    [relist, openFile, openPrompt]
  )

  const newFolderIn = (dir: string): void => {
    openPrompt({
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
    openPrompt({
      title: 'Rename',
      initialValue: labelOf(target),
      confirmLabel: 'Rename',
      onConfirm: (name) => {
        setPrompt(null)
        const affected = activeWithin(target)
        const rename = async (): Promise<true | null> => {
          let movedActive = false
          try {
            const newPath = await window.nodebook.rename(oldPath, name)
            if (!newPath || newPath === oldPath) return null
            movedActive = affected !== null
            const listed = await relist()
            if (affected) {
              const moved = `${newPath}${affected.path.slice(oldPath.length)}`
              const file = listed.find((f) => f.path === moved)
              if (!file || (await readAndOpen(file)) === null) {
                setActive(null)
                setDoc(null)
              }
            }
            return true
          } catch (err) {
            if (movedActive) {
              setActive(null)
              setDoc(null)
            }
            setError(`Couldn't rename “${labelOf(target)}”: ${String(err)}`)
            return null
          }
        }
        if (affected) void navigateRef.current(rename)
        else void rename()
      }
    })
  }

  const deleteTarget = (target: ContextTarget): void => {
    const path = pathOf(target)
    const label = labelOf(target)
    const note = activeWithin(target)
    const hasDraft = note !== null && noteHasChanges()
    setConfirm({
      message: hasDraft
        ? `Move “${label}” to the Trash and discard unsaved changes to “${note.name}”?`
        : `Move “${label}” to the Trash?`,
      confirmLabel: 'Move to Trash',
      onConfirm: () => {
        setConfirm(null)
        const affected = activeWithin(target)
        if (affected && noteHasChanges() && affected.path !== (hasDraft ? note.path : null)) {
          deleteTarget(target)
          return
        }
        const remove = async (): Promise<true | null> => {
          try {
            if (!(await window.nodebook.deletePath(path))) {
              setError(`Couldn't move “${label}” to the Trash.`)
              return null
            }
            if (affected) {
              setActive(null)
              setDoc(null)
            }
            await relist()
            return true
          } catch (err) {
            setError(`Couldn't finish moving “${label}” to the Trash: ${String(err)}`)
            return null
          }
        }
        if (affected) void navigateRef.current(remove, 'discard-note')
        else void remove()
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

  // The native menu follows the visible pane, since maps can keep a note open
  // behind them. Main rebuilds it only when availability changes.
  useEffect(() => {
    window.nodebook.setMenuState({
      hasVault: vault !== null,
      hasNote: noteVisible,
      canSave,
      canAsk: talk.canAsk,
      distilling: distillBusy
    })
  }, [vault, noteVisible, canSave, talk.canAsk, distillBusy])

  const startDistilling = useCallback(
    async (start: () => Promise<DistillRunResult>, options: {
      runId?: string
      estimate?: DistillEstimate
    }) => {
      const owner = currentVault.current
      if (!owner || switchingVault.current || activeDistill.current) return
      const claim: ActiveDistill = { runId: options.runId, pausing: false, settled: false }
      const startView = navigationVersion.current
      const inCurrentVault = (): boolean => currentVault.current === owner && !switchingVault.current
      // Disable all start paths before React commits the busy state.
      activeDistill.current = claim
      setDistilling({ runId: claim.runId, phase: claim.runId ? 'resuming' : 'starting', done: 0, total: 0 })
      setDistillEstimate(options.estimate ?? null)
      setDistillDoneNote(null)
      let off: (() => void) | undefined
      try {
        off = window.nodebook.onDistillProgress((runId, p) => {
          if (activeDistill.current !== claim || claim.settled || !inCurrentVault()) return
          if (claim.runId && claim.runId !== runId) return
          claim.runId = runId
          const phase = options.runId && p.phase === 'starting' ? 'resuming' : p.phase
          setDistilling({ runId, phase, done: p.done, total: p.total, pausing: claim.pausing })
        })
        const res = await start()
        if (!inCurrentVault()) return
        // A delayed or failed list refresh must never make a completed run resumable again.
        replaceRuns(currentRuns.current.map((run) => run.id === res.runId
          ? { ...run, notes: res.stats.notes, unfinished: false }
          : run))
        if (navigationVersion.current === startView && !navigation.current && !noteHasChanges() && !configHasChanges()) {
          setGraphOpen(false)
          setAskOpen(false)
          setReaderOrigin(null)
          setDistillRun({ runId: res.runId, opening: ++bookOpening.current })
        }
        // Always say what happened: the run is STAGED, not in the vault — and a
        // zero-note run must explain itself instead of showing a blank map.
        const s = res.stats
        // What the quote check did, in plain words — the same list explains a
        // zero-note run and annotates a good one, so a drop is never silent.
        const why: string[] = []
        const d = s.droppedByReason
        if (d.noEvidence > 0) why.push(`${d.noEvidence} point${d.noEvidence === 1 ? '' : 's'} had no quote`)
        if (d.notFound > 0)
          why.push(
            `${d.notFound} quote${d.notFound === 1 ? " wasn't" : "s weren't"} found in the document`
          )
        if (d.ambiguous > 0)
          why.push(
            `${d.ambiguous} quote${d.ambiguous === 1 ? '' : 's'} matched in more than one place`
          )
        if (s.recovered > 0)
          why.push(
            `${s.recovered} quote${s.recovered === 1 ? ' was' : 's were'} found under a different passage and kept`
          )
        if (s.failedWindows > 0)
          why.push(`${s.failedWindows} of ${s.windows} steps got an unusable model response`)
        const read = s.coverage === 1 ? 'all' : `about ${Math.round(s.coverage * 100)}%`
        const preserved = res.figures?.length ?? 0
        const onlyFigures = preserved > 0 && s.chunks === 0
        const summary = s.notes === 0
          ? 'No notes were staged with matching source quotes.'
          : `Staged ${s.notes} note${s.notes === 1 ? '' : 's'}. Choose Merge to add them to your vault.`
        setDistillDoneNote([
          onlyFigures ? 'Staged the source document and its figures. Choose Merge to add them to your vault.' : summary,
          res.pdf && describePdfExtraction(res.pdf),
          figureCoverageText(preserved, res.figureCoverage?.skipped, res.figureCoverage?.uninspectedPages),
          onlyFigures ? 'There were no passages of authored text to distill.' : `The model read ${read} of the extracted text.`,
          ...why
        ].filter(Boolean).join(' '))
      } catch (e) {
        if (!inCurrentVault()) return
        // Cancelling is a choice, not a fault — say what happened, don't alarm.
        // A cancelled run is PAUSED, not lost: what it already read is kept.
        if (claim.pausing) {
          setDistillDoneNote(
            'Distilling paused. Completed steps are saved. Choose Resume under “Distilled runs” to continue.'
          )
        } else setError(e instanceof Error ? e.message : String(e))
      } finally {
        claim.settled = true
        off?.()
        if (activeDistill.current === claim) {
          setDistilling((progress) => progress && { ...progress, settled: true })
          // Keep the controls locked until the sidebar knows which runs can resume.
          await refreshRuns(owner)
          activeDistill.current = null
          setDistilling(null)
          setDistillEstimate(null)
        }
      }
    },
    [configHasChanges, noteHasChanges, refreshRuns, replaceRuns]
  )

  const pauseDistilling = useCallback(async () => {
    const claim = activeDistill.current
    if (!claim?.runId || claim.pausing || claim.settled || switchingVault.current) return
    claim.pausing = true
    setDistilling((progress) => progress && { ...progress, pausing: true })
    try {
      await window.nodebook.distillCancel(claim.runId)
    } catch (err) {
      if (activeDistill.current !== claim || claim.settled || switchingVault.current) return
      claim.pausing = false
      setDistilling((progress) => progress && { ...progress, pausing: false })
      setError(`Couldn't pause distilling: ${String(err)}`)
    }
  }, [])

  const discardImport = useCallback((id: string) => {
    if (pendingImport.current === id) pendingImport.current = null
    setPreparingImport((pending) => pending === id ? null : pending)
    void window.nodebook.distillDiscardPick(id).catch(() => {})
  }, [])

  // Price the run, warn if it needs more steps than the budget allows, then go.
  // The focus is passed to both halves so the estimate is made against the same
  // prompt the run will send.
  const estimateThenRun = useCallback(
    async (docId: string, focus: string, encoding?: string, previewed?: DistillEstimate) => {
      // Text imports use the exact preview the reader approved. Other formats
      // are prepared here after the focus has been chosen.
      let est: DistillEstimate
      setPreparingImport(docId)
      try {
        est = previewed && !focus ? previewed :
          await window.nodebook.distillEstimate(docId, focus, encoding, previewed?.preparedId)
      } catch (err) {
        if (pendingImport.current !== docId) return
        discardImport(docId)
        setError(`Couldn’t prepare this import. ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (pendingImport.current !== docId) return
      setPreparingImport(null)
      const go = async (): Promise<void> => {
        if (pendingImport.current !== docId) return
        pendingImport.current = null
        try {
          if (activeDistill.current) {
            setError('A document is already being distilled. Try again after it finishes or pauses.')
            return
          }
          await startDistilling(() => window.nodebook.distillRun(docId, focus, encoding, est.preparedId), {
            estimate: est
          })
        } finally {
          discardImport(docId)
        }
      }
      const sampled = est.totalWindows > est.maxCalls
      if (sampled || est.pdf?.missing.length || est.figureCoverage?.skipped || est.figureCoverage?.uninspectedPages) {
        const steps = sampled
          ? `This document needs ${est.totalWindows} steps. Your budget covers ${est.calls} evenly spaced steps, about ${Math.round(est.coverage * 100)}% of the extracted text.`
          : est.calls === 0 && est.figures?.length ? 'Save the source document and its figures without a model call?' :
            `Read the extracted text in ${est.calls} step${est.calls === 1 ? '' : 's'}?`
        setConfirm({
          importId: docId,
          message: [est.pdf && describePdfExtraction(est.pdf),
            figureCoverageText(est.figures?.length, est.figureCoverage?.skipped, est.figureCoverage?.uninspectedPages),
            steps].filter(Boolean).join(' '),
          confirmLabel: sampled ? `Read ${est.calls} steps` : est.calls === 0 && est.figures?.length ? 'Save figures' : 'Continue with extracted text',
          onConfirm: () => {
            setConfirm(null)
            void go()
          }
        })
        return
      }
      await go()
    },
    [startDistilling, discardImport]
  )

  const runDistill = useCallback(async () => {
    const owner = currentVault.current
    if (!owner || switchingVault.current || activeDistill.current || pickingImport.current) return
    pickingImport.current = true
    try {
      // Main hands back an opaque id for the picked document, never a path.
      const doc = await window.nodebook.distillPick()
      if (!doc) return
      if (currentVault.current !== owner || switchingVault.current || activeDistill.current) {
        discardImport(doc.id)
        return
      }
      if (pendingImport.current) discardImport(pendingImport.current)
      pendingImport.current = doc.id
      setConfirm((request) => request?.importId ? null : request)
      setImportDocument(doc)
    } catch (err) {
      if (currentVault.current === owner && !switchingVault.current) {
        setError(`Couldn't pick a document: ${String(err)}`)
      }
    } finally {
      pickingImport.current = false
    }
  }, [discardImport])

  // Carry on a run that was cancelled or interrupted, from its own checkpoint.
  const resumeStagedRun = useCallback(
    (runId: string) => {
      if (discardingRuns.current.has(runId) || !currentRuns.current.some((r) => r.id === runId && r.unfinished)) return
      void startDistilling(() => window.nodebook.distillResume(runId), { runId })
    },
    [startDistilling]
  )

  // Reopen a staged run's map from the sidebar list (a closed run map used to
  // be unreachable — the run looked lost even though it was staged on disk).
  const openStagedRun = useCallback(
    (id: string) => {
      const owner = currentVault.current
      const canOpen = (): boolean => currentVault.current === owner && !switchingVault.current &&
        activeDistill.current?.runId !== id && !discardingRuns.current.has(id) &&
        currentRuns.current.some((run) => run.id === id && !run.unfinished)
      if (!canOpen()) return
      void navigate(() => {
        if (!canOpen()) return null
        setGraphOpen(false)
        setAskOpen(false)
        setHelpOpen(false)
        setSettingsOpen(false)
        setReaderOrigin(null)
        setDistillRun({ runId: id, opening: ++bookOpening.current })
      })
    },
    [navigate]
  )

  const discardStagedRun = useCallback(
    (run: DistillRunInfo) => {
      const owner = currentVault.current
      const canDiscard = (): boolean => currentVault.current === owner && !switchingVault.current &&
        activeDistill.current?.runId !== run.id && !discardingRuns.current.has(run.id) &&
        currentRuns.current.some((entry) => entry.id === run.id &&
          entry.unfinished === run.unfinished && entry.merged === run.merged)
      if (!canDiscard()) return
      setConfirm({
        discardRunId: run.id,
        message: run.unfinished
          ? `Discard the paused run “${run.id}”? What it has read so far is lost, and it can't be resumed.`
          : `Discard the distilled run “${run.id}”? Its staged notes are deleted${
              run.merged
                ? ' (notes already merged into your vault stay, but Undo stops working)'
                : ''
            }.`,
        confirmLabel: 'Discard',
        onConfirm: () => {
          setConfirm(null)
          if (!canDiscard()) return
          const removing = discardingRuns.current
          removing.add(run.id)
          void (async () => {
            try {
              await window.nodebook.distillRemove(run.id)
              if (currentVault.current !== owner || switchingVault.current) return
              replaceRuns(currentRuns.current.filter(({ id }) => id !== run.id))
              setDistillRun((cur) => (cur?.runId === run.id ? null : cur))
              setReaderOrigin((cur) => cur?.book?.runId === run.id ? null : cur)
              await refreshRuns(owner)
            } catch (err) {
              if (currentVault.current === owner && !switchingVault.current) {
                setError(`Couldn't discard “${run.id}”: ${String(err)}`)
              }
            } finally {
              removing.delete(run.id)
            }
          })()
        }
      })
    },
    [refreshRuns, replaceRuns]
  )

  // Merge a run into the vault (an explicit, confirmed, reversible write). The
  // plan comes first: the dialog says what would happen — and, for a note whose
  // name you already use, asks whether the two are really the same thing.
  const [mergeBusy, setMergeBusy] = useState<{
    run: NonNullable<typeof distillRun>; label: string
  } | null>(null)
  const mergeStatus = runMerge?.run === distillRun ? runMerge : null
  const currentMergeWork = mergeBusy?.run === distillRun ? mergeBusy : null
  const mergeDistillRun = (): void => {
    if (!distillRun || !mergeStatus || mergeStatus.status.merged || currentMergeWork) return
    const work = { run: distillRun, label: 'Planning…' }
    setMergeBusy(work)
    void window.nodebook.distillMergePlan(distillRun.runId).then((plan) => {
      if (currentDistillRun.current === distillRun) setMergePlan({ run: distillRun, plan })
    }).catch((err) => {
      if (currentDistillRun.current === distillRun) setError(String(err))
    }).finally(() => setMergeBusy((active) => active === work ? null : active))
  }

  // A merge or undo can finish after the reader has moved to another book.
  const applyMergeStatus = (runId: string, status: DistillMergeStatus): void => {
    const displayed = currentDistillRun.current
    if (displayed?.runId !== runId) return
    mergeRead.current++
    setRunMerge({ run: displayed, status, dismissed: false })
  }
  const confirmMerge = async (runId: string, sameAs: string[]): Promise<void> => {
    if (!distillRun || distillRun.runId !== runId || currentMergeWork) return
    const owner = currentVault.current
    const work = { run: distillRun, label: 'Merging…' }
    setMergeBusy(work)
    setMergePlan(null)
    try {
      const res = await window.nodebook.distillMerge(runId, { sameAs })
      if (currentVault.current !== owner || switchingVault.current) return
      applyMergeStatus(runId, { merged: true, folder: res.folder, count: res.count })
      void refreshRuns(owner)
    } catch (err) {
      if (currentVault.current === owner && !switchingVault.current) setError(String(err))
    } finally {
      setMergeBusy((active) => active === work ? null : active)
    }
  }
  const undoMerge = async (): Promise<void> => {
    if (!distillRun || !mergeStatus?.status.merged || currentMergeWork) return
    const owner = currentVault.current
    const work = { run: distillRun, label: 'Undoing…' }
    setMergeBusy(work)
    try {
      const r = await window.nodebook.distillUnmerge(distillRun.runId)
      if (currentVault.current !== owner || switchingVault.current) return
      applyMergeStatus(distillRun.runId, { merged: false })
      if (currentDistillRun.current?.runId === distillRun.runId) {
        setDistillDoneNote(
          `Undone — ${r.removed} note${r.removed === 1 ? '' : 's'} removed` +
          (r.trashed > 0 ? `, ${r.trashed} edited note${r.trashed === 1 ? '' : 's'} moved to the Trash.` : '.')
        )
      }
      void refreshRuns(owner)
    } catch (err) {
      if (currentVault.current === owner && !switchingVault.current) setError(`Couldn't undo the merge: ${String(err)}`)
    } finally {
      setMergeBusy((active) => active === work ? null : active)
    }
  }

  useEffect(() => {
    const request = ++mergeRead.current
    setMergePlan(null)
    if (!distillRun) return
    const owner = currentVault.current
    const isCurrent = (): boolean => owner === currentVault.current && !switchingVault.current &&
      currentDistillRun.current === distillRun && request === mergeRead.current
    void window.nodebook.distillMergeStatus(distillRun.runId).then((status) => {
      if (isCurrent()) setRunMerge((previous) => ({
        run: distillRun, status,
        dismissed: previous?.run === distillRun && previous.status.merged && status.merged && previous.dismissed
      }))
    }).catch((err) => {
      if (isCurrent()) setError(`Couldn't read the run's merge status: ${String(err)}`)
    })
  }, [distillRun])

  const showActiveMap = useCallback((wholeVault = false) => {
    if (!wholeVault && !active) return
    void navigate(() => {
      setReaderOrigin(null)
      mapLauncher.current = wholeVault ? document.querySelector('.vault-map-link') : document.querySelector('.graph-open-btn')
      setMapAnchor(active)
      setStartGlobal(wholeVault)
      setSettingsOpen(false)
      setHelpOpen(false)
      setAskOpen(false)
      setDistillRun(null)
      setGraphOpening((n) => n + 1)
      setGraphOpen(true)
    })
  }, [active, navigate])

  useEffect(() => {
    return window.nodebook.onMenuCommand((cmd, arg) => {
      // ⌘E toggles writing (Live) ⇄ Reading; ⌘1/2/3 pick a mode.
      if (cmd === 'toggle-read' && noteVisible) setEditorMode((m) => (m === 'reading' ? 'live' : 'reading'))
      else if (cmd === 'mode-code' && noteVisible) setEditorMode('code')
      else if (cmd === 'mode-live' && noteVisible) setEditorMode('live')
      else if (cmd === 'mode-reading' && noteVisible) setEditorMode('reading')
      else if (cmd === 'help') openHelp(arg)
      else if (cmd === 'export-pdf' && noteVisible) void exportPdf()
      else if (cmd === 'print' && noteVisible) {
        void fillPrint().then((ready) => { if (ready) window.print() })
      } else if (cmd === 'save') {
        saveCurrent()
      } else if (cmd === 'settings') void openSettings()
      else if (cmd === 'new-vault') void newVault()
      else if (cmd === 'open-vault-dialog') void openVault()
      else if (cmd === 'open-vault') {
        if (arg) void enterVault(arg)
      } else if (cmd === 'new-note') {
        if (vault) newNoteIn(vault)
      } else if (cmd === 'find-note') {
        // ⌘K: jump to the sidebar search box (select so typing replaces).
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (cmd === 'map' && noteVisible) {
        showActiveMap()
      } else if (cmd === 'distill') {
        void runDistill()
      } else if (cmd === 'ask') {
        if (talk.canAsk) openAsk()
        else void openSettings()
      }
    })
  }, [
    exportPdf,
    fillPrint,
    openHelp,
    openSettings,
    openVault,
    newVault,
    enterVault,
    newNoteIn,
    openAsk,
    saveCurrent,
    vault,
    noteVisible,
    showActiveMap,
    talk.canAsk,
    runDistill
  ])

  // The right panel (backlinks) only shows when editing a note; collapse the grid
  // to two columns otherwise (map / settings / help / empty) so the centre fills
  // the width instead of leaving a blank third column.
  const showRightPanel = noteVisible
  const mapPaneVisible = !askOpen && !helpOpen && !settingsOpen
  const bookVisible = mapPaneVisible && !!distillRun
  const graphVisible = mapPaneVisible && graphOpen && !distillRun
  const mountedBook = distillRun ?? readerOrigin?.book
  const mountVaultMap = graphOpen || readerOrigin?.book === null
  const appControls = (
    <span className="app-controls">
      <StatusSelect kind="theme" prefix="Appearance: " title="App theme" value={themeMode}
        options={THEME_OPTIONS} onChange={pickThemeMode} />
      <TelemetryWidget enabled={telemetryOn} />
    </span>
  )
  const utilityFooter = !graphVisible && !bookVisible &&
    (settingsOpen || helpOpen || askOpen || !active || doc === null || active.rel.endsWith('.map.md'))

  return (
    <OpenFigure.Provider value={setViewFigure}>
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
          <div className="vault-heading">
            <div className="vault-path" title={vault}>{vault.split('/').pop()}</div>
            <button className="vault-map-link" type="button" onClick={() => showActiveMap(true)}>
              Whole vault map
            </button>
          </div>
        )}
        {vault && (
          <input
            ref={searchRef}
            className="search-box"
            placeholder={`Search notes…  ${navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl+K'}`}
            value={query}
            aria-label="Search notes"
            onChange={(e) => {
              setQuery(e.target.value)
              setResults([])
              setFigureHits([])
            }}
            onKeyDown={(e) => {
              if (!results.length && !figureHits.length) return
              const first = searchList.current?.querySelector<HTMLButtonElement>('.search-hit')
              if (e.key === 'ArrowDown' && first) {
                e.preventDefault()
                first.focus()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                first?.click()
              }
            }}
          />
        )}
        {vault && <TalkPanel talk={talk} distilling={distillBusy} />}
        {vault &&
          (talk.canAsk ? (
            <button className="ask-open-btn" onClick={openAsk}>
              💬 Ask your notes
            </button>
          ) : (
            // Same setup-CTA pattern as semantic search (shared styling, own
            // class): the feature is real but needs a provider — route to
            // Settings instead of hiding it.
            <button className="ask-cta" onClick={openSettings}>
              💬 Ask your notes — set up a chat provider{' '}
              <span className="talk-cta-note">
                (Ollama or your ChatGPT plan's Codex app work)
              </span>
            </button>
          ))}
        {vault && stagedRuns.length > 0 && (
          <div className="runs-section">
            <div className="runs-header">Distilled runs</div>
            {stagedRuns.map((r) => {
              const activity = distilling?.runId === r.id ? distilling : null
              const discardDisabled = !!activity || discardingRuns.current.has(r.id)
              const openDisabled = discardDisabled || (r.unfinished && distillBusy)
              let status = r.merged ? 'merged' : `${r.notes} note${r.notes === 1 ? '' : 's'}`
              if (r.unfinished) status = 'paused'
              if (activity) {
                status = activity.phase === 'resuming' ? 'resuming' : 'distilling'
                if (activity.settled) status = 'finishing'
                if (activity.pausing) status = 'pausing'
              }
              const open = (): void => {
                if (openDisabled) return
                if (r.unfinished) resumeStagedRun(r.id)
                else openStagedRun(r.id)
              }
              return (
                <div
                  key={r.id}
                  className="run-item" data-run-id={r.id}
                  role="group"
                  aria-label={`Distilled run ${r.id}`}
                  data-open-disabled={openDisabled}
                  tabIndex={-1}
                  onClick={(e) => {
                    if (e.detail <= 1 && !(e.target as HTMLElement).closest('button')) open()
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return
                    e.preventDefault()
                    open()
                  }}
                >
                  <button
                    className="run-item-open"
                    type="button"
                    aria-label={activity ? `${r.id}, ${status}` : `${r.unfinished ? 'Resume' : 'Open'} run ${r.id}`}
                    disabled={openDisabled}
                    onClick={(e) => {
                      if (e.detail <= 1) open()
                    }}
                  >
                    <span className="run-item-name" title={r.id}>{r.id}</span>
                    <span className="run-item-meta">{status}</span>
                  </button>
                  {r.unfinished && !activity && (
                    <button
                      className="run-item-resume"
                      type="button"
                      title="Carry on where this run stopped"
                      disabled={openDisabled}
                      onClick={(e) => {
                        if (e.detail <= 1) open()
                      }}
                    >
                      Resume
                    </button>
                  )}
                  <button
                    className="run-item-del"
                    type="button"
                    aria-label={`Discard run ${r.id}`}
                    title="Discard this staged run"
                    disabled={discardDisabled}
                    onClick={() => discardStagedRun(r)}
                  >
                    ✕
                  </button>
                  {r.focus && (
                    <span className="run-item-focus" title={r.focus}>
                      Focus: {r.focus}
                    </span>
                  )}
                  {!!r.themes?.length && (
                    <span className="run-item-themes" title={r.themes.join(' · ')}>
                      {r.themes.join(' · ')}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {query.trim() ? (
          <ul className="search-results" ref={searchList}
            onKeyDown={(e) => {
              const row = (e.target as HTMLElement).closest('li')
              if (!row) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                const next = row.nextElementSibling as HTMLElement | null
                next?.querySelector<HTMLButtonElement>('.search-hit')?.focus()
              } else if (e.key === 'ArrowUp' || e.key === 'Escape') {
                e.preventDefault()
                const prev = e.key === 'ArrowUp' ? row.previousElementSibling as HTMLElement | null : null
                const target = prev?.querySelector<HTMLButtonElement>('.search-hit') ?? searchRef.current
                target?.focus()
              }
            }}
          >
            {figureHits.map(({ path, figure }, i) => {
              const file = noteByPath.get(path)
              if (!file) return null
              return <li key={`figure-${path}-${figure.id}-${i}`}>
                <button className="search-hit" onClick={async () => {
                  if (await openFile(file) !== null) setViewFigure({ path, id: figure.id, label: figure.label, ref: figure })
                }}>
                  <span className="search-result-title">View figure · {figure.label}</span>
                  <span className="search-result-path">{file.name} · {figure.location}</span>
                </button>
              </li>
            })}
            {!results.length && !figureHits.length ? (
              <li className="search-empty">No matches.</li>
            ) : (
              results.map((hit) => {
                const f = noteByPath.get(hit.path)
                return (
                  <li
                    key={hit.path}
                    className={active?.path === hit.path ? 'active' : ''}
                  >
                    <button type="button" className="search-hit"
                      aria-current={active?.path === hit.path ? 'page' : undefined}
                      disabled={!f} onClick={() => { if (f) void openFile(f) }}>
                      <span className="search-result-title">
                        {hit.semantic && (
                          <span className="search-result-ai" title="Matched by meaning">
                            ✨{' '}
                          </span>
                        )}
                        {hit.title}
                      </span>
                      <span className="search-result-path">{f?.rel ?? hit.path}</span>
                      {hit.snippet && (
                        <span className="search-result-snippet">{renderSnippet(hit.snippet)}</span>
                      )}
                    </button>
                    {f && <button className="search-hit-map" type="button"
                      aria-label={`Show ${hit.title} on map`}
                      onClick={(e) => void openFile(f, 'new-map', e.currentTarget)}>Show on map</button>}
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

      <main className="editor-pane" inert={navigating}>
        {mountedBook && (
          <div className="reader-map-host" hidden={!bookVisible}>
            <BookMap
              key={`distill-${mountedBook.runId}-${mountedBook.opening}`}
              runId={mountedBook.runId}
              themeOverviewThreshold={themeOverviewThreshold}
              active={bookVisible}
              vaultRevision={graphEpoch}
              vaultRoot={vault}
              layoutPreference={mapLayout}
              onLayoutChange={pickMapLayout}
              onOpenVaultNote={openPathInEditor}
              onClose={closeMap}
              mergeAction={bookVisible && mergeStatus && (!mergeStatus.status.merged || mergeStatus.dismissed) ? (
                <button type="button" className="status-btn distill-merge-btn"
                  onClick={mergeStatus.status.merged ? () => void undoMerge() : mergeDistillRun}
                  disabled={!!currentMergeWork}>
                  {currentMergeWork?.label ?? (mergeStatus.status.merged ? 'Undo merge' : 'Merge book…')}
                </button>
              ) : undefined}
              statusSlot={bookVisible ? appControls : undefined}
            />
          </div>
        )}
        {mountVaultMap && (
          <div className="reader-map-host" hidden={!graphVisible}>
            <GraphView
              key={graphOpening}
              layoutPreference={mapLayout}
              onLayoutChange={pickMapLayout}
              focusPath={mapAnchor?.path ?? null}
              focusName={mapAnchor?.name ?? 'Whole vault'}
              initialGlobal={startGlobal}
              active={graphVisible}
              vaultRoot={vault}
              talkReady={talk.ready}
              onOpen={openPathInGraph}
              onOpenInEditor={openPathInEditor}
              onClose={closeMap}
              reloadKey={graphEpoch}
              statusSlot={graphVisible ? appControls : undefined}
            />
          </div>
        )}
        {(readerOrigin || citationOrigin) && mapPaneVisible && !graphOpen && !distillRun && (
          <div className="reader-return">
            {citationOrigin && <button type="button" className="graph-ctl" onClick={backToCitingNote}>
              ← Back to {citationOrigin.note.name}
            </button>}
            {readerOrigin && <button type="button" className="graph-ctl" onClick={backToMap}>
              ← Back to {readerOrigin.book?.runId ?? 'map'}
            </button>}
          </div>
        )}
        {askOpen ? (
          <AskPanel
            key={vault}
            ask={talk.ask}
            onOpenPassage={openAskPassage}
            openExternal={(url) => void window.nodebook.openExternal(url)}
            onClose={() => setAskOpen(false)}
          />
        ) : helpOpen ? (
          /* The center pane is one big keyless ternary of look-alike <div>s;
             keys stop React from reusing one branch's DOM for another. That
             reuse is not just cosmetic: the note pane's .print-reader div is
             filled IMPERATIVELY (innerHTML) for Print/Export-PDF, so if a
             later branch reuses that node, the stale print HTML stays inside
             it and (for the settings pane) breaks CodeMirror's viewport
             measurement. Keys make every switch a clean remount. */
          <div className="settings-pane" key="help">
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
                revealRange={helpReveal}
              />
            </div>
          </div>
        ) : settingsOpen && settingsDoc !== null ? (
          <div className="settings-pane" key="settings">
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
                <button className="settings-close" onClick={() => void navigate(() => setSettingsOpen(false))}>Close</button>
              </div>
            </div>
            {settingsError && (
              <div className="settings-error" role="alert">
                Saved, but the file has a TOML error — your previous settings stay in effect
                until it's fixed. ({settingsError})
              </div>
            )}
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
        ) : bookVisible || graphVisible ? null : active && doc !== null ? (
          active.rel.endsWith('.map.md') ? (
            <MapView key={active.path} content={doc} onOpen={openLink} />
          ) : (
            <div className="note-pane" key="note">
              <div className="note-content">
                <Editor
                  key={`${active.path}#${noteEpoch}`}
                  notePath={active.path}
                  initialDoc={noteSaver.getContent() ?? doc ?? ''}
                  noteNames={noteNames}
                  onChange={noteSaver.onChange}
                  onOpenLink={openLink}
                  onOpenUrl={(url) => void window.nodebook.openExternal(url)}
                  linkExists={linkExists}
                  theme={editorTheme}
                  mode={editorMode}
                  revealRange={revealRange}
                />
              </div>
              <div className="status-bar" role="group" aria-label="Editor controls">
                <div className="editor-controls">
                  <StatusSelect kind="mode" prefix="View: " title="View mode" value={editorMode}
                    options={MODE_OPTIONS} onChange={(v) => setEditorMode(v as ViewMode)} />
                  <button type="button" className="status-btn graph-open-btn"
                    title="Show this note in the knowledge map" onClick={() => showActiveMap()}>⊹ Map</button>
                </div>
                {appControls}
              </div>
              {/* Off-screen; populated only for Print / Export-PDF. */}
              <div className="print-reader md-rendered" ref={printRef} />
            </div>
          )
        ) : (
          <div className="empty">
            {vault && files.length === 0 ? (
              <div className="empty-vault">
                <p>This vault has no notes yet.</p>
                <button className="open-btn" onClick={() => newNoteIn(vault)}>New note</button>
              </div>
            ) : vault ? 'Select a note' : 'Open a vault to begin'}
          </div>
        )}
        {utilityFooter && (!settingsOpen || telemetryOn) && (
          <div className="status-bar utility-status-bar" role="group" aria-label="App controls">
            {settingsOpen ? <TelemetryWidget enabled={telemetryOn} /> : appControls}
          </div>
        )}
      </main>

      {showRightPanel && (
        <BacklinksPanel
          active={active}
          files={files}
          onOpen={openFile}
          resolveTarget={resolveFile}
          citations={citations}
          document={sourceDocument}
          onOpenOriginal={openOriginal}
          onOpenCitation={openCitation}
          reloadKey={graphEpoch}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {importDocument && (
        <ImportPrompt key={importDocument.id} document={importDocument} presets={FOCUS_LENSES}
          onCancel={() => {
            discardImport(importDocument.id)
            setImportDocument(null)
          }}
          onConfirm={(focus, encoding, estimate) => {
            setImportDocument(null)
            void estimateThenRun(importDocument.id, focus, encoding, estimate)
          }} />
      )}
      {prompt && (
        <Prompt
          key={prompt.seq}
          title={prompt.title}
          initialValue={prompt.initialValue}
          placeholder={prompt.placeholder}
          confirmLabel={prompt.confirmLabel}
          presets={prompt.presets}
          maxLength={prompt.maxLength}
          allowEmpty={prompt.allowEmpty}
          onConfirm={prompt.onConfirm}
          onCancel={() => setPrompt(null)}
        />
      )}
      {mergePlan && mergePlan.run === distillRun && (
        <MergeDialog
          plan={mergePlan.plan}
          folder={`Distilled/${mergePlan.run.runId}`}
          onCancel={() => setMergePlan(null)}
          onConfirm={(sameAs) => confirmMerge(mergePlan.run.runId, sameAs)}
        />
      )}
      {savePrompt ? (
        <Confirm
          key={savePrompt.seq}
          message={savePrompt.message}
          confirmLabel={savePrompt.saveLabel}
          secondaryAction={savePrompt.canDiscard ? {
            label: 'Discard',
            onClick: () => savePrompt.resolve('discard')
          } : undefined}
          onConfirm={() => savePrompt.resolve('save')}
          onCancel={() => savePrompt.resolve('cancel')}
        />
      ) : confirm && (
        <Confirm
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.onConfirm}
          onCancel={() => {
            if (confirm.importId) discardImport(confirm.importId)
            setConfirm(null)
          }}
        />
      )}
      <div className="app-notices">
        {preparingImport && !distilling && (
          <div className="distill-toast" role="status">
            Preparing document…
            <button className="distill-cancel" onClick={() => discardImport(preparingImport)}>Cancel</button>
          </div>
        )}
        {distilling && (
          <div className="distill-toast" role="status">
            <span className="distill-spinner" aria-hidden="true" />
            <span className="distill-toast-lines">
              {distillEstimate && (
                <span className="distill-toast-plan">
                  Reading {distillEstimate.chunks} passage
                  {distillEstimate.chunks === 1 ? '' : 's'} in {distillEstimate.calls} step
                  {distillEstimate.calls === 1 ? '' : 's'}.
                </span>
              )}
              <span className="distill-toast-label">
                {distilling.pausing ? 'Pausing…' : distilling.settled ? 'Updating distilled runs…' : (
                  <>
                    Distilling…{' '}
                    {({
                      resuming: 'resuming',
                      chunking: 'reading',
                      extracting: 'extracting concepts',
                      finalizing: 'writing notes',
                      themes: 'grouping into themes',
                      done: 'done'
                    } as Record<string, string>)[distilling.phase] ?? 'starting'}
                    {distilling.total > 0 ? ` (${distilling.done}/${distilling.total})` : ''}
                  </>
                )}
              </span>
            </span>
            {distilling.runId && (
              <button
                className="distill-cancel"
                type="button"
                title="Pause and keep reading progress"
                disabled={distilling.pausing || distilling.settled}
                onClick={() => void pauseDistilling()}
              >
                Pause
              </button>
            )}
          </div>
        )}
        {bookVisible && mergeStatus?.status.merged && !mergeStatus.dismissed && (
          <div className="distill-merged-banner" role="status">
            <span>
              Merged {mergeStatus.status.count} {mergeStatus.status.count === 1 ? 'note' : 'notes'} into{' '}
              <code>{mergeStatus.status.folder}</code>.
            </span>
            <button className="distill-undo" disabled={!!currentMergeWork} onClick={() => void undoMerge()}>
              {currentMergeWork?.label ?? 'Undo'}
            </button>
            <button className="distill-merged-close" aria-label="Dismiss"
              onClick={() => setRunMerge({ ...mergeStatus, dismissed: true })}>✕</button>
          </div>
        )}
        {distillDoneNote && (
          <div className="distill-coverage-banner" role="status">
            <span>{distillDoneNote}</span>
            <button
              className="distill-coverage-close"
              aria-label="Dismiss"
              onClick={() => setDistillDoneNote(null)}
            >
              ✕
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="error-banner-close"
              aria-label="Dismiss"
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {viewFigure && <FigureDialog
        key={JSON.stringify([viewFigure.path, viewFigure.runId, viewFigure.id, viewFigure.occurrence, viewFigure.ref?.location, viewFigure.ref?.label])}
        target={viewFigure} onClose={() => setViewFigure(null)} />}
    </div>
    </OpenFigure.Provider>
  )
}
