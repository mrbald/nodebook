import { contextBridge, ipcRenderer } from 'electron'
import type { Backlink, Outbound, SearchHit, Settings, VaultListing } from '../shared/types'

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
  settingsPath: (): Promise<string> => ipcRenderer.invoke('settings:path'),
  readSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:read'),
  setThemeMode: (mode: 'system' | 'dark' | 'light'): Promise<Settings> =>
    ipcRenderer.invoke('settings:setThemeMode', mode),
  resetSettings: (): Promise<string> => ipcRenderer.invoke('settings:reset'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  exportPdf: (name: string): Promise<boolean> => ipcRenderer.invoke('pdf:export', name),
  /** Subscribe to vault file/dir changes; returns an unsubscribe function. */
  onVaultChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('vault:changed', listener)
    return () => ipcRenderer.removeListener('vault:changed', listener)
  },
  /** Subscribe to application-menu commands (export-pdf, print, toggle-read). */
  onMenuCommand: (cb: (cmd: string) => void): (() => void) => {
    const listener = (_e: unknown, cmd: string): void => cb(cmd)
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
