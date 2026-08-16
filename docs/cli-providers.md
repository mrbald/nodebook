# CLI chat providers — use the AI subscription you already have

*Status: designed 2026-07-04; shipping `codex-cli`, `claude-cli` and generic
`cli`.*

## Why

Distill and Ask need a capable chat model. Retail users typically do not have
API keys — they have a ChatGPT or Claude *subscription*, and often already have
the vendor's command-line app installed and signed in (`codex`, `claude`).
Nodebook can spawn that CLI locally and use it as the chat backend: no API key,
no new account, the model bill lands on the plan the user already pays for.

The distill "try a stronger chat model" banner is the concrete trigger: a
subscription user's strongest available model is usually behind their CLI, not
behind an API key they don't have.

## What ships

Three values for `[talk.chat] provider`:

- **`codex-cli`** — a named, tested preset for the OpenAI Codex CLI. Runs
  `codex exec --json` with the prompt on stdin, under the user's ChatGPT
  sign-in. Zero config beyond flipping the provider; `model` empty means "the
  user's own Codex default".
- **`claude-cli`** — the same deal for Anthropic's Claude Code CLI, under the
  user's Claude sign-in. Runs `claude -p` with the prompt on stdin and streams
  the answer back token by token. `model` empty means the user's own default;
  it also takes an alias like `opus` or `sonnet`.
- **`cli`** — the generic escape hatch, nerdified per the explainability
  filter (advanced option, out of the default path). The user supplies
  `command` (+ optional `args`); Nodebook writes the prompt to stdin and reads
  the whole answer from stdout. Any tool with that contract works — including
  a user's own wrapper script.

All three are chat-only. Embeddings stay on the existing local WASM path; a CLI
provider changes nothing about indexing or search.

Every provider is off by default and switched on by the user. Nodebook never
handles credentials for any of them: sign-in happens in the user's own terminal
(`codex login`, `claude auth login`), before Nodebook is in the picture, and the
traffic is the user's own subscription talking to the vendor directly.

## How it works

One new main-process module, `src/main/rag/cliChat.ts`, implementing the
existing `ChatModel` interface from `src/main/rag/provider.ts`. Everything
downstream (Ask streaming, distill extraction, the pre-flight probe) is
provider-agnostic and unchanged.

- **Spawning.** `child_process.spawn` with an argument array (never a shell),
  the prompt written to stdin, `cwd` pointed at an empty scratch directory so
  the CLI does not pick up `AGENTS.md`/`CLAUDE.md` context from wherever the
  app happened to start. The process is killed when the request's
  `AbortSignal` fires.
- **PATH resolution.** A GUI-launched Electron app does not inherit the shell
  PATH (on macOS it sees `/usr/bin:/bin:...` only), so a bare `codex` would be
  ENOENT even when installed. `resolveCommand()` searches PATH plus the usual
  install dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`,
  `~/bin`). `[talk.chat] command` overrides with a full path.
- **Flattening.** `ChatRequest` is a system prompt + message array; a CLI call
  is one prompt string. `flattenChatRequest()` concatenates the system text and
  the turns (role-labelled only when there is more than one). The distill
  JSON-repair retry — user, assistant, user — survives as a labelled
  transcript.
- **Codex output.** `codex exec --json` emits JSONL events; there are **no
  incremental text deltas** — the answer arrives as one `item.completed`
  `agent_message`. `parseCodexEvents()` (pure, unit-tested against a recorded
  real transcript) collects agent messages and surfaces `turn.failed`/`error`
  events. Consequence: with `codex-cli`, Ask shows the whole answer at once
  instead of streaming. Token streaming exists behind `codex app-server`
  (persistent JSON-RPC process) — deferred until the spinner actually hurts.
- **Claude output — and why it streams.** `claude -p --output-format
  stream-json --include-partial-messages --verbose` emits JSONL that *does*
  carry `content_block_delta` / `text_delta` events, so Ask streams normally.
  `parseClaudeLine()` (pure, unit-tested against a recorded real transcript)
  reads one line at a time; `runCliLines()` is the streaming sibling of
  `runCli()`, yielding stdout lines as they arrive instead of buffering. The
  `assistant` event is deliberately ignored — it repeats the text the deltas
  already carried, and taking both would duplicate the answer. If a future
  build stops emitting partial messages, the final `result` event still holds
  the whole answer and is used as a fallback.
- **Claude runs as a chat model, not a coding agent.** Four flags do that, and
  they are load-bearing rather than cosmetic: `--tools ""` (no file access, no
  web — the backend can only answer the question it was handed),
  `--strict-mcp-config` (the user's MCP servers stay out of it),
  `--disable-slash-commands` (a note starting with `/` is text, not a command),
  and `--system-prompt` replacing Claude Code's own agent prompt. Windows note:
  Node does not quote arguments when it goes through a shell for a `.cmd` shim,
  where a bare empty string would vanish and `--tools` would swallow the next
  flag — so the empty value is passed as `""` on that path.
- **Cheap pre-flight.** A chat round-trip through Codex costs ~12k input
  tokens of harness overhead against the user's plan, so the distill
  pre-flight must not "ping" the model. `ChatModel` gained an optional
  `probe()`: `codex-cli` runs `codex login status` (instant, free, exits
  non-zero when signed out); `claude-cli` runs `claude auth status --json` and
  trusts its `loggedIn` field over the exit code; `cli` just resolves the
  command. `probeChat()` in `src/main/distill/run.ts` prefers `probe()` and
  falls back to the old first-token pull for HTTP providers.

## Configuration

```toml
[talk.chat]
# ChatGPT subscriber with the Codex CLI installed and signed in:
provider = "codex-cli"
model = ""            # empty = your Codex default (~/.codex/config.toml)
command = ""          # optional: full path to codex if not on a standard PATH

