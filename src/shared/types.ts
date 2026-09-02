/** Default local embedding model (a transformers.js/HF Hub repo id):
 *  multilingual-e5-base — ~100 languages in one vector space, so notes retrieve
 *  by meaning whatever language they (or the query) are written in. Asymmetric:
 *  needs the query:/passage: prefixes handled by the renderer embedder (see
 *  src/renderer/src/talk/embedder.ts). Lives in shared/ because both main
 *  (settings defaults) and the renderer (embed fallback) need it — a renderer
 *  copy of this string once drifted stale. */
export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-base'

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
 *  with no file yet). Keyed by the note's *path*, so two notes with one name are
 *  two nodes; a ghost's id is `ghost:<target>`. */
export interface GraphNode {
  /** The note's path — the node's stable id (`ghost:<target>` for a ghost). */
  id: string
  /** The note name, as shown on the map and written inside a `[[link]]`. */
  label: string
  /** Absolute path if it resolves to a real note; null for a ghost. */
  path: string | null
  ghost: boolean
  /** Edge count within the returned slice (drives node size). */
  degree: number
  /** The note the slice is centred on (local map). */
  focus: boolean
  /** In an overlay view, which side this note's *file* came from. Absent in
   *  single-source views, and on ghosts (which have no file on either side). */
  source?: 'vault' | 'run'
  /** Overlay only: a note with this same name also exists on the other side —
   *  a collision a merge would have to decide about, drawn as two dots joined by
   *  a `same_name` edge. */
  sameName?: boolean
  /** Other note names folded into this one because they say `same_as:: [[this]]`
   *  — a decision the user confirmed when merging. Absent when there are none. */
  aliases?: string[]
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
  /** Source-document "hub" nodes dropped because `showSources` was off (a note
   *  distilled from a book all carry `source:: [[book]]`, which otherwise turns
   *  the map into a star). 0 when shown, or when the slice has none — so the UI
   *  can show its toggle only when it would actually do something. */
  hiddenSources: number
  /** Distinct link targets in this slice that matched more than one note (same
   *  name in different folders). The map picked one — the count is how it admits
   *  it guessed. */
  ambiguousTargets: number
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
  /** True when the answer text actually cites this note via an inline
   *  `[[wikilink]]` — as opposed to being retrieved as context but never drawn
   *  on. Drives the "Cited" vs "Also sent to the model" split in the UI.
   *  Optional so producers that predate the field stay type-compatible;
   *  absent reads as "not cited". */
  used?: boolean
}

/** Returned when an "Ask" stream completes (the answer itself streams as tokens). */
export interface AskResult {
  citations: Citation[]
  /** Every retrieved note's name (unique), regardless of whether the answer
   *  cited it. Used to gate which `[[wikilink]]`s in the answer are real
   *  citations — a name outside this list is a hallucination and must not
   *  render as a clickable link. */
  sources: string[]
}

/** Enabled-state inputs the renderer reports to the main process so the app menu
 *  can grey out actions that don't apply (no vault/note open, no chat provider). */
export interface MenuState {
  /** A vault is open. */
  hasVault: boolean
  /** A note is open in the editor (drives Export/Print/Knowledge Map). */
  hasNote: boolean
  /** A savable document is open — a note, or the settings editor (drives Save). */
  canSave: boolean
  /** An "Ask" chat provider is configured (drives Ask Your Notes). */
  canAsk: boolean
  /** A distill run is in flight — only one at a time, so the menu item is off. */
  distilling: boolean
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
      /** Embedding model id (transformers.js repo, e.g. Xenova/multilingual-e5-base). */
      model: string
      /** Embedding CPU threads. 0 = auto (about half the cores, max 4). */
      threads: number
    }
    /** "Ask" chat provider. 'none' = search-only (no LLM). The API key is read
     *  from the env/settings in main and never sent to the renderer. */
    chat: {
      /** 'none' = search-only; 'ollama' = a local Ollama server (zero-config);
       *  'openai-compat' = any OpenAI-style endpoint (set baseUrl); 'anthropic' = Claude;
       *  'codex-cli' / 'claude-cli' = the user's installed OpenAI Codex or Claude
       *  Code CLI under their own sign-in (no API key); 'cli' = advanced — any
       *  user command that reads the prompt on stdin and prints the answer. */
      provider: 'none' | 'anthropic' | 'openai-compat' | 'ollama' | 'codex-cli' | 'claude-cli' | 'cli'
      /** Chat model id (e.g. claude-sonnet-4-6, llama3.2, or an OpenAI-compat name).
       *  Empty = the provider's own default. */
      model: string
      /** OpenAI-compatible base URL (Ollama, LM Studio, a gateway). Optional for
       *  'ollama' (defaults to the local server); required for 'openai-compat'. */
      baseUrl: string
      /** CLI backends: the executable — a full path, or a bare name resolved
       *  against PATH plus the usual install dirs. */
      command: string
      /** 'cli' only: arguments placed before the stdin-fed prompt. */
      args: string[]
      /** Tokens of prompt this model accepts. 0 = the provider family's own
       *  default. Distill sizes its reading steps from this. */
      contextTokens: number
    }
  }
  /** "Distill a document" — how much of a document one run reads, and how
   *  many model calls it may spend doing it. */
  distill: {
    /** Weight units of source text per reading step (see `weightOf`: a Latin
     *  character = 1, a CJK code point = 3). 0 = derived from the chat model's
     *  context budget, which is what almost everyone should leave it at. */
    windowSize: number
    /** Maximum model calls one run may make. A document needing more is read
     *  in evenly spaced steps, and the run says what share it read. */
    maxCalls: number
  }
  /** Main-process telemetry (event-loop lag + CPU/RAM). Off by default; when on,
   *  a tiny status-bar widget appears. */
  telemetry: {
    enabled: boolean
  }
}

