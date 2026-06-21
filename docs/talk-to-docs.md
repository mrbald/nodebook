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
3. **MCP (Model Context Protocol)** (`kind: 'mcp'`) — two directions, both valuable:
   - **Nodebook as an MCP *server*** — expose the vault + semantic search as MCP
     resources/tools so any MCP host (Claude Desktop, IDE agents) can "talk to your
     docs" with *their* model. Turns the vault into a knowledge backend for the whole
     ecosystem — the strongest strategic angle.
   - **Nodebook as an MCP *client*** — pull external tools/data to enrich answers.

**Default model pairs** (configurable): *local* — embed `EmbeddingGemma-300M` (or
`bge-small-en-v1.5` for speed), chat (later) a small local model
(`Qwen2.5-3B`/`Llama-3.2-3B`) via llama.cpp; *cloud* — embed
`text-embedding-3-small`/`voyage-3`, chat Claude or GPT.

## Pipeline (and the event-loop angle)

On index (save / chokidar / first-open scan): chunk → embed → upsert into
`chunks` + the vec table. **Embedding runs in a worker thread**, never on the main
event loop, so IPC/UI stay responsive (and the planned telemetry would show the
loop staying healthy — embedding a vault is the kind of load that would otherwise
spike loop lag). First-open is a one-time batch with a progress indicator;
thereafter only changed notes re-embed (content-hash gated).

## UI

- Sidebar search gains a **semantic toggle** (rank by meaning vs. exact).
- A new **"Ask"** panel: a question box → a grounded answer + the source notes it
  cites (clickable to open). Answers render through the existing reading-mode
  Markdown renderer.

## Build / packaging implications (needs a greenlight)

This adds **native dependencies** to the cross-platform release we just
stabilized:
- `onnxruntime-node` (pulled by transformers.js) — native, per-OS/arch binaries.
- the `sqlite-vec` loadable extension — per-OS/arch binary, `asarUnpack`-ed.
- the embedding **model** (~30–300 MB) — bundle it, or download on first run.

All are cross-platform, but they must be wired into electron-builder (unpack the
binaries, per-arch) and re-tested on all three OSes.

**P1 runtime decision (installer size vs speed), since the feature is off by
default:**
- **onnxruntime-node (native)** — fastest, but a large per-OS/arch native binary
  shipped to *everyone* even if they never enable Talk-to-docs.
- **onnxruntime-web (WASM)** — transformers.js also runs in-renderer/worker on a
  single small cross-platform WASM blob; slower, but lazy-loadable and no per-OS
  native packaging. **Leaning WASM** for a lean, opt-in feature; native is a later
  perf upgrade.
- **Model**: download on first *enable* (keeps the base installer small), cache
  under userData; offer a bundle option later.

## Phases

- **P0 — spike ✅ (done, then reverted to keep `main` lean):** verified under
  Electron — `sqlite-vec` v0.1.9 loads into our `better-sqlite3` and KNN works
  (vec0 rowids must bind as **BigInt**); transformers.js (MiniLM) embeds via
  onnxruntime-node (**N-API → no Electron rebuild**), model auto-downloaded
  (~23 MB) and ran in ~90 ms cached. Conclusion: foundation viable; deps re-added
  in P1.
- **P1 — semantic search (fully local, no LLM):** chunk + embed pipeline (worker)
  + sqlite-vec store + hybrid retrieval surfaced in the sidebar. *Ships value with
  zero cloud/keys.*
- **P2 — "Ask" chat:** the Ask panel + pluggable LLM (Claude default, key in
  settings) + citations.
- **P3:** local-LLM option (node-llama-cpp), incremental re-embed, model management.

## Open decisions

1. **Native deps + model size** — OK to add `onnxruntime-node` + `sqlite-vec` +
   a ~30–300 MB model to the build? (bundle vs first-run download?)
2. **Chat provider** — cloud Claude (best, needs key, sends retrieved chunks out)
   vs local-only vs search-only for now?

The chunker (Phase-1 step 1) is pure and dependency-free, so it's built first
(see `src/main/rag/chunk.ts`) regardless of the above.
