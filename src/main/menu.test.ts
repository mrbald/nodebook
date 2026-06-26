import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { menuTemplate, vaultLabel, type MenuDeps } from './menu'

const deps = (over: Partial<MenuDeps> = {}): MenuDeps => ({
  isMac: true,
  appName: 'Nodebook',
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
})

describe('vaultLabel', () => {
  it('shows the vault folder name', () => {
    expect(vaultLabel('/home/me/my-notes')).toBe('my-notes')
    expect(vaultLabel('C:\\Users\\me\\notes')).toBe('notes')
    expect(vaultLabel('/trailing/slash/')).toBe('slash')
  })
})