# Claude subscriber with the Claude Code CLI installed and signed in:
# provider = "claude-cli"
# model = ""          # empty = your Claude default; or an alias like "opus"
# command = ""        # optional: full path to claude

# Advanced: any command that reads the question on stdin and prints the
# answer on stdout. You supply it; Nodebook just runs it.
# provider = "cli"
# command = "my-wrapper.sh"
```

`model` now defaults to empty everywhere, meaning "the provider's own
default" (`anthropic` falls back to Claude Sonnet in the adapter; `ollama` and
`openai-compat` fail with a clear message instead of sending an Anthropic model
id to a non-Anthropic server, which is what the old default did).

## Costs and limits — honest notes

- CLI calls draw on the subscription's usage windows (both vendors meter in
  5-hour windows, plus weekly caps). A large distill run makes one extraction
  call per cluster (capped at 24) and can consume a visible slice of a Plus
  plan's window. Help says this plainly: "uses your plan's limits".
- Each `codex exec` call re-sends Codex's own system harness (~12k input
  tokens, mostly cache-hits). That is the vendor's design, not tunable from
  here.
- **`claude -p` overhead is tunable, and the difference is large.** Measured
  against claude-code 2.1.233 on a trivial round-trip: **51,216** input tokens
  with default flags, **537** with the four isolation flags above, and 0 new
  tokens on the next call (a 537-token cache read). Almost all of the
  difference was the developer's own MCP servers being loaded into a chat call
  that has no use for them. A distill run makes one call per cluster (capped at
  24), so this is the difference between a visible slice of a plan's window and
  a rounding error. Anyone changing those flags should re-measure.
- Latency: a trivial `codex exec` round-trip measured ~6.5 s wall (process
  start is small; the model call dominates); the same through `claude -p`
  measured ~3 s. The distill pre-flight timeout is 30 s to accommodate cold
  starts.

## Failure modes

All fail fast in the pre-flight, before any embedding work:

| Failure | Behaviour |
| --- | --- |
| Binary not found | "Codex CLI not found — install it, or set its full path in `[talk.chat] command`." Same shape for Claude, naming `npm install -g @anthropic-ai/claude-code`. |
| Signed out | "Codex isn't signed in — run `codex login` in a terminal, then try again." / "Claude Code isn't signed in — run `claude auth login`…". |
| Bad `model` value | Fails on the first extraction call with the CLI's own error (a sign-in check can't validate model ids). `claude` exits 1 with `[claude-code:unrecognized_model]` on stderr, which is surfaced verbatim. |
| Mid-run abort | Process killed via the run's `AbortSignal`, same path as HTTP cancellation. |

## Testing

- Pure parts (`flattenChatRequest`, `parseCodexEvents`, `parseClaudeLine`,
  `resolveCommand`) are unit-tested; both CLI parsers against real recorded
  transcripts.
- The spawn path is tested for real in vitest by running `node -e` scripts as
  the generic provider (echo, non-zero exit, abort) and fake `codex` / `claude`
  executables emitting the recorded JSONL — no network, no quota. The Claude
  fakes cover the cases the parser alone can't: chunk-by-chunk streaming, the
  prompt reaching stdin, the no-partial-messages fallback, abort, and a
  `auth status` that exits 0 while reporting `loggedIn: false`.
- e2e is unchanged: `NODEBOOK_E2E` still short-circuits `makeChatModel` to the
  deterministic stub before any CLI code runs.

## Future

- `codex app-server` for streamed Ask answers, if whole-answer display feels
  bad in practice.
- Other CLIs (e.g. Gemini) need no code — they are `provider = "cli"` recipes.
