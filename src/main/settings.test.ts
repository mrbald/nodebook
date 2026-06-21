import { describe, it, expect } from 'vitest'
import { parseSettings, setThemeMode, setTalkEnabled, DEFAULTS, DEFAULT_TOML } from './settings'

describe('parseSettings', () => {
  it('reads valid values', () => {
    const s = parseSettings(
      '[editor]\nfontSize = 18\n[theme]\nfollowSystem = false\ndark = "dracula"\nlight = "solarized-light"\nname = "nord"'
    )
    expect(s).toEqual({
      editor: { fontSize: 18, autosaveDelayMs: 0, autosaveOnSwitch: true, defaultMode: 'live' },
      theme: { followSystem: false, dark: 'dracula', light: 'solarized-light', name: 'nord' },
      talk: DEFAULTS.talk,
      telemetry: DEFAULTS.telemetry
    })
  })

  it('validates defaultMode against the allowed view modes', () => {
    expect(parseSettings('[editor]\ndefaultMode = "reading"').editor.defaultMode).toBe('reading')
    expect(parseSettings('[editor]\ndefaultMode = "code"').editor.defaultMode).toBe('code')
    // unknown / wrong-typed falls back to the default
    expect(parseSettings('[editor]\ndefaultMode = "zoom"').editor.defaultMode).toBe(
      DEFAULTS.editor.defaultMode
    )
    expect(parseSettings('[editor]\ndefaultMode = 3').editor.defaultMode).toBe(
      DEFAULTS.editor.defaultMode
    )
  })

  it('reads autosave settings and validates them', () => {
    const s = parseSettings('[editor]\nautosaveDelayMs = 800\nautosaveOnSwitch = false')
    expect(s.editor.autosaveDelayMs).toBe(800)
    expect(s.editor.autosaveOnSwitch).toBe(false)
    // negative / non-number delay falls back; non-boolean onSwitch falls back
    expect(parseSettings('[editor]\nautosaveDelayMs = -5').editor.autosaveDelayMs).toBe(
      DEFAULTS.editor.autosaveDelayMs
    )
    expect(parseSettings('[editor]\nautosaveOnSwitch = "no"').editor.autosaveOnSwitch).toBe(
      DEFAULTS.editor.autosaveOnSwitch
    )
  })

  it('round-trips the shipped DEFAULT_TOML to the DEFAULTS object', () => {
    expect(parseSettings(DEFAULT_TOML)).toEqual(DEFAULTS)
  })

  it('fills missing keys with defaults', () => {
    expect(parseSettings('[editor]\nfontSize = 20')).toEqual({
      editor: { ...DEFAULTS.editor, fontSize: 20 },
      theme: { ...DEFAULTS.theme },
      talk: DEFAULTS.talk,
      telemetry: DEFAULTS.telemetry
    })
    expect(parseSettings('')).toEqual(DEFAULTS)
  })

  it('reads [telemetry] enabled and defaults it off', () => {
    expect(parseSettings('[telemetry]\nenabled = true').telemetry.enabled).toBe(true)
    expect(parseSettings('').telemetry.enabled).toBe(false)
    expect(parseSettings('[telemetry]\nenabled = "yes"').telemetry.enabled).toBe(false)
  })

  it('reads [talk] config and validates the runtime + enabled flag', () => {
    const s = parseSettings(
      '[talk]\nenabled = true\n[talk.embed]\nruntime = "native"\nmodel = "Xenova/bge-small-en-v1.5"'
    )
    expect(s.talk).toEqual({
      enabled: true,
      embed: { runtime: 'native', model: 'Xenova/bge-small-en-v1.5' }
    })
    // defaults off; unknown runtime + non-boolean enabled fall back
    expect(parseSettings('').talk.enabled).toBe(false)
    expect(parseSettings('[talk.embed]\nruntime = "cuda"').talk.embed.runtime).toBe('wasm')
    expect(parseSettings('[talk]\nenabled = "yes"').talk.enabled).toBe(false)
  })

  it('keeps followSystem default unless it is a real boolean', () => {
    expect(parseSettings('[theme]\nfollowSystem = false').theme.followSystem).toBe(false)
    expect(parseSettings('[theme]\nfollowSystem = "yes"').theme.followSystem).toBe(
      DEFAULTS.theme.followSystem
    )
  })

  it('accepts any theme-name string but rejects non-strings', () => {
    expect(parseSettings('[theme]\nname = "dracula"').theme.name).toBe('dracula')
    expect(parseSettings('[theme]\nname = 42').theme.name).toBe(DEFAULTS.theme.name)
  })

  it('rejects a wrong-typed fontSize back to the default', () => {
    expect(parseSettings('[editor]\nfontSize = "big"').editor.fontSize).toBe(
      DEFAULTS.editor.fontSize
    )
  })

  it('never throws on malformed TOML — returns defaults', () => {
    expect(parseSettings('this is = = not toml [[[')).toEqual(DEFAULTS)
  })
})

describe('setTalkEnabled', () => {
  it('flips [talk] enabled in place, preserving comments, round-tripping', () => {
    const on = setTalkEnabled(DEFAULT_TOML, true)
    expect(on).toContain('# Nodebook settings') // comments survived
    expect(parseSettings(on).talk.enabled).toBe(true)
    expect(parseSettings(setTalkEnabled(on, false)).talk.enabled).toBe(false)
  })

  it('creates the [talk] section / key when missing', () => {
    expect(parseSettings(setTalkEnabled('[editor]\nfontSize = 16', true)).talk.enabled).toBe(true)
    expect(parseSettings(setTalkEnabled('', true)).talk.enabled).toBe(true)
  })
})

describe('setThemeMode', () => {
  it('edits keys in place and preserves comments, round-tripping via parseSettings', () => {
    const dark = setThemeMode(DEFAULT_TOML, 'dark')
    expect(dark).toContain('# Nodebook settings') // comment survived
    expect(parseSettings(dark).theme).toEqual({
      followSystem: false,
      dark: 'dark',
      light: 'light',
      name: 'dark'
    })

    const light = setThemeMode(DEFAULT_TOML, 'light')
    expect(parseSettings(light).theme.followSystem).toBe(false)
    expect(parseSettings(light).theme.name).toBe('light')

    const system = setThemeMode(light, 'system')
    expect(parseSettings(system).theme.followSystem).toBe(true)
  })

  it('creates the [theme] section / keys when missing', () => {
    expect(parseSettings(setThemeMode('[editor]\nfontSize = 16', 'dark')).theme).toEqual({
      followSystem: false,
      dark: 'dark',
      light: 'light',
      name: 'dark'
    })
    expect(parseSettings(setThemeMode('', 'system')).theme.followSystem).toBe(true)
  })
})
