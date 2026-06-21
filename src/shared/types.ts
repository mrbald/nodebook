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

/** An outbound edge from a note: a `[[link]]` or a `key:: value` field. */
export interface Outbound {
  relation: string
  object: string
}

/** A full-text search result. */
export interface SearchHit {
  path: string
  title: string
  /** Matching excerpt with `<mark>` around hit terms (FTS5 snippet). */
  snippet: string
  /** Set when this hit was surfaced (or boosted) by semantic/vector match. */
  semantic?: boolean
}

/** State of the "talk to docs" semantic layer, for the UI. */
export interface TalkStatus {
  /** The user-facing toggle (settings `[talk] enabled`). */
  enabled: boolean
  /** The embedding width is known and the vector table exists. */
  ready: boolean
  /** Total chunks across the vault. */
  total: number
  /** Chunks still awaiting an embedding (drives the indexing progress UI). */
  pending: number
}

/** A chunk handed to the renderer for embedding. */
export interface TalkChunk {
  id: number
  text: string
}

/** A rolling snapshot of main-process telemetry for the status-bar widget. */
export interface TelemetrySnapshot {
  /** Length of the rolling window in ms (e.g. 5 min). */
  windowMs: number
  /** Event-loop lag histogram + summary (ms). */
  lag: {
    /** Counts per octave bucket (<1, 1, 2, … 4096, ≥8192 ms). */
    buckets: number[]
    labels: string[]
    count: number
    max: number
    mean: number
    p99: number
    /** The slowest samples in the window, with wall-clock timestamps. */
    worst: { ms: number; at: number }[]
  }
  /** Whole-app CPU % samples over the window (oldest → newest). */
  cpu: number[]
  /** Whole-app working-set memory (MB) samples over the window. */
  ram: number[]
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
  /** "Talk to docs" — AI semantic search over the vault. Off by default; nothing
   *  loads until enabled (the model downloads on first enable). */
  talk: {
    enabled: boolean
    embed: {
      /** 'wasm' (lean, cross-platform, default) or 'native' (faster) runtime. */
      runtime: 'wasm' | 'native'
      /** Embedding model id (transformers.js repo, e.g. Xenova/all-MiniLM-L6-v2). */
      model: string
    }
  }
}
