import { describe, it, expect } from 'vitest'
import {
  parseSettings,
  setThemeMode,
  setTalkEnabled,
  settingsSyntaxError,
  migrateEmbedModel,
  DEFAULTS,
  DEFAULT_TOML,
  DEFAULT_EMBED_MODEL
} from './settings'

describe('settingsSyntaxError', () => {
  it('is null for valid TOML (including the shipped defaults)', () => {
    expect(settingsSyntaxError(DEFAULT_TOML)).toBeNull()
    expect(settingsSyntaxError('')).toBeNull()
    expect(settingsSyntaxError('[editor]\nfontSize = 15\n')).toBeNull()
  })

  it('returns a short one-line message for broken TOML', () => {
    const err = settingsSyntaxError('[editor\nfontSize = 15\n')
    expect(err).toBeTruthy()
    expect(err!).not.toContain('\n') // one line, fit for an inline banner
  })
})

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
      relatedMinScore: DEFAULTS.talk.relatedMinScore, // no key in input → default
      embed: { runtime: 'native', model: 'Xenova/bge-small-en-v1.5', threads: 0 },
      chat: DEFAULTS.talk.chat // no [talk.chat] in the input → defaults
    })
    // defaults off; unknown runtime + non-boolean enabled fall back
    expect(parseSettings('').talk.enabled).toBe(false)
    expect(parseSettings('[talk.embed]\nruntime = "cuda"').talk.embed.runtime).toBe('wasm')
    expect(parseSettings('[talk]\nenabled = "yes"').talk.enabled).toBe(false)
  })

  it('upgrades an old shipped default embed model in place, and only that', () => {
    // The shape ensureSettingsFile wrote historically: key, old default, comment.
    const legacy = '[talk.embed]\nruntime = "wasm"\n# Embedding model.\nmodel = "Xenova/bge-small-en-v1.5"\n\n[talk.chat]\nmodel = ""\n'
    const out = migrateEmbedModel(legacy)
    expect(out).toContain(`model = "${DEFAULT_EMBED_MODEL}"`)
    expect(out).not.toContain('bge-small-en-v1.5')
    // Everything else byte-identical (comments, the chat model line, spacing).
    expect(out!.replace(`model = "${DEFAULT_EMBED_MODEL}"`, 'model = "Xenova/bge-small-en-v1.5"')).toBe(legacy)
    // A trailing comment on the model line survives.
    expect(migrateEmbedModel('model = "Xenova/bge-small-en-v1.5" # mine')).toBe(
      `model = "${DEFAULT_EMBED_MODEL}" # mine`
    )
  })

  it('leaves customized or missing embed models untouched', () => {
    expect(migrateEmbedModel('[talk.embed]\nmodel = "Xenova/all-MiniLM-L6-v2"')).toBeNull()
    expect(migrateEmbedModel(`[talk.embed]\nmodel = "${DEFAULT_EMBED_MODEL}"`)).toBeNull()
    expect(migrateEmbedModel('[talk.embed]\nruntime = "wasm"')).toBeNull()
    expect(migrateEmbedModel('')).toBeNull()
    // The legacy id as a substring of a custom id is not a match.
    expect(migrateEmbedModel('model = "mine/Xenova/bge-small-en-v1.5-tuned"')).toBeNull()
  })

  it('reads [talk.embed] threads and rejects negatives and non-integers', () => {
    expect(parseSettings('[talk.embed]\nthreads = 6').talk.embed.threads).toBe(6)
    expect(parseSettings('').talk.embed.threads).toBe(0) // default = auto
    expect(parseSettings('[talk.embed]\nthreads = -2').talk.embed.threads).toBe(0)
    expect(parseSettings('[talk.embed]\nthreads = 1.5').talk.embed.threads).toBe(0)
    expect(parseSettings('[talk.embed]\nthreads = "all"').talk.embed.threads).toBe(0)
  })

  it('reads [talk] relatedMinScore and clamps it to 0..1', () => {
    expect(parseSettings('[talk]\nrelatedMinScore = 0.7').talk.relatedMinScore).toBe(0.7)
    expect(parseSettings('[talk]\nrelatedMinScore = 0').talk.relatedMinScore).toBe(0)
    // out-of-range / wrong-typed falls back to the default
    expect(parseSettings('[talk]\nrelatedMinScore = 1.5').talk.relatedMinScore).toBe(
      DEFAULTS.talk.relatedMinScore
    )
    expect(parseSettings('[talk]\nrelatedMinScore = -0.2').talk.relatedMinScore).toBe(
      DEFAULTS.talk.relatedMinScore
    )
    expect(parseSettings('[talk]\nrelatedMinScore = "high"').talk.relatedMinScore).toBe(
      DEFAULTS.talk.relatedMinScore
    )
  })

  it('reads [talk.chat] config and validates the provider', () => {
    const s = parseSettings(
      '[talk.chat]\nprovider = "anthropic"\nmodel = "claude-x"\nbaseUrl = "http://h/v1"'
    )
    expect(s.talk.chat).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
      baseUrl: 'http://h/v1',
      command: '',
      args: []
    })
    // unknown provider falls back to "none" (search-only)
    expect(parseSettings('[talk.chat]\nprovider = "bogus"').talk.chat.provider).toBe('none')
  })

  it('accepts the "ollama" local-LLM provider', () => {
    const s = parseSettings('[talk.chat]\nprovider = "ollama"\nmodel = "llama3.2"')
    expect(s.talk.chat.provider).toBe('ollama')
    expect(s.talk.chat.model).toBe('llama3.2')
  })

  it('accepts the "codex-cli" and "cli" providers', () => {
    expect(parseSettings('[talk.chat]\nprovider = "codex-cli"').talk.chat.provider).toBe('codex-cli')
    expect(parseSettings('[talk.chat]\nprovider = "cli"').talk.chat.provider).toBe('cli')
  })

  it('defaults model to empty (provider default), not a hardcoded model id', () => {
    expect(DEFAULTS.talk.chat.model).toBe('')
    expect(parseSettings('').talk.chat.model).toBe('')
  })

  it('reads command and args for CLI providers', () => {
    const s = parseSettings(
      '[talk.chat]\nprovider = "cli"\ncommand = "/opt/homebrew/bin/claude"\nargs = ["-p", "--verbose"]'
    )
    expect(s.talk.chat.command).toBe('/opt/homebrew/bin/claude')
    expect(s.talk.chat.args).toEqual(['-p', '--verbose'])
    // missing command/args fall back to defaults
    expect(parseSettings('[talk.chat]\nprovider = "codex-cli"').talk.chat).toEqual({
      provider: 'codex-cli',
      model: '',
      baseUrl: '',
      command: '',
      args: []
    })
  })

  it('filters non-string entries out of args', () => {
    expect(
      parseSettings('[talk.chat]\nargs = ["ok", 1, true, "also-ok"]').talk.chat.args
    ).toEqual(['ok', 'also-ok'])
    // non-array args falls back to []
    expect(parseSettings('[talk.chat]\nargs = "not-an-array"').talk.chat.args).toEqual([])
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
