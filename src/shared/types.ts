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

/** A node in the derived knowledge graph (a note, or a "ghost" — a linked target
 *  with no file yet). Keyed by note name, matching the triple store. */
export interface GraphNode {
  /** Note name (the wikilink target); the node's stable id. */
  id: string
  label: string
  /** Absolute path if it resolves to a real note; null for a ghost. */
  path: string | null
  ghost: boolean
  /** Edge count within the returned slice (drives node size). */
  degree: number
  /** The note the slice is centred on (local map). */
  focus: boolean
}

/** A directed edge: `source --relation--> target` (a harvested triple). */
export interface GraphEdge {
  source: string
  target: string
  relation: string
}

/** A slice of the knowledge graph (local around a focus note, or global). */
export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Candidate nodes available before the global cap; equals `nodes.length`
   *  unless the global view was capped to the highest-degree subset. */
  total?: number
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

/** A note an "Ask" answer was grounded in (the retrieved sources). */
export interface Citation {
  path: string
  title: string
}

/** Returned when an "Ask" stream completes (the answer itself streams as tokens). */
export interface AskResult {
  citations: Citation[]
}

/** A semantically-similar note (cosine over per-note embedding centroids). */
export interface TalkNeighbor {
  path: string
  name: string
  score: number
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
    /** Minimum cosine similarity (0..1) for the map's ✨ "related" overlay and
     *  colour-by-meaning. Pairs below this are dropped, so sparse vaults don't
     *  flag unrelated notes. */
    relatedMinScore: number
    embed: {
      /** 'wasm' (lean, cross-platform, default) or 'native' (faster) runtime. */
      runtime: 'wasm' | 'native'
      /** Embedding model id (transformers.js repo, e.g. Xenova/all-MiniLM-L6-v2). */
      model: string
    }
    /** "Ask" chat provider. 'none' = search-only (no LLM). The API key is read
     *  from the env/settings in main and never sent to the renderer. */
    chat: {
      /** 'none' = search-only; 'ollama' = a local Ollama server (zero-config);
       *  'openai-compat' = any OpenAI-style endpoint (set baseUrl); 'anthropic' = Claude. */
      provider: 'none' | 'anthropic' | 'openai-compat' | 'ollama'
      /** Chat model id (e.g. claude-sonnet-4-6, llama3.2, or an OpenAI-compat name). */
      model: string
      /** OpenAI-compatible base URL (Ollama, LM Studio, a gateway). Optional for
       *  'ollama' (defaults to the local server); required for 'openai-compat'. */
      baseUrl: string
    }
  }
  /** Main-process telemetry (event-loop lag + CPU/RAM). Off by default; when on,
   *  a tiny status-bar widget appears. */
  telemetry: {
    enabled: boolean
  }
}
