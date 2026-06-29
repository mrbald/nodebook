import { app, dialog, shell, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import type { MenuState } from '../shared/types'
import { readRecents, clearRecents } from './recents'

/** The project home, used by Help ▸ Learn More / About. A hard-coded constant. */
const REPO_URL = 'https://github.com/mrbald/nodebook'

/** Display label for a recent vault: its folder name. */
export function vaultLabel(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

export interface MenuDeps {
  isMac: boolean
  appName: string
  /** Which actions currently apply (greys out the rest). */
  state: MenuState
  /** Recent vault paths, most-recent-first. */
  recents: string[]
  /** Send a command (with optional payload) to the renderer. */
  send: (cmd: string, arg?: string) => void
  /** Open a URL in the system browser. */
  openExternal: (url: string) => void
  /** Show the About box (used on Windows/Linux, which have no app menu). */
  showAbout: () => void
  /** Forget recent vaults and rebuild the menu. */
  clearRecents: () => void
}

/**
 * Pure: build the application-menu template. All side effects are injected as
 * callbacks and Electron is only referenced for the `MenuItemConstructorOptions`
 * *type*, so this is unit-testable without an Electron runtime.
 */
export function menuTemplate(d: MenuDeps): MenuItemConstructorOptions[] {
  const { isMac, recents, send, state } = d

  const openRecentSubmenu: MenuItemConstructorOptions[] = recents.length
    ? [
        ...recents.map((p) => ({ label: vaultLabel(p), click: () => send('open-vault', p) })),
        { type: 'separator' as const },
        { label: 'Clear Recently Opened', click: () => d.clearRecents() }
      ]
    : [{ label: 'No Recent Vaults', enabled: false }]

  const preferences: MenuItemConstructorOptions = {
    label: 'Preferences…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send('settings')
  }

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: d.appName,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            preferences,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : []

  const fileTail: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'close' }]
    : [preferences, { type: 'separator' }, { role: 'quit' }]

  const helpExtras: MenuItemConstructorOptions[] = isMac
    ? []
    : [{ label: 'About Nodebook', click: () => d.showAbout() }]

  return [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', enabled: state.hasVault, click: () => send('new-note') },
        { label: 'New Vault…', click: () => send('new-vault') },
        { type: 'separator' },
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+O', click: () => send('open-vault-dialog') },
        { label: 'Open Recent', submenu: openRecentSubmenu },
        { type: 'separator' },
        { label: 'Distill a Document…', enabled: state.hasVault, click: () => send('distill') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: state.canSave, click: () => send('save') },
        { type: 'separator' },
        { label: 'Export PDF…', enabled: state.hasNote, click: () => send('export-pdf') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', enabled: state.hasNote, click: () => send('print') },
        { type: 'separator' },
        ...fileTail
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Code', accelerator: 'CmdOrCtrl+1', click: () => send('mode-code') },
        { label: 'Live', accelerator: 'CmdOrCtrl+2', click: () => send('mode-live') },
        { label: 'Reading', accelerator: 'CmdOrCtrl+3', click: () => send('mode-reading') },
        { label: 'Toggle Reading', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-read') },
        { type: 'separator' },
        { label: 'Knowledge Map', accelerator: 'CmdOrCtrl+G', enabled: state.hasNote, click: () => send('map') },
        { label: 'Ask Your Notes', enabled: state.canAsk, click: () => send('ask') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        // macOS auto-adds "Enter Full Screen" to the View menu, so only add our
        // own on Windows/Linux — otherwise it shows twice.
        ...((isMac
          ? []
          : [{ type: 'separator' }, { role: 'togglefullscreen' }]) as MenuItemConstructorOptions[])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Markdown & Syntax', click: () => send('help') },
        { label: 'Keyboard Shortcuts', click: () => send('help') },
        { type: 'separator' },
        ...helpExtras,
        { label: 'Learn More / Report an Issue', click: () => d.openExternal(REPO_URL) },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ]
}

/** Build + install the application menu. Reads the live recents list; pass a
 *  getter for the window so the menu works regardless of build/create order and
 *  across window recreation, plus the current enabled-state. Call again whenever
 *  recents or the state change. */
export function buildAppMenu(getWin: () => BrowserWindow | null, state: MenuState): void {
  const showAbout = (): void => {
    void dialog.showMessageBox(getWin() ?? undefined!, {
      type: 'info',
      title: 'About Nodebook',
      message: 'Nodebook',
      detail: `Version ${app.getVersion()}\nA local-first, source-mode Markdown notebook.\n${REPO_URL}`,
      buttons: ['OK']
    })
  }
  const template = menuTemplate({
    isMac: process.platform === 'darwin',
    appName: app.name,
    state,
    recents: readRecents(),
    send: (cmd, arg) => getWin()?.webContents.send('menu:command', cmd, arg),
    openExternal: (url) => void shell.openExternal(url),
    showAbout,
    clearRecents: () => {
      clearRecents()
      buildAppMenu(getWin, state)
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
