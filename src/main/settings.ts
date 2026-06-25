import { app } from 'electron'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { parse as parseToml } from 'smol-toml'
import type { Settings } from '../shared/types'
import type { ProviderConfig } from './rag/provider'

/**
 * App-level settings, stored as hand-editable TOML at
 * `<userData>/settings.toml`. Parsing is split into a pure `parseSettings`
 * (golden-tested, no fs/electron) and a thin fs wrapper. Unknown keys are
 * ignored; missing or malformed values fall back to defaults, so a broken file
 * never crashes the app — it just reverts a value.
 */

export const DEFAULTS: Settings = {
  editor: { fontSize: 15, autosaveDelayMs: 0, autosaveOnSwitch: true, defaultMode: 'live' },
  theme: { followSystem: true, dark: 'dark', light: 'light', name: 'dark' },
  talk: {
    enabled: false,
    relatedMinScore: 0.5,
    embed: { runtime: 'wasm', model: 'Xenova/all-MiniLM-L6-v2' },
    chat: { provider: 'none', model: 'claude-sonnet-4-6', baseUrl: '' }
  },
  telemetry: { enabled: false }
}

const MODES = ['code', 'live', 'reading'] as const
const RUNTIMES = ['wasm', 'native'] as const
const CHAT_PROVIDERS = ['none', 'anthropic', 'openai-compat', 'ollama'] as const

export const DEFAULT_TOML = `# Nodebook settings — every option with its default. Edit and save; changes
# apply live (⌘S to save now). "Reveal defaults" shows this reference next to
# your settings; "Reset to defaults" overwrites your file with it.

[editor]
# Editor font size, in pixels.
fontSize = 15
# Autosave after you stop typing for this many ms. 0 = off (save with ⌘S).
autosaveDelayMs = 0
# Also autosave when you switch notes or close the window.
autosaveOnSwitch = true
# View mode a note opens in: "code" (raw + highlight), "live" (hybrid), or
# "reading" (styled, read-only).
defaultMode = "live"

[theme]
# Themes color the whole app and the editor together.
# Available: dark, light, one-dark, dracula, nord, solarized-light

# Follow the OS light/dark appearance. When on, "dark" and "light" pick the
# theme for each mode; when off, "name" is always used.
followSystem = true
dark = "dark"
light = "light"
name = "dark"

[talk]
# "Talk to docs" — AI semantic search over your notes. Off by default and fully
# local: when enabled, a small embedding model downloads once and your notes are
# indexed on-device — they never leave your machine. Nothing loads until enabled.
enabled = false
# How alike two notes must be (0..1) for the map's ✨ "related" overlay and
# "colour by meaning" to connect them. Higher = stricter (fewer, surer hints);
# lower = more suggestions. Raise it if a small vault flags unrelated notes.
relatedMinScore = 0.5

[talk.embed]
# Embedding runtime: "wasm" (lean, cross-platform, no native binary) or
# "native" (faster, larger). WASM runs in a background worker.
runtime = "wasm"
# Embedding model (a transformers.js repo). Downloaded on first enable.
model = "Xenova/all-MiniLM-L6-v2"

[talk.chat]
# "Ask" chat over your notes. "none" = search-only (no LLM, fully local).
# "ollama" = a local model via Ollama (free, private, no key — install Ollama,
# run e.g. "ollama pull llama3.2", then set model below). "anthropic" = Claude
# (cloud). "openai-compat" = any OpenAI-style endpoint (set baseUrl), e.g. LM
# Studio or a remote/gateway. Only the retrieved note passages are sent to the
# model, never your whole vault.
provider = "none"
model = "claude-sonnet-4-6"
# Base URL for "openai-compat". Optional for "ollama" (defaults to the local
# server, http://localhost:11434/v1) — set it only for a non-default host/port.
baseUrl = ""
# API key: prefer the ANTHROPIC_API_KEY / OPENAI_API_KEY environment variable.
# You may instead set it here, but it is stored in plain text — env is safer.
# apiKey = ""

[telemetry]
# Show a tiny status-bar widget with event-loop lag (a log-bucketed histogram),
# plus rolling CPU and memory — "measure everything". Off by default.
enabled = false
`

