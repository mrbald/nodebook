# Talk to docs — design

**Goal:** AI-assisted **semantic search** + **chat** over the vault — ask in
natural language, get answers grounded in your notes with clickable citations.
**Local-first** (private, no API key needed for search), aligned with Nodebook's
plain-files + rebuildable-index philosophy.

## Fits the existing architecture

Everything lives in the single SQLite index at `<vault>/.nodebook/index.db`
(Discipline #3: rebuildable, never a second source of truth). We add two tables:

- `chunks(id, file, heading, start, end, text)` — notes split into embeddable slices.
- a **sqlite-vec** `vec0` virtual table holding each chunk's embedding vector,
  keyed to `chunks.id`. (No separate vector DB — `sqlite-vec` keeps vectors in the
  same file; loads into `better-sqlite3` via `db.loadExtension()`.)

Why sqlite-vec over a standalone vector DB (LanceDB/Chroma/Qdrant): it preserves
the "one rebuildable SQLite index" discipline — embeddings are *derived* data, so
they belong in `.nodebook`, re-creatable by re-embedding.

## Components

- **Embeddings — local, on-device** via `@huggingface/transformers` (transformers.js,
  ONNX Runtime). No API key; notes never leave the machine. Default model: a small
  CPU model (**bge-small-en-v1.5** ~33M for speed, or **EmbeddingGemma-300M** /
  **nomic-embed-text** for quality) — configurable in settings.
- **Retrieval — hybrid.** Fuse our existing **FTS5 BM25** (exact terms) with
  **sqlite-vec KNN** (meaning) via Reciprocal Rank Fusion. Hybrid beats pure-vector
  for notes (you want both the keyword and the concept).
- **Chat (RAG) — pluggable LLM.** Retrieved chunks + question → LLM → answer with
  `[[note]]` citations. Providers:
  - **Cloud (Anthropic Claude)** — best quality; API key in settings; sends the
    *retrieved chunks* (not the whole vault) to the API.
  - **Local (node-llama-cpp / Ollama)** — fully private; heavier (multi-GB model).
  - **Search-only** — retrieval with no LLM is useful on its own and 100% local;
    chat is opt-in once a provider is configured.

## Connecting models — three patterns + one abstraction

The feature is **off by default** (`[talk] enabled = false`) and **config-driven**.
Everything goes through one small abstraction (`src/main/rag/provider.ts`):
`Embedder { embed(texts) }` and `ChatModel { chat(req) -> stream }`, produced by a
`ModelProvider` from a `ProviderConfig`. Three provider kinds cover the realistic
"top 3 ways to connect a model to an app":

1. **In-process / embedded** (`kind: 'local'`) — the model runs inside the app:
   **transformers.js**(ONNX) for embeddings, **node-llama-cpp** for chat. Private,
   offline, no key, no per-call cost; costs CPU/RAM + model download. *Default for
   embeddings.*
2. **Remote HTTP, OpenAI-compatible** (`kind: 'openai-compat'`) — one client speaks
   the `/v1/embeddings` + `/v1/chat/completions` wire format pointed at **any base
   URL**: OpenAI, Together, Groq, Mistral, **or a local server** (Ollama, LM Studio,
   llama.cpp, vLLM — all expose OpenAI-compat endpoints). One adapter → dozens of
   backends by changing `baseUrl`/`apiKey`/`model`. (`kind: 'anthropic'` is a thin
   sibling for Claude's native API; OpenAI-compat gateways/LiteLLM can also front it.)
3. **MCP client** (`kind: 'mcp'`) — pull a model/tool from an MCP server as another
   backend transport.

**Scope discipline (one subsystem per concern — they have different trust,
lifecycle, and error models; don't fold them into one kind):**
- `provider.ts` is **model backends only** — `Embedder` + `ChatModel`. The three
  kinds above are *how a model is reached*, nothing more.
- **Document conversion** (book → markdown) is its **own** `DocumentConverter`
  interface (see [distill-documents.md](distill-documents.md)) — *not* a provider kind,
  even when its transport happens to be MCP.
- **Nodebook-as-an-MCP-server** (exposing the vault + search as tools for other
  hosts) is a **separate outbound feature**, not part of this abstraction at all.
  Strategically interesting, tracked elsewhere.

**Default model pairs** (configurable): *local* — embed `EmbeddingGemma-300M` (or
`bge-small-en-v1.5` for speed), chat (later) a small local model
(`Qwen2.5-3B`/`Llama-3.2-3B`) via llama.cpp; *cloud* — embed
`text-embedding-3-small`/`voyage-3`, chat Claude or GPT.

## Pipeline (and the event-loop angle)

On index (save / chokidar / first-open scan): main chunks → the **renderer**
embeds → main upserts into `chunks` + the vec table. **As shipped, embedding runs
in a renderer Web Worker on `onnxruntime-web` (WASM)** — a different process from
the main event loop entirely, so IPC/UI stay responsive (telemetry confirms the
main loop stays healthy). Pull-based bridge: renderer pulls `talk:pending` → embeds
→ pushes `talk:putEmbeddings`. First-open is a one-time batch with progress;
thereafter only changed notes re-embed (content-hash gated).

## UX — how the feature is exposed (UX/UI hat)

Category exemplars: Obsidian (Smart Connections / Copilot), Notion AI, NotebookLM,
Mem, Reflect, Logseq. The convergent convention: **semantic search *augments* the
existing search** (the good ones make search "just smarter", not a mode you
babysit); **chat is a dedicated "Ask" panel**; and enabling AI is a **deliberate,
clearly-private opt-in**.

1. **Discovery + enable — an honest affordance, no dead toggles.** While off, the
   sidebar search shows one subtle line under the box:
   *"✨ Search by meaning — set up AI (local & private)."* It opens a small setup
   card: "Runs entirely on your machine — your notes never leave it. Downloads a
   ~30 MB model once, then indexes in the background." `[Enable]` + an **Advanced**
   disclosure (runtime WASM/native, model). Also in Settings (`[talk]`). The entry
   only promises what enabling delivers.
2. **Activation states are designed.** Enable → model-download progress →
   "Indexing 120/450…" (background, non-blocking) → ready. Offline/error → message
   + Retry. Disable → stop + offer to delete the embeddings (they live in
   `.nodebook`, rebuildable — Discipline #3; fully reversible).
3. **Once enabled, search is hybrid + automatic.** The *same* search box fuses
   keyword (FTS) ⊕ meaning (vector, RRF) — **no mode the user manages**. A small ✨
   marks AI-contributed hits; semantic hits show the matching passage. Keyword
   search still works with AI off.
4. **"Ask" (Phase 2) is a dedicated panel.** An "Ask" entry opens a chat in the
   center pane (like Help): question → grounded answer + **clickable cited notes**,
   rendered through reading-mode. Plain-click a citation to open it (navigation
   convention, like backlinks).
5. **Lead with privacy.** "Local & private" is the headline wherever AI appears —
   honest (local embeddings) and the category's #1 user concern.

Avoid: a permanent "AI" tab cluttering the chrome; a keyword/meaning toggle the
user must manage; any AI control visible-but-inert before setup.

## Config (off by default, runtime selectable, lazy)

```toml
[talk]
enabled = false            # whole feature is opt-in; nothing loads until true

[talk.embed]
runtime = "wasm"           # wasm (default, lean, cross-platform) | native (faster)
model = "bge-small-en-v1.5"
# provider = "local"       # local | openai-compat (baseUrl/apiKey) for remote

[talk.chat]
provider = "none"          # none (search-only) | openai-compat | anthropic | local
```

## Build / packaging — as shipped (decisions resolved)

The runtime fork below was **decided in favour of WASM** and is live:
- **Embeddings: `onnxruntime-web` (WASM) in a renderer Web Worker** — no native
  per-OS binary, one cross-platform blob, **lazy** (the 1.27 MB transformers.js
  chunk loads only when the feature is enabled; 0 bytes of it in the eager entry).
  `onnxruntime-node` (native) is *not* shipped; it remains a future "fast mode".
- **`sqlite-vec`** loadable extension — `asarUnpack`-ed (`**/node_modules/sqlite-vec*/**`),
  loaded into `better-sqlite3` in main (vec0 rowids bind as **BigInt**).
- **Model** — downloads on first *enable* (renderer Cache API), keeping the base
  installer lean; bundling is a later option.

Verified end-to-end (stub-embedder e2e + a real-model run): enable → chunk → embed
→ store → hybrid search, with the main loop staying healthy throughout.

## Phases

- **P0 — spike ✅** verified `sqlite-vec` + transformers.js under Electron.
- **P1 — semantic search ✅ SHIPPED (fully local, no LLM):** chunk + renderer-WASM
  embed pipeline + sqlite-vec store + hybrid FTS⊕vector (RRF) in the sidebar. Off by
  default; zero cloud/keys.
- **P2 — "Ask" chat ✅ SHIPPED:** the Ask panel + pluggable LLM (anthropic +
  openai-compat, key in env/settings) + cited, streamed answers.
- **P3 — lean slices ✅ SHIPPED:** a ✨-relatedness **distance threshold**
  (`relatedMinScore`) so sparse vaults don't flag unrelated notes; a **model-
  download progress** bar (real % from transformers.js); and a first-class
  **Ollama** local-LLM preset (`provider = "ollama"` → openai-compat at the
  default local URL, no key). Incremental re-embed shipped back in P1 (content-
  hash gated). *Deferred: in-process **node-llama-cpp** (the `local` kind) —
  leaning on Ollama gives private/offline chat without the heavy per-OS native
  dependency, keeping the WASM-over-native discipline; bundling the embedding
  model in the installer.*

## Resolved decisions (for the record)

1. **Runtime / packaging** → WASM in a renderer worker, model-on-enable (above).
2. **Chat provider** → **search-only for now**; chat is P2 via the provider
   abstraction (Claude default when built).
