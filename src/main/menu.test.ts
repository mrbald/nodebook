import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { menuTemplate, vaultLabel, type MenuDeps } from './menu'

const ALL_ON = { hasVault: true, hasNote: true, canSave: true, canAsk: true }

const deps = (over: Partial<MenuDeps> = {}): MenuDeps => ({
  isMac: true,
  appName: 'Nodebook',
  state: ALL_ON,
  recents: [],
  send: () => {},
  openExternal: () => {},
  showAbout: () => {},
  clearRecents: () => {},
  ...over
})

const sub = (items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] =>
  (items.find((m) => m.label === label || m.role === label)?.submenu as MenuItemConstructorOptions[]) ?? []
const item = (items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined =>
  items.find((m) => m.label === label)
const labels = (items: MenuItemConstructorOptions[]): string[] =>
  items.filter((m) => m.label).map((m) => m.label as string)
const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.filter((m) => m.role).map((m) => String(m.role))

describe('menuTemplate', () => {
  it('File has the core verbs with their shortcuts', () => {
    const file = sub(menuTemplate(deps()), 'File')
    expect(labels(file)).toEqual(
      expect.arrayContaining([
        'New Note',
        'New Vault…',
        'Open Vault…',
        'Open Recent',
        'Save',
        'Export PDF…',
        'Print…'
      ])
    )
    expect(item(file, 'New Note')?.accelerator).toBe('CmdOrCtrl+N')
    expect(item(file, 'Open Vault…')?.accelerator).toBe('CmdOrCtrl+O')
    expect(item(file, 'Save')?.accelerator).toBe('CmdOrCtrl+S')
  })

  it('Open Recent lists vaults (by folder name) + Clear, and is disabled when empty', () => {
    const empty = sub(sub(menuTemplate(deps()), 'File'), 'Open Recent')
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ label: 'No Recent Vaults', enabled: false })

    const calls: Array<[string, string?]> = []
    const tpl = menuTemplate(deps({ recents: ['/home/me/notes', '/tmp/scratch'], send: (c, a) => calls.push([c, a]) }))
    const recent = sub(sub(tpl, 'File'), 'Open Recent')
    expect(labels(recent)).toEqual(['notes', 'scratch', 'Clear Recently Opened'])
    ;(recent[0].click as () => void)()
    expect(calls).toEqual([['open-vault', '/home/me/notes']])
  })

  it('View drops Reload and adds Knowledge Map (⌘G) + Ask', () => {
    const view = sub(menuTemplate(deps()), 'View')
    expect(roles(view)).not.toContain('reload')
    expect(labels(view)).toEqual(expect.arrayContaining(['Knowledge Map', 'Ask Your Notes']))
    expect(item(view, 'Knowledge Map')?.accelerator).toBe('CmdOrCtrl+G')
  })

  it('no duplicate full-screen: macOS lets the system add it; other OSes add our own', () => {
    expect(roles(sub(menuTemplate(deps({ isMac: true })), 'View'))).not.toContain('togglefullscreen')
    expect(roles(sub(menuTemplate(deps({ isMac: false })), 'View'))).toContain('togglefullscreen')
  })

  it('Help has Keyboard Shortcuts, Learn More, and DevTools moved here', () => {
    const help = sub(menuTemplate(deps()), 'help')
    expect(labels(help)).toEqual(
      expect.arrayContaining(['Markdown & Syntax', 'Keyboard Shortcuts', 'Learn More / Report an Issue'])
    )
    expect(roles(help)).toContain('toggleDevTools')
  })

  it('macOS puts Preferences (⌘,) in the app menu; About lives there too', () => {
    const tpl = menuTemplate(deps({ isMac: true }))
    const appMenu = sub(tpl, 'Nodebook')
    expect(item(appMenu, 'Preferences…')?.accelerator).toBe('CmdOrCtrl+,')
    expect(roles(appMenu)).toContain('about')
    // No separate About in Help on macOS (the app menu owns it).
    expect(labels(sub(tpl, 'help'))).not.toContain('About Nodebook')
  })

  it('non-macOS has no app menu; Preferences moves to File and About to Help', () => {
    const tpl = menuTemplate(deps({ isMac: false }))
    expect(tpl[0].label).toBe('File') // no leading app menu
    expect(labels(sub(tpl, 'File'))).toContain('Preferences…')
    expect(labels(sub(tpl, 'help'))).toContain('About Nodebook')
  })

  it('greys out actions that do not apply (states hygiene)', () => {
    const tpl = menuTemplate(deps({ state: { hasVault: false, hasNote: false, canSave: false, canAsk: false } }))
    const file = sub(tpl, 'File')
    const view = sub(tpl, 'View')
    expect(item(file, 'New Note')?.enabled).toBe(false) // no vault
    expect(item(file, 'Save')?.enabled).toBe(false) // nothing savable
    expect(item(file, 'Export PDF…')?.enabled).toBe(false) // no note
    expect(item(file, 'Print…')?.enabled).toBe(false)
    expect(item(view, 'Knowledge Map')?.enabled).toBe(false)
    expect(item(view, 'Ask Your Notes')?.enabled).toBe(false)
    // Always-available actions are not gated.
    expect(item(file, 'Open Vault…')?.enabled).toBeUndefined()
    expect(item(file, 'New Vault…')?.enabled).toBeUndefined()
  })

  it('enables note/vault actions when their preconditions hold', () => {
    const file = sub(menuTemplate(deps({ state: ALL_ON })), 'File')
    expect(item(file, 'New Note')?.enabled).toBe(true)
    expect(item(file, 'Save')?.enabled).toBe(true)
    expect(item(file, 'Export PDF…')?.enabled).toBe(true)
  })
})

describe('vaultLabel', () => {
  it('shows the vault folder name', () => {
    expect(vaultLabel('/home/me/my-notes')).toBe('my-notes')
    expect(vaultLabel('C:\\Users\\me\\notes')).toBe('notes')
    expect(vaultLabel('/trailing/slash/')).toBe('slash')
  })
})
