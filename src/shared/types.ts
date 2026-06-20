/** A markdown file discovered inside the open vault. */
export interface MarkdownFile {
  /** Absolute path on disk. */
  path: string
  /** Base name without the `.md` extension — the wikilink target. */
  name: string
  /** Vault-relative path, used for display and stable sorting. */
  rel: string
}

/** A note that references a given target, with the relation type carried. */
export interface Backlink {
  source_file: string
  relation: string
}

/** A full-text search result. */
export interface SearchHit {
  path: string
  title: string
  /** Matching excerpt with `<mark>` around hit terms (FTS5 snippet). */
  snippet: string
}

/** The vault's markdown files plus its directory paths (so empty dirs show). */
export interface VaultListing {
  files: MarkdownFile[]
  /** Vault-relative directory paths. */
  dirs: string[]
}

/** User settings, edited as TOML and applied live. */
export interface Settings {
  editor: {
    fontSize: number
    /** Autosave after you stop typing for this many ms. 0 = off (save with ⌘S). */
    autosaveDelayMs: number
    /** Also autosave when switching notes or closing the window. */
    autosaveOnSwitch: boolean
    /** View mode a note opens in: 'code' | 'live' | 'reading'. */
    defaultMode: 'code' | 'live' | 'reading'
  }
  theme: {
    /** Follow the OS light/dark appearance, choosing `dark`/`light` per mode. */
    followSystem: boolean
    /** Theme name used in OS dark mode (when followSystem). */
    dark: string
    /** Theme name used in OS light mode (when followSystem). */
    light: string
    /** Theme name used when followSystem is off. */
    name: string
  }
}
