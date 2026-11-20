import type { FigureSearchHit } from '../shared/figureSearch'
import type { ReadingCopy, ReadingCopyPreview } from '../shared/readingCopy'
import type { FigureAnalysis, FigureAnalysisStatus, FigureContext, FigureRef } from '../shared/figures'
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

export interface NodebookApi {
  noteFigures: (path: string, runId?: string) => Promise<FigureRef[]>
  figureBytes: (path: string, id: string, runId?: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
  pickVault: () => Promise<string | null>
  createVault: () => Promise<string | null>
  openVault: (root: string) => Promise<VaultListing>
  listVault: (root: string) => Promise<VaultListing>
  createFile: (dir: string, name: string) => Promise<string | null>
  createDir: (dir: string, name: string) => Promise<string | null>
  rename: (path: string, newName: string) => Promise<string | null>
  deletePath: (path: string) => Promise<boolean>
  readFile: (path: string) => Promise<string>
  saveFile: (path: string, content: string, expected: string | null) => Promise<SaveFileResult>
  onCloseRequested: (cb: () => Promise<boolean>) => () => void
  backlinks: (target: string) => Promise<Backlink[]>
  backlinksToFile: (path: string) => Promise<Backlink[]>
  outbound: (sourceFile: string) => Promise<Outbound[]>
  sameAs: (path: string) => Promise<SameAsTwin[]>
  searchFigures: (query: string) => Promise<FigureSearchHit[]>
  search: (query: string) => Promise<SearchHit[]>
  noteNames: () => Promise<string[]>
  notePreview: (path: string, runId?: string) => Promise<string>
  graph: (
    focusPath: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ) => Promise<GraphData>
  vaultThemes: (root: string, id: string) => Promise<VaultThemesData | null>
  cancelVaultThemes: (id: string) => void
  onVaultThemesChanged: (cb: () => void) => () => void
  typeRelation: (sourcePath: string, relation: string, target: string) => Promise<boolean>
  talkStatus: () => Promise<TalkStatus>
  talkEnable: (vaultId: string, model: string, dims: number) => Promise<TalkStatus>
  talkDisable: () => Promise<TalkStatus>
  talkPending: (generation: string, limit: number) => Promise<TalkChunk[]>
  talkPutEmbeddings: (generation: string, rows: { id: number; vector: number[] }[]) => Promise<TalkStatus>
  talkSearch: (query: string, generation: string, vector: number[]) => Promise<SearchHit[]>
  talkNeighbors: (focusPath: string, k?: number) => Promise<TalkNeighbor[]>
  talkSemanticEdges: (paths: string[], k?: number) => Promise<{ source: string; target: string }[]>
  canAsk: () => Promise<boolean>
  ask: (request: AskRequest, onToken: (t: string) => void) => Promise<AskResult>
  cancelAsk: (id: string) => void
  onTalkDirty: (cb: () => void) => () => void
  telemetryApply: (enabled: boolean) => Promise<void>
  telemetrySnapshot: () => Promise<TelemetrySnapshot | null>
  settingsPath: () => Promise<string>
  readSettings: () => Promise<Settings>
  validateSettings: (raw: string) => Promise<string | null>
  setThemeMode: (mode: 'system' | 'dark' | 'light') => Promise<Settings>
  resetSettings: () => Promise<string>
  defaultSettings: () => Promise<string>
  openExternal: (url: string) => Promise<void>
  exportPdf: (name: string) => Promise<boolean>
  onVaultChanged: (cb: () => void) => () => void
  onIndexChanged: (cb: () => void) => () => void
  onFileChanged: (cb: (path: string) => void) => () => void
  distillPick: () => Promise<DistillDocument | null>
  distillDiscardPick: (docId: string) => Promise<void>
  distillRegisterPath: (absPath: string) => Promise<string>
  distillRun: (docId: string, focus?: string, encoding?: string, preparedId?: string) => Promise<DistillRunResult>
  distillEstimate: (docId: string, focus?: string, encoding?: string, fromPreparedId?: string) => Promise<DistillEstimate>
  distillResume: (runId: string) => Promise<DistillRunResult>
  distillCancel: (runId: string) => Promise<void>
  distillGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ) => Promise<GraphData>
  distillBookOverview: (runId: string) => Promise<BookOverview | null>
  distillBookTheme: (runId: string, themeId: string | null) => Promise<BookThemeDetails | null>
  distillBookLink: (runId: string, source: string, target: string) => Promise<BookLinkEvidence | null>
  distillThemeGraph: (runId: string, themeId: string | null, cap?: number) => Promise<GraphData>
  distillOverlayGraph: (
    runId: string,
    focus?: string | null,
    opts?: { depth?: number; cap?: number; showSources?: boolean }
  ) => Promise<GraphData>
  distillListRuns: () => Promise<DistillRunInfo[]>
  distillRemove: (runId: string) => Promise<void>
  distillReadNote: (runId: string, note: string) => Promise<StagedNoteRead | null>
  distillLocateReadingCopy: (runId: string, note: string) => Promise<ReadingCopyPreview | null>
  distillChooseReadingCopy: (id: string, encoding?: string) => Promise<ReadingCopyPreview>
  distillSaveReadingCopy: (id: string) => Promise<ReadingCopy>
  distillDiscardReadingCopy: (id: string) => Promise<void>
  distillMergePlan: (runId: string) => Promise<DistillMergePlan>
  distillMerge: (runId: string, opts?: { sameAs?: string[] }) => Promise<DistillMergeResult>
  distillUnmerge: (runId: string) => Promise<DistillUnmergeResult>
  distillMergeStatus: (runId: string) => Promise<DistillMergeStatus>
  distillOpenOriginal: (hash: string) => Promise<string | null>
  figureAnalysisStatus: (path: string, id: string, runId?: string, context?: FigureContext) => Promise<FigureAnalysisStatus>
  analyzeFigure: (path: string, id: string, runId?: string, context?: FigureContext) => Promise<FigureAnalysis>
  onDistillProgress: (cb: (runId: string, p: DistillProgress) => void) => () => void
  onDistillEmbedRequest: (handler: (texts: string[]) => Promise<number[][]>) => () => void
  setMenuState: (s: MenuState) => void
  onMenuCommand: (cb: (cmd: string, arg?: string) => void) => () => void
}

declare global {
  interface Window {
    nodebook: NodebookApi
  }
}