/** Pure: TOML text → validated Settings, defaults filling any gap. */
export function parseSettings(raw: string): Settings {
  let data: Record<string, unknown>
  try {
    data = parseToml(raw) as Record<string, unknown>
  } catch {
    return structuredClone(DEFAULTS)
  }
  const editor = (data.editor ?? {}) as Record<string, unknown>
  const theme = (data.theme ?? {}) as Record<string, unknown>
  const talk = (data.talk ?? {}) as Record<string, unknown>
  const embed = (talk.embed ?? {}) as Record<string, unknown>
  const chat = (talk.chat ?? {}) as Record<string, unknown>
  const telemetry = (data.telemetry ?? {}) as Record<string, unknown>
  const runtime = RUNTIMES.includes(embed.runtime as (typeof RUNTIMES)[number])
    ? (embed.runtime as (typeof RUNTIMES)[number])
    : DEFAULTS.talk.embed.runtime
  const chatProvider = CHAT_PROVIDERS.includes(chat.provider as (typeof CHAT_PROVIDERS)[number])
    ? (chat.provider as (typeof CHAT_PROVIDERS)[number])
    : DEFAULTS.talk.chat.provider
  const fontSize = Number(editor.fontSize)
  const delay = Number(editor.autosaveDelayMs)
  const mode = MODES.includes(editor.defaultMode as (typeof MODES)[number])
    ? (editor.defaultMode as (typeof MODES)[number])
    : DEFAULTS.editor.defaultMode
  // Theme names pass through as any non-empty string; the renderer resolves
  // unknown names to the default, so main needn't know the theme registry.
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v ? v : fallback
  return {
    editor: {
      fontSize: Number.isFinite(fontSize) ? fontSize : DEFAULTS.editor.fontSize,
      autosaveDelayMs:
        Number.isFinite(delay) && delay >= 0 ? delay : DEFAULTS.editor.autosaveDelayMs,
      autosaveOnSwitch:
        typeof editor.autosaveOnSwitch === 'boolean'
          ? editor.autosaveOnSwitch
          : DEFAULTS.editor.autosaveOnSwitch,
      defaultMode: mode
    },
    theme: {
      followSystem:
        typeof theme.followSystem === 'boolean'
          ? theme.followSystem
          : DEFAULTS.theme.followSystem,
      dark: str(theme.dark, DEFAULTS.theme.dark),
      light: str(theme.light, DEFAULTS.theme.light),
      name: str(theme.name, DEFAULTS.theme.name)
    },
    talk: {
      enabled: typeof talk.enabled === 'boolean' ? talk.enabled : DEFAULTS.talk.enabled,
      relatedMinScore:
        Number.isFinite(Number(talk.relatedMinScore)) &&
        Number(talk.relatedMinScore) >= 0 &&
        Number(talk.relatedMinScore) <= 1
          ? Number(talk.relatedMinScore)
          : DEFAULTS.talk.relatedMinScore,
      embed: { runtime, model: str(embed.model, DEFAULTS.talk.embed.model) },
      chat: {
        provider: chatProvider,
        model: str(chat.model, DEFAULTS.talk.chat.model),
        baseUrl: str(chat.baseUrl, DEFAULTS.talk.chat.baseUrl)
      }
    },
    telemetry: {
      enabled:
        typeof telemetry.enabled === 'boolean'
          ? telemetry.enabled
          : DEFAULTS.telemetry.enabled
    }
  }
}

export type ThemeMode = 'system' | 'dark' | 'light'

/**
 * Pure: apply a quick theme choice to TOML text, editing the existing keys in
 * place so the user's comments survive. `system` → followSystem=true (keeps the
 * dark/light picks); `dark`/`light` → followSystem=false + name set. Missing
 * keys/section are created.
 */
export function setThemeMode(raw: string, mode: ThemeMode): string {
  const setKey = (text: string, key: string, value: string): string => {
    const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm')
    if (re.test(text)) return text.replace(re, `$1${value}`)
    if (/^\[theme\]/m.test(text)) {
      return text.replace(/^\[theme\][^\n]*$/m, (h) => `${h}\n${key} = ${value}`)
    }
    return `${text.replace(/\s*$/, '')}\n\n[theme]\n${key} = ${value}\n`
  }
  let out = setKey(raw, 'followSystem', mode === 'system' ? 'true' : 'false')
  if (mode !== 'system') out = setKey(out, 'name', `"${mode}"`)
  return out
}

/**
 * Pure: flip `[talk] enabled` in TOML text, editing in place so the user's
 * comments survive. Creates the key/section if missing. (`enabled` is unique to
 * `[talk]` in our schema, so a plain key match is unambiguous.)
 */
export function setTalkEnabled(raw: string, enabled: boolean): string {
  const val = enabled ? 'true' : 'false'
  const re = /^(\s*enabled\s*=\s*).*$/m
  if (re.test(raw)) return raw.replace(re, `$1${val}`)
  if (/^\[talk\]/m.test(raw)) {
    return raw.replace(/^\[talk\][^\n]*$/m, (h) => `${h}\nenabled = ${val}`)
  }
  return `${raw.replace(/\s*$/, '')}\n\n[talk]\nenabled = ${val}\n`
}

export function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.toml')
}

/** Create the settings file with documented defaults if it does not exist. */
export function ensureSettingsFile(): string {
  const path = settingsPath()
  if (!existsSync(path)) writeFileSync(path, DEFAULT_TOML, 'utf8')
  return path
}

export function readSettings(): Settings {
  ensureSettingsFile()
  try {
    return parseSettings(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return structuredClone(DEFAULTS)
  }
}

/**
 * The chat ProviderConfig for "Ask", including the API key — read from the
 * environment first (ANTHROPIC_API_KEY / OPENAI_API_KEY), then the settings file.
 * Stays in main: the key is never returned to the renderer. `null` when chat is
 * off (`provider = "none"`).
 */
export function chatProviderConfig(): ProviderConfig | null {
  const s = readSettings()
  if (s.talk.chat.provider === 'none') return null
  let chatRaw: Record<string, unknown> = {}
  try {
    const raw = parseToml(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
    const talkRaw = (raw.talk ?? {}) as Record<string, unknown>
    chatRaw = (talkRaw.chat ?? {}) as Record<string, unknown>
  } catch {
    /* fall through to env-only */
  }
  const tomlKey = typeof chatRaw.apiKey === 'string' ? chatRaw.apiKey : ''
  const envKey =
    s.talk.chat.provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY
  return {
    kind: s.talk.chat.provider,
    model: s.talk.chat.model,
    baseUrl: s.talk.chat.baseUrl || undefined,
    apiKey: envKey || tomlKey || undefined
  }
}
