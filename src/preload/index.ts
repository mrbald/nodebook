import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskResult,
  Backlink,
  DistillProgress,
  DistillRunResult,
  GraphData,
  MenuState,
  Outbound,
  SearchHit,
  Settings,
  TalkChunk,
  TalkNeighbor,
  TalkStatus,
  TelemetrySnapshot,
  VaultListing
} from '../shared/types'

const api = {
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
  saveFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke('file:save', path, content),
  /** Synchronous save for window-close flush (blocks until written). */
  saveFileNow: (path: string, content: string): void => {
    ipcRenderer.sendSync('file:save-now', path, content)
  },
  backlinks: (target: string): Promise<Backlink[]> => ipcRenderer.invoke('index:backlinks', target),
  outbound: (sourceFile: string): Promise<Outbound[]> =>
    ipcRenderer.invoke('index:outbound', sourceFile),
  search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke('index:search', query),
  noteNames: (): Promise<string[]> => ipcRenderer.invoke('index:noteNames'),
  graph: (focusPath: string | null, opts?: { depth?: number; cap?: number }): Promise<GraphData> =>
    ipcRenderer.invoke('index:graph', focusPath, opts),
  // Name an untyped link: append `relation:: [[target]]` to the source note + re-index.
  typeRelation: (sourcePath: string, relation: string, target: string): Promise<boolean> =>
    ipcRenderer.invoke('index:typeRelation', sourcePath, relation, target),
  // Talk to docs (semantic search). The embedder lives in the renderer (WASM);
  // main owns the vector store + retrieval.
  talkStatus: (): Promise<TalkStatus> => ipcRenderer.invoke('talk:status'),
  talkEnable: (dims: number): Promise<TalkStatus> => ipcRenderer.invoke('talk:enable', dims),
  talkDisable: (): Promise<TalkStatus> => ipcRenderer.invoke('talk:disable'),
  talkPending: (limit: number): Promise<TalkChunk[]> => ipcRenderer.invoke('talk:pending', limit),
  talkPutEmbeddings: (rows: { id: number; vector: number[] }[]): Promise<TalkStatus> =>
    ipcRenderer.invoke('talk:putEmbeddings', rows),
  talkSearch: (query: string, vector: number[]): Promise<SearchHit[]> =>
    ipcRenderer.invoke('talk:search', query, vector),
  talkNeighbors: (focusPath: string, k?: number): Promise<TalkNeighbor[]> =>
    ipcRenderer.invoke('talk:neighbors', focusPath, k),
  talkSemanticEdges: (
    paths: string[],
    k?: number
  ): Promise<{ source: string; target: string }[]> =>
    ipcRenderer.invoke('talk:semanticEdges', paths, k),
  /** True when an "Ask" chat provider is configured. */
  canAsk: (): Promise<boolean> => ipcRenderer.invoke('talk:canAsk'),
  /** Ask a grounded question: answer tokens arrive via `onToken`; resolves with
   *  the source citations on completion. Tokens + done/error are ordered events
   *  on one channel, so the answer never races the completion signal. */
  ask: (question: string, vector: number[], onToken: (t: string) => void): Promise<AskResult> =>
    new Promise<AskResult>((resolve, reject) => {
      const onTok = (_e: unknown, token: string): void => onToken(token)
      const onDone = (_e: unknown, res: AskResult): void => {
        cleanup()
        resolve(res)
      }
      const onErr = (_e: unknown, message: string): void => {
        cleanup()
        reject(new Error(message))
      }
      const cleanup = (): void => {
        ipcRenderer.removeListener('talk:ask:token', onTok)
        ipcRenderer.removeListener('talk:ask:done', onDone)
        ipcRenderer.removeListener('talk:ask:error', onErr)
      }
      ipcRenderer.on('talk:ask:token', onTok)
      ipcRenderer.once('talk:ask:done', onDone)
      ipcRenderer.once('talk:ask:error', onErr)
      ipcRenderer.send('talk:ask', question, vector)
    }),
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
  // Distill a document → a staged, cited run of notes + its own map.
  distillPick: (): Promise<string | null> => ipcRenderer.invoke('distill:pick'),
  distillRun: (filePath: string): Promise<DistillRunResult> =>
    ipcRenderer.invoke('distill:run', filePath),
  distillCancel: (runId: string): Promise<void> => ipcRenderer.invoke('distill:cancel', runId),
  distillGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number }
  ): Promise<GraphData> => ipcRenderer.invoke('distill:graph', runId, focus ?? null, opts),
  /** The vault + this run unioned live (overlay view; no writes). */
  distillOverlayGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number }
  ): Promise<GraphData> => ipcRenderer.invoke('distill:overlayGraph', runId, focus ?? null, opts),
  distillListRuns: (): Promise<string[]> => ipcRenderer.invoke('distill:listRuns'),
  distillRemove: (runId: string): Promise<void> => ipcRenderer.invoke('distill:remove', runId),
  /** Subscribe to a distill run's progress. */
  onDistillProgress: (cb: (runId: string, p: DistillProgress) => void): (() => void) => {
    const listener = (_e: unknown, runId: string, p: DistillProgress): void => cb(runId, p)
    ipcRenderer.on('distill:progress', listener)
    return () => ipcRenderer.removeListener('distill:progress', listener)
  },
  /** Let the renderer's WASM embedder answer main's distill embed requests. */
  onDistillEmbedRequest: (handler: (texts: string[]) => Promise<number[][]>): (() => void) => {
    const listener = (_e: unknown, id: number, texts: string[]): void => {
      void handler(texts)
        .then((vectors) => ipcRenderer.send(`distill:embed:res:${id}`, vectors))
        .catch((err: unknown) => ipcRenderer.send(`distill:embed:res:${id}`, [], String(err)))
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
