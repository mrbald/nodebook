import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_EMBED_MODEL,
  DISTILL_FOCUS_MAX,
  type Citation,
  type DistillEstimate,
  type DistillMergePlan,
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
import { Confirm } from './Confirm'
import { MergeDialog } from './MergeDialog'
import { StagedNoteView } from './StagedNoteView'
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
  // Bumped when the active note's file changes on disk under a clean buffer,
  // to remount the editor on the fresh bytes (the island reads its doc once).
  const [noteEpoch, setNoteEpoch] = useState(0)
  // A pending "jump to a cited span" — the source path + range to reveal once open.
  const [pendingReveal, setPendingReveal] = useState<{ path: string; from: number; to: number } | null>(
    null
  )
  const [noteNames, setNoteNames] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [telemetryOn, setTelemetryOn] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [graphEpoch, setGraphEpoch] = useState(0)
  // A finished distill run, shown as its own map; and live progress while running.
  const [distillRun, setDistillRun] = useState<{ runId: string } | null>(null)
  // Overlay vs standalone for the run map (a reversible view; nothing written).
  const [distillOverlay, setDistillOverlay] = useState(false)
  // Set once a run has been merged into the vault, driving the Undo banner.
  const [mergeInfo, setMergeInfo] = useState<{ runId: string; folder: string; count: number } | null>(
    null
  )
  // The merge dialog's plan: what merging this run would do, fetched before the
  // confirm so the user decides with the collisions in front of them.
  const [mergePlan, setMergePlan] = useState<{ runId: string; plan: DistillMergePlan } | null>(null)
  // A staged note being read (by name) instead of the run map — read-only, so
  // you can check a run's notes and their quotes before merging.
  const [stagedNote, setStagedNote] = useState<string | null>(null)
  // What just happened to the last distill run: how many notes were staged (and
  // why zero, when zero) plus the sampling-coverage honesty note — or that the
  // run was cancelled, or its merge undone.
  const [distillDoneNote, setDistillDoneNote] = useState<string | null>(null)
  // Staged (unmerged or merged) distill runs, listed in the sidebar so a run
  // is never lost once its map is closed.
  const [stagedRuns, setStagedRuns] = useState<DistillRunInfo[]>([])
  const [distilling, setDistilling] = useState<{
    runId?: string
    phase: string
    done: number
    total: number
  } | null>(null)
  // What the run ahead will cost, worked out from the document before it starts
  // (shown on the progress toast, so "reading a book" is never a black box).
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
      if (!distillingRef.current) runPendingEmbedSwap()
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
  // renders it), checked against distillingRef so a change saved mid-distill
  // is deferred to the run's end — swapping the embedder inside one run would
  // cluster vectors from two different models. `modelChanged` is sticky across
  // coalesced changes: any model change in the batch means a full re-index.
  const pendingEmbedSwap = useRef<{ modelChanged: boolean } | null>(null)
  const distillingRef = useRef(false)
  // Set by the toast's Cancel button so the run's rejection is reported as a
  // cancellation rather than an error banner.
  const distillCancelled = useRef(false)
  const runPendingEmbedSwap = (): void => {
    const swap = pendingEmbedSwap.current
    if (!swap) return
    pendingEmbedSwap.current = null
    void talk.onEmbedConfigChanged(swap.modelChanged)
  }
  useEffect(() => {
    distillingRef.current = distilling !== null
    if (distilling === null) runPendingEmbedSwap()
    // runPendingEmbedSwap is stable enough (talk callbacks are memoized); this
    // must fire exactly on distill-run boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distilling])

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

  const saveCurrent = useCallback(() => {
    if (navigation.current) return
    void (settingsOpen ? configSaver : noteSaver).saveNow()
  }, [settingsOpen, configSaver, noteSaver])

  // Keep the current editor mounted and pause edits until the save decision
  // and the navigation complete. Cancel or a write failure leaves it intact.
  const navigate = useCallback(
    async <T,>(action: () => T | Promise<T>, reason?: 'close' | 'discard-note'): Promise<T | null> => {
      if (navigation.current) return null
      navigation.current = true
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveCurrent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveCurrent])

  // Window title reflects unsaved state.
  const currentDirty = settingsOpen ? configSaver.dirty : noteSaver.dirty
  useEffect(() => {
    document.title = `${currentDirty ? '● ' : ''}Nodebook`
  }, [currentDirty])

  const enterVault = useCallback(
    (dir: string) => navigate(async () => {
      try {
        const listing = await window.nodebook.openVault(dir)
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
        setNoteNames(await window.nodebook.noteNames())
        setDistillRun(null)
        setStagedRuns(await window.nodebook.distillListRuns())
        talk.onVaultOpened() // resume embedding for the newly-opened vault
        return true
      } catch (err) {
        setError(`Couldn't open vault: ${String(err)}`)
        return null
      }
    }),
    [navigate, talk]
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
    (f: MarkdownFile) => navigate(() => readAndOpen(f)),
    [navigate, readAndOpen]
  )

  const openSearchResult = async (file: MarkdownFile): Promise<void> => {
    if ((await openFile(file)) == null) return
    setGraphOpen(false)
    setDistillRun(null)
  }

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

  const noteByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
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
  const openCitation = useCallback(
    (c: NoteCitation) => {
      const f = resolveFile(c.source)
      if (!f) return
      void openFile(f).then((content) => {
        if (content === null) return
        const res = resolveCitationSpan(content, c)
        if (res.status === 'not-found') {
          setPendingReveal(null)
          setError(`Couldn't locate the cited passage in "${f.name}" — the source may have changed.`)
        } else {
          setPendingReveal({ path: f.path, from: res.start, to: res.end })
        }
      })
    },
    [resolveFile, openFile]
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

  // Open a note clicked in the graph, keeping the map open so it recenters.
  const openPathInGraph = useCallback(
    (path: string) => {
      const f = files.find((x) => x.path === path)
      if (f) void openFile(f)
    },
    [files, openFile]
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
  const fillPrint = useCallback(() => {
    if (printRef.current) printRef.current.innerHTML = renderMarkdown(noteSaver.getContent() ?? doc ?? '')
  }, [noteSaver, doc])

  const exportPdf = useCallback(async () => {
    fillPrint()
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

  // Report which actions apply so the menu can grey out the rest (Save/Export/
  // Print need a note or the settings editor; New Note needs a vault; Map needs a
  // note; Ask needs a chat provider). main rebuilds the menu only on real changes.
  useEffect(() => {
    window.nodebook.setMenuState({
      hasVault: vault !== null,
      hasNote: active !== null,
      canSave: active !== null || settingsOpen,
      canAsk: talk.canAsk,
      distilling: distilling !== null
    })
  }, [vault, active, settingsOpen, talk.canAsk, distilling])

  // Application-menu commands (also drive the ⌘E/⌘P/⌘S/⌘O/⌘N/⌘G/⌘, accelerators).
  // Defined after the handlers it dispatches to so their identities are in scope.
  // Distill a document: pick a file → run the pipeline (with live progress) →
  // show the resulting staged run as its own map.
  // Refresh the sidebar's staged-runs list (after a run, a delete, vault open).
  const refreshRuns = useCallback(async () => {
    setStagedRuns(await window.nodebook.distillListRuns())
  }, [])

  // One run's lifecycle, shared by a fresh distill and a resume: claim the UI,
  // follow the progress, and say what happened. `start` is what actually runs.
  const startDistilling = useCallback(
    async (start: () => Promise<DistillRunResult>) => {
      // Sync the ref before the state commits: a settings save landing in this
      // same tick must already see the run as active and defer its embed swap
      // (the effect that normally maintains the ref runs a render later).
      distillingRef.current = true
      distillCancelled.current = false
      setDistilling({ phase: 'starting', done: 0, total: 0 })
      const off = window.nodebook.onDistillProgress((runId, p) =>
        setDistilling({ runId, phase: p.phase, done: p.done, total: p.total })
      )
      setDistillDoneNote(null)
      try {
        const res = await start()
        setGraphOpen(false)
        setAskOpen(false)
        setDistillOverlay(false) // a fresh run opens standalone
        setDistillRun({ runId: res.runId })
        void refreshRuns()
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
        const summary = s.notes === 0
          ? 'No notes were staged with matching source quotes.'
          : `Staged ${s.notes} note${s.notes === 1 ? '' : 's'}. Choose Merge to add them to your vault.`
        setDistillDoneNote([
          summary,
          res.pdf && describePdfExtraction(res.pdf),
          `The model read ${read} of the extracted text.`,
          ...why
        ].filter(Boolean).join(' '))
      } catch (e) {
        // Cancelling is a choice, not a fault — say what happened, don't alarm.
        // A cancelled run is PAUSED, not lost: what it already read is kept.
        if (distillCancelled.current) {
          setDistillDoneNote(
            'Distilling cancelled — what it read so far is kept. Press Resume under “Distilled runs” to carry on.'
          )
        } else setError(e instanceof Error ? e.message : String(e))
        // Either way the run may be resumable now — show it in the sidebar.
        void refreshRuns()
      } finally {
        off()
        setDistilling(null)
        setDistillEstimate(null)
      }
    },
    [refreshRuns]
  )

  // Price the run, warn if it needs more steps than the budget allows, then go.
  // The focus is passed to both halves so the estimate is made against the same
  // prompt the run will send.
  const estimateThenRun = useCallback(
    async (docId: string, focus: string) => {
      // The estimate converts the document; the run reuses that same copy, so
      // this costs the conversion once and the toast can say what is coming.
      let est: DistillEstimate
      try {
        est = await window.nodebook.distillEstimate(docId, focus)
      } catch (err) {
        setError(`Couldn’t prepare this import. ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      setDistillEstimate(est)
      const go = (): Promise<void> =>
        startDistilling(() => window.nodebook.distillRun(docId, focus))
      const sampled = est.totalWindows > est.maxCalls
      if (sampled || est.pdf?.missing.length) {
        const steps = sampled
          ? `This document needs ${est.totalWindows} steps. Your budget covers ${est.calls} evenly spaced steps, about ${Math.round(est.coverage * 100)}% of the extracted text.`
          : `Read the extracted text in ${est.calls} step${est.calls === 1 ? '' : 's'}?`
        setConfirm({
          message: [est.pdf && describePdfExtraction(est.pdf), steps].filter(Boolean).join(' '),
          confirmLabel: sampled ? `Read ${est.calls} steps` : 'Continue with extracted text',
          onConfirm: () => {
            setConfirm(null)
            void go()
          }
        })
        return
      }
      await go()
    },
    [startDistilling]
  )

  const runDistill = useCallback(async () => {
    // main hands back an opaque id for the picked document, never a path.
    const doc = await window.nodebook.distillPick()
    if (!doc) return
    // Ask what this reading is for BEFORE the estimate: the focus rides in
    // every prompt, so it is part of what the run will cost. An empty field is
    // an answer — no focus, and the run reads as it always did.
    openPrompt({
      title: 'What should the notes focus on? (optional)',
      placeholder: 'e.g. the arguments and the evidence for them',
      confirmLabel: 'Distill',
      presets: FOCUS_LENSES,
      maxLength: DISTILL_FOCUS_MAX,
      allowEmpty: true,
      onConfirm: (focus) => {
        setPrompt(null)
        void estimateThenRun(doc.id, focus)
      }
    })
  }, [estimateThenRun, openPrompt])

  // Carry on a run that was cancelled or interrupted, from its own checkpoint.
  const resumeStagedRun = useCallback(
    (runId: string) => {
      void startDistilling(() => window.nodebook.distillResume(runId))
    },
    [startDistilling]
  )

  // Reopen a staged run's map from the sidebar list (a closed run map used to
  // be unreachable — the run looked lost even though it was staged on disk).
  const openStagedRun = useCallback(
    (id: string) => {
      void navigate(() => {
        setGraphOpen(false)
        setAskOpen(false)
        setHelpOpen(false)
        setSettingsOpen(false)
        setDistillOverlay(false)
        setDistillRun({ runId: id })
      })
    },
    [navigate]
  )

  const discardStagedRun = useCallback(
    (run: DistillRunInfo) => {
      setConfirm({
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
          void window.nodebook.distillRemove(run.id).then(() => {
            setDistillRun((cur) => (cur?.runId === run.id ? null : cur))
            void refreshRuns()
          })
        }
      })
    },
    [refreshRuns]
  )

  // Stable graph loader for the run map, so the reused GraphView doesn't refetch
  // every render. Only called while a run map is shown (distillRun set).
  const distillLoad = useCallback(
    (f: string | null, o?: { depth?: number; cap?: number }) => {
      const id = distillRun?.runId ?? ''
      return distillOverlay
        ? window.nodebook.distillOverlayGraph(id, f, o)
        : window.nodebook.distillGraph(id, f, o)
    },
    [distillRun, distillOverlay]
  )

  // Open a staged note from the run map, read-only: staged notes are not vault
  // files, so they never reach the editor (no path to save to, no dirty state).
  const openStagedNote = useCallback((path: string) => {
    const name = (path.split(/[/\\]/).pop() ?? path).replace(/\.md$/i, '')
    if (name) setStagedNote(name)
  }, [])

  // Merge a run into the vault (an explicit, confirmed, reversible write). The
  // plan comes first: the dialog says what would happen — and, for a note whose
  // name you already use, asks whether the two are really the same thing.
  const [mergePlanning, setMergePlanning] = useState(false)
  const mergeDistillRun = useCallback(() => {
    if (!distillRun || mergePlanning) return
    const runId = distillRun.runId
    setMergePlanning(true) // the plan may embed the run's notes: seconds, not instant
    void window.nodebook
      .distillMergePlan(runId)
      .then((plan) => setMergePlan({ runId, plan }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMergePlanning(false))
  }, [distillRun, mergePlanning])

  const confirmMerge = useCallback(
    (runId: string, sameAs: string[]) => {
      setMergePlan(null)
      void window.nodebook
        .distillMerge(runId, { sameAs })
        .then((res) => {
          setMergeInfo({ runId, folder: res.folder, count: res.count })
          void refreshRuns() // the run's "merged" tag changed
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [refreshRuns]
  )

  // Restore the merged/undo state when a run map opens (and clear it on close).
  useEffect(() => {
    setStagedNote(null) // a different run: back to its map
    setMergePlan(null)
    if (!distillRun) {
      setMergeInfo(null)
      return
    }
    const runId = distillRun.runId
    void window.nodebook.distillMergeStatus(runId).then((s) => {
      setMergeInfo(s.merged ? { runId, folder: s.folder ?? '', count: s.count ?? 0 } : null)
    })
  }, [distillRun])

  useEffect(() => {
    return window.nodebook.onMenuCommand((cmd, arg) => {
      // ⌘E toggles writing (Live) ⇄ Reading; ⌘1/2/3 pick a mode.
      if (cmd === 'toggle-read') setEditorMode((m) => (m === 'reading' ? 'live' : 'reading'))
      else if (cmd === 'mode-code') setEditorMode('code')
      else if (cmd === 'mode-live') setEditorMode('live')
      else if (cmd === 'mode-reading') setEditorMode('reading')
      else if (cmd === 'help') openHelp(arg)
      else if (cmd === 'export-pdf') void exportPdf()
      else if (cmd === 'print') {
        fillPrint()
        window.print()
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
      } else if (cmd === 'map') {
        if (active) setGraphOpen(true)
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
    active,
    talk.canAsk,
    runDistill
  ])

  // The right panel (backlinks) only shows when editing a note; collapse the grid
  // to two columns otherwise (map / settings / help / empty) so the centre fills
  // the width instead of leaving a blank third column.
  const showRightPanel =
    !!active && !settingsOpen && !helpOpen && !graphOpen && !askOpen && !distillRun
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
            ref={searchRef}
            className="search-box"
            placeholder={`Search notes…  ${navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl+K'}`}
            value={query}
            aria-label="Search notes"
            onChange={(e) => {
              setQuery(e.target.value)
              setResults([])
            }}
            onKeyDown={(e) => {
              if (!results.length) return
              const first = searchList.current?.querySelector<HTMLElement>('[role=button]')
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
        {vault && <TalkPanel talk={talk} distilling={distilling !== null} />}
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
            {stagedRuns.map((r) => (
              <div
                key={r.id}
                className="run-item"
                role="button"
                tabIndex={0}
                onClick={() => (r.unfinished ? resumeStagedRun(r.id) : openStagedRun(r.id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    if (r.unfinished) resumeStagedRun(r.id)
                    else openStagedRun(r.id)
                  }
                }}
              >
                <span className="run-item-name" title={r.id}>
                  {r.id}
                </span>
                <span className="run-item-meta">
                  {r.unfinished
                    ? 'paused'
                    : r.merged
                      ? 'merged'
                      : `${r.notes} note${r.notes === 1 ? '' : 's'}`}
                </span>
                {r.unfinished && (
                  <button
                    className="run-item-resume"
                    title="Carry on where this run stopped"
                    disabled={distilling !== null}
                    onClick={(e) => {
                      e.stopPropagation()
                      resumeStagedRun(r.id)
                    }}
                  >
                    Resume
                  </button>
                )}
                <button
                  className="run-item-del"
                  aria-label={`Discard run ${r.id}`}
                  title="Discard this staged run"
                  onClick={(e) => {
                    e.stopPropagation()
                    discardStagedRun(r)
                  }}
                >
                  ✕
                </button>
                {/* What this reading was asked to look for — how two runs of
                    one book are told apart before their themes are read. */}
                {r.focus && (
                  <span className="run-item-focus" title={r.focus}>
                    Focus: {r.focus}
                  </span>
                )}
                {/* What the run turned out to be about — its themes, on their
                    own line under the run (see the wrapping rule in the CSS). */}
                {(r.themes?.length ?? 0) > 0 && (
                  <span className="run-item-themes" title={r.themes!.join(' · ')}>
                    {r.themes!.join(' · ')}
                  </span>
                )}
              </div>
            ))}
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
                next?.focus()
              } else if (e.key === 'ArrowUp' || e.key === 'Escape') {
                e.preventDefault()
                const prev = e.key === 'ArrowUp' ? row.previousElementSibling as HTMLElement | null : null
                const target = prev ?? searchRef.current
                target?.focus()
              }
            }}
          >
            {results.length === 0 ? (
              <li className="search-empty">No matches.</li>
            ) : (
              results.map((hit) => {
                const f = noteByPath.get(hit.path)
                return (
                  <li
                    key={hit.path}
                    className={active?.path === hit.path ? 'active' : ''}
                    role="button"
                    tabIndex={0}
                    aria-current={active?.path === hit.path ? 'page' : undefined}
                    onClick={() => {
                      if (f) void openSearchResult(f)
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && f) {
                        e.preventDefault()
                        void openSearchResult(f)
                      }
                    }}
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

      <main className="editor-pane" inert={navigating}>
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
        ) : distillRun && stagedNote ? (
          <StagedNoteView
            key={`staged-${distillRun.runId}-${stagedNote}`}
            runId={distillRun.runId}
            name={stagedNote}
            onBack={() => setStagedNote(null)}
          />
        ) : distillRun ? (
          <GraphView
            key={`distill-${distillRun.runId}`}
            loadGraph={distillLoad}
            defaultShowSources
            initialLayout="elk"
            emptyMessage="This run staged no notes with matching source quotes."
            focusPath={null}
            focusName=""
            vaultRoot={vault}
            talkReady={false}
            onOpen={openStagedNote}
            onOpenInEditor={openStagedNote}
            onClose={() => setDistillRun(null)}
            reloadKey={0}
            statusSlot={
              <>
                <button
                  className="status-btn distill-view-toggle"
                  title={
                    distillOverlay
                      ? 'Overlay: your notes + this run together (nothing written)'
                      : 'Standalone: this run on its own'
                  }
                  onClick={() => setDistillOverlay((v) => !v)}
                >
                  {distillOverlay ? '⧉ Overlay' : '◻ Standalone'}
                </button>
                {!mergeInfo && (
                  <button
                    className="status-btn distill-merge-btn"
                    title="Merge this run's notes into your vault (reversible)"
                    onClick={mergeDistillRun}
                    disabled={mergePlanning}
                  >
                    {mergePlanning ? '⤓ Planning…' : '⤓ Merge'}
                  </button>
                )}
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
        ) : graphOpen && active ? (
          <GraphView
            key="graph"
            focusPath={active.path}
            focusName={active.name}
            vaultRoot={vault}
            talkReady={talk.ready}
            onOpen={openPathInGraph}
            onOpenInEditor={(path) => {
              const f = files.find((x) => x.path === path)
              if (f) void openFile(f).then((content) => {
                if (content !== null) setGraphOpen(false)
              })
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
            <div className="note-pane" key="note">
              <div className="note-content">
                <Editor
                  key={`${active.path}#${noteEpoch}`}
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
      {mergePlan && (
        <MergeDialog
          plan={mergePlan.plan}
          folder={`Distilled/${mergePlan.runId}`}
          onCancel={() => setMergePlan(null)}
          onConfirm={(sameAs) => confirmMerge(mergePlan.runId, sameAs)}
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
          onCancel={() => setConfirm(null)}
        />
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
            Distilling…{' '}
            {({
              chunking: 'reading',
              extracting: 'extracting concepts',
              finalizing: 'writing notes',
              themes: 'grouping into themes',
              done: 'done'
            } as Record<string, string>)[distilling.phase] ?? 'starting'}
            {distilling.total > 0 ? ` (${distilling.done}/${distilling.total})` : ''}
            </span>
          </span>
          {distilling.runId && (
            <button
              className="distill-cancel"
              onClick={() => {
                distillCancelled.current = true
                void window.nodebook.distillCancel(distilling.runId!)
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {mergeInfo && (
        <div className="distill-merged-banner" role="status">
          <span>
            Merged {mergeInfo.count} {mergeInfo.count === 1 ? 'note' : 'notes'} into{' '}
            <code>{mergeInfo.folder}</code>.
          </span>
          <button
            className="distill-undo"
            onClick={() => {
              const runId = mergeInfo.runId
              void window.nodebook.distillUnmerge(runId).then((r) => {
                setMergeInfo(null)
                setDistillDoneNote(
                  `Undone — ${r.removed} note${r.removed === 1 ? '' : 's'} removed` +
                    (r.trashed > 0
                      ? `, ${r.trashed} edited note${r.trashed === 1 ? '' : 's'} moved to the Trash.`
                      : '.')
                )
                void refreshRuns() // the run's "merged" tag changed
              })
            }}
          >
            Undo
          </button>
          <button
            className="distill-merged-close"
            aria-label="Dismiss"
            onClick={() => setMergeInfo(null)}
          >
            ✕
          </button>
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
  )
}
