import type {
  Backlink,
  GraphData,
  Outbound,
  SearchHit,
  Settings,
  TalkChunk,
  TalkNeighbor,
  TalkStatus,
  TelemetrySnapshot,
  VaultListing
} from '../shared/types'

export interface NodebookApi {
  pickVault: () => Promise<string | null>
  createVault: () => Promise<string | null>
  openVault: (root: string) => Promise<VaultListing>
  listVault: (root: string) => Promise<VaultListing>
  createFile: (dir: string, name: string) => Promise<string | null>
  createDir: (dir: string, name: string) => Promise<string | null>
  rename: (path: string, newName: string) => Promise<string | null>
  deletePath: (path: string) => Promise<boolean>
  readFile: (path: string) => Promise<string>
  saveFile: (path: string, content: string) => Promise<void>
  saveFileNow: (path: string, content: string) => void
  backlinks: (target: string) => Promise<Backlink[]>
  outbound: (sourceFile: string) => Promise<Outbound[]>
  search: (query: string) => Promise<SearchHit[]>
  noteNames: () => Promise<string[]>
  graph: (focusPath: string | null, opts?: { depth?: number; cap?: number }) => Promise<GraphData>
  typeRelation: (sourcePath: string, relation: string, target: string) => Promise<boolean>
  talkStatus: () => Promise<TalkStatus>
  talkEnable: (dims: number) => Promise<TalkStatus>
  talkDisable: () => Promise<TalkStatus>
  talkPending: (limit: number) => Promise<TalkChunk[]>
  talkPutEmbeddings: (rows: { id: number; vector: number[] }[]) => Promise<TalkStatus>
  talkSearch: (query: string, vector: number[]) => Promise<SearchHit[]>
  talkNeighbors: (focusPath: string, k?: number) => Promise<TalkNeighbor[]>
  talkSemanticEdges: (paths: string[], k?: number) => Promise<{ source: string; target: string }[]>
  onTalkDirty: (cb: () => void) => () => void
  telemetryApply: (enabled: boolean) => Promise<void>
  telemetrySnapshot: () => Promise<TelemetrySnapshot | null>
  settingsPath: () => Promise<string>
  readSettings: () => Promise<Settings>
  setThemeMode: (mode: 'system' | 'dark' | 'light') => Promise<Settings>
  resetSettings: () => Promise<string>
  defaultSettings: () => Promise<string>
  openExternal: (url: string) => Promise<void>
  exportPdf: (name: string) => Promise<boolean>
  onVaultChanged: (cb: () => void) => () => void
  onIndexChanged: (cb: () => void) => () => void
  onMenuCommand: (cb: (cmd: string) => void) => () => void
}

declare global {
  interface Window {
    nodebook: NodebookApi
  }
}
