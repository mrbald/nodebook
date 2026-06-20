import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Unified themes: each one carries BOTH the app chrome palette (CSS variables)
 * and the CodeMirror editor extension, built from a single `Palette` so the app
 * and the editor can never drift apart. The editor background is transparent and
 * inherits the app's `--bg`, so applying a theme = set the CSS vars (App) and
 * reconfigure the editor compartment (useCodeMirror) — both from the same source.
 */

interface Palette {
  dark: boolean
  // chrome
  bg: string
  bgElev: string
  border: string
  text: string
  muted: string
  accent: string
  accentBg: string
  codeBg: string
  // syntax
  heading: string
  keyword: string
  string: string
  number: string
  comment: string
  property: string
  variable: string
  operator: string
  tag: string
}

export interface Theme {
  name: string
  dark: boolean
  /** App CSS variables (set on :root). */
  vars: Record<string, string>
  /** CodeMirror extension (chrome + syntax). */
  editor: Extension
  /** The syntax HighlightStyle (exposed for regression tests). */
  highlight: HighlightStyle
}

function build(name: string, p: Palette): Theme {
  const vars = {
    '--bg': p.bg,
    '--bg-elev': p.bgElev,
    '--border': p.border,
    '--text': p.text,
    '--muted': p.muted,
    '--accent': p.accent,
    '--accent-bg': p.accentBg,
    '--code-bg': p.codeBg
  }

  const chrome = EditorView.theme(
    {
      '&': { color: p.text, backgroundColor: 'transparent' },
      '.cm-content': { caretColor: p.text },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.text },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: p.accentBg
      },
      '.cm-activeLine': {
        backgroundColor: p.dark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)'
      },
      '.cm-gutters': { backgroundColor: 'transparent', color: p.muted, border: 'none' },
      '.cm-activeLineGutter': {
        backgroundColor: p.dark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)'
      },
      '.cm-tooltip': { backgroundColor: p.bgElev, border: `1px solid ${p.border}`, color: p.text },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: p.accentBg,
        color: p.text
      }
    },
    { dark: p.dark }
  )

  const mono = "'SF Mono', ui-monospace, Menlo, monospace"
  const highlight = HighlightStyle.define([
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: p.heading,
      fontWeight: 'bold'
    },
    { tag: [t.keyword, t.moduleKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string)], color: p.string },
    { tag: [t.number, t.bool, t.null], color: p.number },
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.propertyName, t.attributeName], color: p.property },
    { tag: [t.variableName, t.name], color: p.variable },
    { tag: [t.operator, t.separator], color: p.operator },
    // Accent-colored links; the underline is hover-only (see .cm-source-link).
    // Accent-colored links; the underline is hover-only (see .cm-source-link).
    { tag: [t.link, t.url], color: p.accent },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold', color: p.text },
    // Markdown source markers (#, **, `, [, ], >, -) — dim them like a code editor.
    { tag: t.processingInstruction, color: p.muted },
    // Inline code reads as code; fenced blocks get monospace from a decoration
    // (codeBlockFont) so they stay monospace even when parsed by a sub-language.
    { tag: t.monospace, fontFamily: mono, color: p.property },
    // NOTE: deliberately NO mapping for t.list / t.tagName / t.atom. The
    // markdown parser tags ALL list content as `list`, inline `<x>` as
    // `tagName`, and task markers `[x]` as `atom` — mapping those colored every
    // list cyan and every `<...>` / checkbox red (the "random red"). Leaving
    // them default keeps prose clean; the cost is HTML/JSX *tags* inside fenced
    // code aren't tinted (keywords/strings/numbers still are).
    { tag: t.invalid, color: '#ff5370' }
  ])

  return { name, dark: p.dark, vars, editor: [chrome, syntaxHighlighting(highlight)], highlight }
}

const THEMES: Record<string, Theme> = {
  // Default — Tokyo-Night-ish, tuned to the app accent.
  dark: build('dark', {
    dark: true,
    bg: '#1e1e22', bgElev: '#26262b', border: '#34343a', text: '#c0caf5', muted: '#565f7a',
    accent: '#7aa2f7', accentBg: 'rgba(122,162,247,0.18)', codeBg: 'rgba(255,255,255,0.07)',
    heading: '#7aa2f7', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64',
    comment: '#565f7a', property: '#7dcfff', variable: '#c0caf5', operator: '#89ddff', tag: '#f7768e'
  }),
  light: build('light', {
    dark: false,
    bg: '#ffffff', bgElev: '#f4f4f6', border: '#e1e1e6', text: '#1e1e22', muted: '#8a8a93',
    accent: '#2563eb', accentBg: 'rgba(37,99,235,0.12)', codeBg: 'rgba(0,0,0,0.06)',
    heading: '#2563eb', keyword: '#8250df', string: '#0a7d33', number: '#b35900',
    comment: '#8a8a93', property: '#0969da', variable: '#1e1e22', operator: '#cf222e', tag: '#cf222e'
  }),
  'one-dark': build('one-dark', {
    dark: true,
    bg: '#282c34', bgElev: '#21252b', border: '#181a1f', text: '#abb2bf', muted: '#5c6370',
    accent: '#61afef', accentBg: 'rgba(97,175,239,0.18)', codeBg: 'rgba(255,255,255,0.06)',
    heading: '#61afef', keyword: '#c678dd', string: '#98c379', number: '#d19a66',
    comment: '#5c6370', property: '#56b6c2', variable: '#abb2bf', operator: '#56b6c2', tag: '#e06c75'
  }),
  dracula: build('dracula', {
    dark: true,
    bg: '#282a36', bgElev: '#21222c', border: '#191a21', text: '#f8f8f2', muted: '#6272a4',
    accent: '#bd93f9', accentBg: 'rgba(189,147,249,0.2)', codeBg: 'rgba(255,255,255,0.06)',
    heading: '#bd93f9', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9',
    comment: '#6272a4', property: '#8be9fd', variable: '#f8f8f2', operator: '#ff79c6', tag: '#ff5555'
  }),
  nord: build('nord', {
    dark: true,
    bg: '#2e3440', bgElev: '#292e39', border: '#3b4252', text: '#d8dee9', muted: '#616e88',
    accent: '#88c0d0', accentBg: 'rgba(136,192,208,0.2)', codeBg: 'rgba(255,255,255,0.05)',
    heading: '#88c0d0', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead',
    comment: '#616e88', property: '#8fbcbb', variable: '#d8dee9', operator: '#81a1c1', tag: '#bf616a'
  }),
  'solarized-light': build('solarized-light', {
    dark: false,
    bg: '#fdf6e3', bgElev: '#eee8d5', border: '#e0dbc8', text: '#657b83', muted: '#93a1a1',
    accent: '#268bd2', accentBg: 'rgba(38,139,210,0.15)', codeBg: 'rgba(0,0,0,0.05)',
    heading: '#268bd2', keyword: '#859900', string: '#2aa198', number: '#d33682',
    comment: '#93a1a1', property: '#b58900', variable: '#657b83', operator: '#cb4b16', tag: '#dc322f'
  })
}

export const THEME_NAMES = Object.keys(THEMES)
export const DEFAULT_THEME = 'dark'

export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES[DEFAULT_THEME]
}

/** Just the editor extension (stable ref per name, for the useCodeMirror compartment). */
export function getEditorTheme(name: string): Extension {
  return getTheme(name).editor
}