/** The extraction funnel for a distill run — surfaced, never silently capped. */
export interface DistillStats {
  chunks: number
  /** Reading steps the run planned — the document in consecutive windows, one
   *  model call each. */
  windows: number
  /** Model calls actually attempted, including any a provider rejected for
   *  length before its two halves were read. */
  calls: number
  /** How many times a rejected step was halved and read as two, so the text
   *  was still read in full. */
  splits: number
  extracted: number
  grounded: number
  /** Everything grounding dropped: the three `droppedByReason` counts summed. */
  dropped: number
  /** Why: `noEvidence` counts points the model backed with no quote at all;
   *  `notFound` and `ambiguous` count quotes that couldn't be found in the
   *  document, or that matched in more than one place (never guessed at). */
  droppedByReason: { noEvidence: number; notFound: number; ambiguous: number }
  /** Quotes found under a different passage than the model claimed, corrected
   *  to the passage that really holds them, and kept. */
  recovered: number
  merged: number
  notes: number
  /** Steps the model never answered usably — counted, never hidden. */
  failedWindows: number
  /** Links between the run's notes, `source::` excluded — the map's edges. */
  edges: number
  /** Of those, how many still name a note the run did not write (a dead end
   *  in the map). Counted rather than hidden: a link is only redirected when
   *  the name clearly matches an emitted note, never guessed at. */
  ghostLinks: number
  /** Of those, how many were added because one note's text names another. */
  mentions: number
  /** Separate islands of notes in the run's map (a lower number means the run
   *  came out as one connected body of knowledge rather than loose piles). */
  components: number
  /** Share (0..1) of the document's text — BY WEIGHT, each passage counted
   *  once — the model was actually shown. This is the honesty number: 1.0
   *  means the whole document was read, below 1.0 means it needed more steps
   *  than `[distill] maxCalls` allows and evenly spaced steps were read. */
  coverage: number
}

/** A document the user picked to distill. `id` is an opaque handle main maps
 *  back to the absolute path, so the renderer never names a path to run. */
export interface DistillDocument {
  id: string
  /** The document's file name, for display. */
  name: string
}

export interface DistillRunResult {
  runId: string
  stats: DistillStats
}

/** A staged run as shown in the "Distilled runs" list. */
export interface DistillRunInfo {
  id: string
  /** Emitted (concept) notes in the run — 0 means nothing survived grounding
   *  (or that the run never finished; see `unfinished`). */
  notes: number
  /** Whether the run has already been merged into the vault. */
  merged: boolean
  /** The run started but never finished — cancelled, or interrupted. What it
   *  had already extracted is kept, and Resume carries on from there. */
  unfinished: boolean
}

/** What a run will cost, worked out from the document before it starts. */
export interface DistillEstimate {
  /** Passages the document splits into. */
  chunks: number
  /** Reading steps the run will take — one model call each. */
  calls: number
  /** Share (0..1) of the document's text, by weight, the model will be shown. */
  coverage: number
  /** Steps the whole document needs, before the call budget is applied. More
   *  than `maxCalls` means the run has to sample, and the user is asked first. */
  totalWindows: number
  /** The user's call budget (`[distill] maxCalls`) this was measured against. */
  maxCalls: number
}

export interface DistillProgress {
  phase: 'chunking' | 'extracting' | 'finalizing' | 'done'
  done: number
  total: number
}

/** What a merge would do with one staged note (see main/distill/mergePlan.ts). */
export interface DistillMergePlanEntry {
  /** The staged note's own name. */
  name: string
  /** `new` — the vault has no note of that name. `identical` — it has one with
   *  exactly these bytes, so the merge skips it. `collides` — it has a
   *  DIFFERENT note of that name, so this one is saved beside it under
   *  `targetName` and you are asked whether they are really the same thing. */
  action: 'new' | 'identical' | 'collides'
  /** The name it will be written under (`name` unless it collides). */
  targetName: string
}

/** What merging a run would do, worked out before anything is written. */
export interface DistillMergePlan {
  /** The document's short title — the disambiguator in a collision's new name. */
  sourceTitle: string
  entries: DistillMergePlanEntry[]
}

/** Outcome of merging a run into the vault (reversible). */
export interface DistillMergeResult {
  /** Vault-relative folder the notes were written into. */
  folder: string
  count: number
  /** Notes the vault already held byte-for-byte, so nothing was written for
   *  them. Absent in results from before the merge plan existed. */
  skipped?: number
}

/** Outcome of undoing a merge. Notes you edited after merging are moved to the
 *  Trash rather than deleted, so an undo can never destroy your work. */
export interface DistillUnmergeResult {
  /** Untouched notes, deleted outright. */
  removed: number
  /** Edited (or unverifiable) notes, moved to the system Trash. */
  trashed: number
}

/** Whether a run has been merged into the vault, for the UI's Merge/Undo state. */
export interface DistillMergeStatus {
  merged: boolean
  folder?: string
  count?: number
}
