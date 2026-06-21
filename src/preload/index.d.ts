import type {
  Backlink,
  Outbound,
  SearchHit,
  Settings,
  TalkChunk,
  TalkStatus,
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
  talkStatus: () => Promise<TalkStatus>
  talkEnable: (dims: number) => Promise<TalkStatus>
  talkDisable: () => Promise<TalkStatus>
  talkPending: (limit: number) => Promise<TalkChunk[]>
  talkPutEmbeddings: (rows: { id: number; vector: number[] }[]) => Promise<TalkStatus>
  talkSearch: (query: string, vector: number[]) => Promise<SearchHit[]>
  onTalkDirty: (cb: () => void) => () => void
  settingsPath: () => Promise<string>
  readSettings: () => Promise<Settings>
  setThemeMode: (mode: 'system' | 'dark' | 'light') => Promise<Settings>
  resetSettings: () => Promise<string>
  openExternal: (url: string) => Promise<void>
  exportPdf: (name: string) => Promise<boolean>
  onVaultChanged: (cb: () => void) => () => void
  onMenuCommand: (cb: (cmd: string) => void) => () => void
}

declare global {
  interface Window {
    nodebook: NodebookApi
  }
}
