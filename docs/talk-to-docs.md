# Search by meaning and ask your notes

Use sidebar search to find a note. Turn on **Search by meaning** to find similar passages even when the wording or language differs. Use **Ask your notes** when you want a written answer with citations. Search by meaning and chat have separate settings. Either can work on its own.

## Turn on local search by meaning

1. In an open vault, choose **Search by meaning — set up AI** under the search box, then **Enable**.
2. Nodebook downloads the default multilingual E5 model (about 285 MB) and indexes the notes on your computer. The sidebar shows download and indexing progress. Use **Retry** if the model fails to load.
3. Search in the same sidebar box. Nodebook combines keyword and meaning matches. A sparkle marks results found by meaning. You can continue using keyword search while the background index builds.

Search by meaning sends no note text to a chat service. New and changed notes are indexed after save. **Turn off** removes the derived passages and vectors from the open vault's index. You can rebuild them by enabling search by meaning again.

## Set up Ask

Choose **Settings** at the bottom of the sidebar, edit the existing `[talk.chat]` section and save. The default `provider = "none"` keeps chat off. Choose a provider based on where you want your questions and passages processed.

| Provider | What to set |
| --- | --- |
| `ollama` | Start Ollama on your computer and install a model, for example with `ollama pull llama3.2`. Set `model = "llama3.2"`. The default server is `http://localhost:11434/v1`. If you change `baseUrl`, requests go to that address. |
| `anthropic` | Set `ANTHROPIC_API_KEY` in Nodebook's environment. An empty `model` uses the app's Claude Sonnet default. |
| `openai-compat` | Set `baseUrl` to the local or remote server's API base and `model` to a model it serves. Set `OPENAI_API_KEY` if the server needs a key. |
| `codex-cli`, `claude-cli` | Sign in to the installed CLI. The service behind that account processes the request. [CLI setup](cli-providers.md) |
| `cli` | Supply a text command. The command determines where the request goes. [Custom command](cli-providers.md#use-your-own-text-command) |

For example, with that Ollama model installed, use these values in Preferences.

```toml
[talk.chat]
provider = "ollama"
model = "llama3.2"
```

For HTTP providers, Nodebook reads the key from its environment first. If you set `apiKey` in the settings file, the file stores the key in plain text.

### Check an answer

Open **Ask your notes**, type a question and choose **Ask**. Nodebook finds passages by keyword and adds meaning matches when current vectors are available. It sends the provider your question and selected passages. Each passage includes its text, heading, ID and note name, including its folder path within the vault. If it finds no passage that fits the model’s input budget, it tells you without contacting the provider.

Select an inline citation or an entry under **Cited** to inspect the source. **Also sent to the model** lists passages the answer did not cite. For managed source documents with captured figures, search can find recognized image text. Ask uses the authored passages for evidence and excludes managed image references and generated OCR text.

**Distill a document** uses the same chat provider for a different task. For extraction it sends source passages, your optional focus and previously identified concept names. It may also send generated note titles and summaries for theme naming. Optional figure analysis sends the selected image and available context, including its label, location, caption and recognized text. Choose a provider suitable for the document before starting. [Document import](distill-documents.md)

## Tune local indexing

In `[talk.embed]`, the default `model` is `Xenova/multilingual-e5-base`. A lighter multilingual option is `Xenova/multilingual-e5-small` (about 115 MB). For English-only notes and queries, `Xenova/bge-small-en-v1.5` is about 34 MB. Changing the model rebuilds its vectors. The default `threads = 0` uses about half the CPU cores, up to four, when threading is available. [Settings defaults](../src/main/settings.ts) · [Local search trials](quality-trials.md)

## How retrieval works

The main process splits each note into passages and stores them with source offsets in the vault's rebuildable SQLite index. A renderer worker runs the embedding model with WebAssembly and returns a vector for each passage. SQLite full-text search ranks keyword matches. The sqlite-vec extension ranks similar vectors. Nodebook combines the two rankings using reciprocal rank fusion. This keeps keyword search usable when vectors are missing or out of date. [Index](../src/main/indexer.ts) · [Vector store](../src/main/rag/store.ts)

Chunk sizes account for the token cost of different scripts. The worker uses different text prefixes for queries and indexed passages when the model requires them, including E5's `query: ` and `passage: `. A change to these conventions requires a fresh vector index. The shipped runtime uses WASM. Native embedding, remote embeddings, in-process chat and an MCP model backend remain design options. Document conversion has its own interface. [Embedding worker](../src/renderer/src/talk/embed.worker.ts) · [Model interfaces](../src/main/rag/provider.ts)
