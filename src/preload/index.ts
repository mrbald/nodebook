import type { FigureSearchHit } from '../shared/figureSearch'
import { contextBridge, ipcRenderer } from 'electron'
import type { FigureAnalysis, FigureAnalysisStatus, FigureContext, FigureRef } from '../shared/figures'
import type { ReadingCopy, ReadingCopyPreview } from '../shared/readingCopy'
import type {
  AskRequest,
  AskResult,
  Backlink,
  BookLinkEvidence,
  BookOverview,
  BookThemeDetails,
  DistillDocument,
  DistillEstimate,
  DistillMergePlan,
  DistillMergeResult,
  DistillMergeStatus,
  DistillProgress,
  DistillRunInfo,
  DistillRunResult,
  DistillUnmergeResult,
  GraphData,
  MenuState,
  Outbound,
  SameAsTwin,
  SaveFileResult,
  SearchHit,
  Settings,
  StagedNoteRead,
  TalkChunk,
  TalkNeighbor,
  TalkStatus,
  TelemetrySnapshot,
  VaultListing,
  VaultThemesData
} from '../shared/types'

const askRequestIds = new Set<string>()

const api = {
  noteFigures: (path: string, runId?: string): Promise<FigureRef[]> =>
    ipcRenderer.invoke('distill:figures', path, runId),
  figureBytes: (path: string, id: string, runId?: string): Promise<{ bytes: Uint8Array; mime: string } | null> =>
    ipcRenderer.invoke('distill:figureBytes', path, id, runId),
  pickVault: (): Promise<string | null> => ipcRenderer.invoke('vault:pick'),
  createVault: (): Promise<string | null> => ipcRenderer.invoke('vault:create'),
  openVault: (root: string): Promise<VaultListing> => ipcRenderer.invoke('vault:open', root),
  listVault: (root: string): Promise<VaultListing> => ipcRenderer.invoke('vault:list', root),
  createFile: (dir: string, name: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:createFile', dir, name),
  createDir: (dir: string, name: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:createDir', dir, name),
  rename: (path: string, newName: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:rename', path, newName),
  deletePath: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:delete', path),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('file:read', path),
  saveFile: (path: string, content: string, expected: string | null): Promise<SaveFileResult> =>
    ipcRenderer.invoke('file:save', path, content, expected),
  onCloseRequested: (cb: () => Promise<boolean>): (() => void) => {
    const listener = (): void => {
      void cb().then(
        (approved) => ipcRenderer.send('window:close-response', approved),
        () => ipcRenderer.send('window:close-response', false)
      )
    }
    ipcRenderer.on('window:close-request', listener)
    ipcRenderer.send('window:close-ready')
    return () => ipcRenderer.removeListener('window:close-request', listener)
  },
  backlinks: (target: string): Promise<Backlink[]> => ipcRenderer.invoke('index:backlinks', target),
  backlinksToFile: (path: string): Promise<Backlink[]> => ipcRenderer.invoke('index:backlinksToFile', path),
  outbound: (sourceFile: string): Promise<Outbound[]> =>
    ipcRenderer.invoke('index:outbound', sourceFile),
  /** The notes a confirmed `same_as::` made one thing with this one. */
  sameAs: (path: string): Promise<SameAsTwin[]> => ipcRenderer.invoke('index:sameAs', path),
  searchFigures: (query: string): Promise<FigureSearchHit[]> => ipcRenderer.invoke('index:searchFigures', query),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke('index:search', query),
  noteNames: (): Promise<string[]> => ipcRenderer.invoke('index:noteNames'),
  notePreview: (path: string, runId?: string): Promise<string> =>
    ipcRenderer.invoke('index:notePreview', path, runId),
  graph: (
    focusPath: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ): Promise<GraphData> => ipcRenderer.invoke('index:graph', focusPath, opts),
  vaultThemes: (root: string, id: string): Promise<VaultThemesData | null> =>
    ipcRenderer.invoke('index:vaultThemes', root, id),
  cancelVaultThemes: (id: string): void => ipcRenderer.send('index:vaultThemes:cancel', id),
  onVaultThemesChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('index:vaultThemes:changed', listener)
    return () => ipcRenderer.removeListener('index:vaultThemes:changed', listener)
  },
  // Name an untyped link: append `relation:: [[target]]` to the source note + re-index.
  typeRelation: (sourcePath: string, relation: string, target: string): Promise<boolean> =>
    ipcRenderer.invoke('index:typeRelation', sourcePath, relation, target),
  // Talk to docs (semantic search). The embedder lives in the renderer (WASM);
  // main owns the vector store + retrieval.
  talkStatus: (): Promise<TalkStatus> => ipcRenderer.invoke('talk:status'),
  talkEnable: (vaultId: string, model: string, dims: number): Promise<TalkStatus> =>
    ipcRenderer.invoke('talk:enable', vaultId, model, dims),
  talkDisable: (): Promise<TalkStatus> => ipcRenderer.invoke('talk:disable'),
  talkPending: (generation: string, limit: number): Promise<TalkChunk[]> =>
    ipcRenderer.invoke('talk:pending', generation, limit),
  talkPutEmbeddings: (generation: string, rows: { id: number; vector: number[] }[]): Promise<TalkStatus> =>
    ipcRenderer.invoke('talk:putEmbeddings', generation, rows),
  talkSearch: (query: string, generation: string, vector: number[]): Promise<SearchHit[]> =>
    ipcRenderer.invoke('talk:search', query, generation, vector),
  talkNeighbors: (focusPath: string, k?: number): Promise<TalkNeighbor[]> =>
    ipcRenderer.invoke('talk:neighbors', focusPath, k),
  talkSemanticEdges: (
    paths: string[],
    k?: number
  ): Promise<{ source: string; target: string }[]> =>
    ipcRenderer.invoke('talk:semanticEdges', paths, k),
  /** True when an "Ask" chat provider is configured. */
  canAsk: (): Promise<boolean> => ipcRenderer.invoke('talk:canAsk'),
  ask: (request: AskRequest, onToken: (t: string) => void): Promise<AskResult> => {
    if (askRequestIds.has(request.id)) return Promise.reject(new Error('This Ask request is already running.'))
    askRequestIds.add(request.id)
    const onTok = (_e: unknown, id: string, token: string): void => {
      if (id === request.id) onToken(token)
    }
    ipcRenderer.on('talk:ask:token', onTok)
    return ipcRenderer.invoke('talk:ask', request).finally(() => {
      askRequestIds.delete(request.id)
      ipcRenderer.removeListener('talk:ask:token', onTok)
    })
  },
  cancelAsk: (id: string): void => ipcRenderer.send('talk:ask:cancel', id),
  /** Notifies the renderer that saved/changed notes need (re)embedding. */
  onTalkDirty: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('talk:dirty', listener)
    return () => ipcRenderer.removeListener('talk:dirty', listener)
  },
  // Telemetry (event-loop lag + CPU/RAM).
  telemetryApply: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('telemetry:apply', enabled),
  telemetrySnapshot: (): Promise<TelemetrySnapshot | null> =>
    ipcRenderer.invoke('telemetry:snapshot'),
  settingsPath: (): Promise<string> => ipcRenderer.invoke('settings:path'),
  readSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:read'),
  /** The TOML syntax error in `raw` (short message with line/col), or null. */
  validateSettings: (raw: string): Promise<string | null> =>
    ipcRenderer.invoke('settings:validate', raw),
  setThemeMode: (mode: 'system' | 'dark' | 'light'): Promise<Settings> =>
    ipcRenderer.invoke('settings:setThemeMode', mode),
  resetSettings: (): Promise<string> => ipcRenderer.invoke('settings:reset'),
  // The documented default config, for read-only reference (never written).
  defaultSettings: (): Promise<string> => ipcRenderer.invoke('settings:defaults'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  exportPdf: (name: string): Promise<boolean> => ipcRenderer.invoke('pdf:export', name),
  /** Subscribe to vault file/dir changes; returns an unsubscribe function. */
  onVaultChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('vault:changed', listener)
    return () => ipcRenderer.removeListener('vault:changed', listener)
  },
  /** Subscribe to index content changes (a save added/removed a link, etc.). */
  onIndexChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('index:changed', listener)
    return () => ipcRenderer.removeListener('index:changed', listener)
  },
  /** Subscribe to on-disk changes of a specific note (external edit or a
   *  relation typed from the map), so a clean open buffer can reload. */
  onFileChanged: (cb: (path: string) => void): (() => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('file:changed', listener)
    return () => ipcRenderer.removeListener('file:changed', listener)
  },
  // Distill a document → a staged, cited run of notes + its own map.
  /** Pick a document; main returns an opaque id (never the path) + a name to show. */
  distillPick: (): Promise<DistillDocument | null> => ipcRenderer.invoke('distill:pick'),
  distillDiscardPick: (docId: string): Promise<void> => ipcRenderer.invoke('distill:discardPick', docId),
  /** e2e only (main refuses unless NODEBOOK_E2E): register a path, get its id. */
  distillRegisterPath: (absPath: string): Promise<string> =>
    ipcRenderer.invoke('distill:registerPath', absPath),
  /** Distil a picked document. `focus` is what this reading is for, in the
   *  user's words — omitted or empty means the reading has no focus. */
  distillRun: (docId: string, focus?: string, encoding?: string, preparedId?: string): Promise<DistillRunResult> =>
    ipcRenderer.invoke('distill:run', docId, focus, encoding, preparedId),
  /** Price a run without model calls. Pass the previous prepared ID to price
   *  the same decoded text for a different focus. */
  distillEstimate: (docId: string, focus?: string, encoding?: string, fromPreparedId?: string): Promise<DistillEstimate> =>
    ipcRenderer.invoke('distill:estimate', docId, focus, encoding, fromPreparedId),
  /** Continue a run that was cancelled or interrupted, from its checkpoint. */
  distillResume: (runId: string): Promise<DistillRunResult> =>
    ipcRenderer.invoke('distill:resume', runId),
  distillCancel: (runId: string): Promise<void> => ipcRenderer.invoke('distill:cancel', runId),
  distillGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ): Promise<GraphData> => ipcRenderer.invoke('distill:graph', runId, focus ?? null, opts),
  distillBookOverview: (runId: string): Promise<BookOverview | null> =>
    ipcRenderer.invoke('distill:bookOverview', runId),
  distillBookTheme: (runId: string, themeId: string | null): Promise<BookThemeDetails | null> =>
    ipcRenderer.invoke('distill:bookTheme', runId, themeId),
  distillBookLink: (runId: string, source: string, target: string): Promise<BookLinkEvidence | null> =>
    ipcRenderer.invoke('distill:bookLink', runId, source, target),
  distillThemeGraph: (runId: string, themeId: string | null, cap?: number): Promise<GraphData> =>
    ipcRenderer.invoke('distill:themeGraph', runId, themeId, cap),
  /** The vault + this run unioned live (overlay view; no writes). */
  distillOverlayGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ): Promise<GraphData> => ipcRenderer.invoke('distill:overlayGraph', runId, focus ?? null, opts),
  /** Staged runs with note counts + merged flags (newest data read from disk). */
  distillListRuns: (): Promise<DistillRunInfo[]> => ipcRenderer.invoke('distill:listRuns'),
  distillRemove: (runId: string): Promise<void> => ipcRenderer.invoke('distill:remove', runId),
  /** Merge a run into the vault (reversible). */
  /** One staged note by name or exact graph path, with its book theme if present. */
  distillReadNote: (runId: string, note: string): Promise<StagedNoteRead | null> =>
    ipcRenderer.invoke('distill:readNote', runId, note),
  distillLocateReadingCopy: (runId: string, note: string): Promise<ReadingCopyPreview | null> =>
    ipcRenderer.invoke('distill:locateReadingCopy', runId, note),
  distillChooseReadingCopy: (id: string, encoding?: string): Promise<ReadingCopyPreview> =>
    ipcRenderer.invoke('distill:chooseReadingCopy', id, encoding),
  distillSaveReadingCopy: (id: string): Promise<ReadingCopy> =>
    ipcRenderer.invoke('distill:saveReadingCopy', id),
  distillDiscardReadingCopy: (id: string): Promise<void> =>
    ipcRenderer.invoke('distill:discardReadingCopy', id),
  /** What merging this run would do, before anything is written. */
  distillMergePlan: (runId: string): Promise<DistillMergePlan> =>
    ipcRenderer.invoke('distill:mergePlan', runId),
  distillMerge: (runId: string, opts?: { sameAs?: string[] }): Promise<DistillMergeResult> =>
    ipcRenderer.invoke('distill:merge', runId, opts),
  /** Undo a run's merge. */
  distillUnmerge: (runId: string): Promise<DistillUnmergeResult> =>
    ipcRenderer.invoke('distill:unmerge', runId),
  /** Whether a run has been merged into the vault. */
  distillMergeStatus: (runId: string): Promise<DistillMergeStatus> =>
    ipcRenderer.invoke('distill:mergeStatus', runId),
  /** Open the file a distilled document came from, in the system reader. The
   *  hash identifies it; main owns the path (see `distill:openOriginal`).
   *  Resolves to an error message, or null when it opened. */
  distillOpenOriginal: (hash: string): Promise<string | null> =>
    ipcRenderer.invoke('distill:openOriginal', hash),
  figureAnalysisStatus: (path: string, id: string, runId?: string, context?: FigureContext): Promise<FigureAnalysisStatus> =>
    ipcRenderer.invoke('figure:analysisStatus', path, id, runId, context),
  analyzeFigure: (path: string, id: string, runId?: string, context?: FigureContext): Promise<FigureAnalysis> =>
    ipcRenderer.invoke('figure:analyze', path, id, runId, context),
  /** Subscribe to a distill run's progress. */
  onDistillProgress: (cb: (runId: string, p: DistillProgress) => void): (() => void) => {
    const listener = (_e: unknown, runId: string, p: DistillProgress): void => cb(runId, p)
    ipcRenderer.on('distill:progress', listener)
    return () => ipcRenderer.removeListener('distill:progress', listener)
  },
  /** Let the renderer's WASM embedder answer main's distill embed requests.
   *  The reply channel is namespaced by run token + sequence id (main assigns
   *  both) so two concurrent runs can never cross-resolve each other's batch. */
  onDistillEmbedRequest: (handler: (texts: string[]) => Promise<number[][]>): (() => void) => {
    const listener = (_e: unknown, token: string, id: number, texts: string[]): void => {
      const channel = `distill:embed:res:${token}:${id}`
      void handler(texts)
        .then((vectors) => ipcRenderer.send(channel, vectors))
        .catch((err: unknown) => ipcRenderer.send(channel, [], String(err)))
    }
    ipcRenderer.on('distill:embed:req', listener)
    return () => ipcRenderer.removeListener('distill:embed:req', listener)
  },
  /** Tell main which menu actions currently apply (greys out the rest). */
  setMenuState: (s: MenuState): void => ipcRenderer.send('menu:state', s),
  /** Subscribe to application-menu commands. Some carry a payload (e.g.
   *  `open-vault` with a vault path). */
  onMenuCommand: (cb: (cmd: string, arg?: string) => void): (() => void) => {
    const listener = (_e: unknown, cmd: string, arg?: string): void => cb(cmd, arg)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  }
}

export type NodebookApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('nodebook', api)
} else {
  // Fallback for the (unused) non-isolated path.
  // @ts-expect-error — augmenting window without context isolation
  window.nodebook = api
}
