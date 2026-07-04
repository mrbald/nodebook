# CLI chat providers — use the AI subscription you already have

*Status: designed 2026-07-04, shipping `codex-cli` + generic `cli`. Anthropic
approval for a first-class Claude preset: pending (see "The Claude question").*

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

Two new values for `[talk.chat] provider`:

- **`codex-cli`** — a named, tested preset for the OpenAI Codex CLI. Runs
  `codex exec --json` with the prompt on stdin, under the user's ChatGPT
  sign-in. Zero config beyond flipping the provider; `model` empty means "the
  user's own Codex default".
- **`cli`** — the generic escape hatch, nerdified per the explainability
  filter (advanced option, out of the default path). The user supplies
  `command` (+ optional `args`); Nodebook writes the prompt to stdin and reads
  the whole answer from stdout. Any tool with that contract works — including
  a user's own wrapper script.

Both are chat-only. Embeddings stay on the existing local WASM path; a CLI
provider changes nothing about indexing or search.

## The policy question (why Claude is not a preset yet)

The two vendors are not symmetric:

- **OpenAI supports this pattern explicitly.** The official `@openai/codex-sdk`
  itself spawns the `codex` CLI and reuses the saved ChatGPT login; scripted
  `codex exec` is a documented, first-class feature.
  Sources: <https://developers.openai.com/codex/noninteractive>,
  <https://github.com/openai/codex> (sdk/typescript README),
  <https://developers.openai.com/codex/auth>.
- **Anthropic requires approval.** The Agent SDK docs state: *"Unless
  previously approved, Anthropic does not allow third party developers to
  offer claude.ai login or rate limits for their products."*
  Source: <https://code.claude.com/docs/en/agent-sdk/overview.md>.

The line we draw: an individual scripting their own subscription on their own
machine is normal, documented use (both vendors ship headless modes for exactly
that). What needs approval is Nodebook-the-product *shipping a Claude
subscription backend*. So:

- `codex-cli` is a first-class preset (vendor-blessed pattern).
- Claude is reachable today only through the generic `cli` provider, configured
  by the user, on the user's own responsibility — Nodebook never handles login,
  tokens, or keys, and does not document it in the default setup path.
- A `claude-cli` preset is a one-line factory branch once approved.

**Approval request channel** (no dedicated process is documented; these are the
official routes): the Claude Partner Network application form
<https://claude.com/form/cpn-partner-application> (primary), and the sales
contact referenced from the Agent SDK docs
<https://www.anthropic.com/contact-sales> (fallback). The request should say:
open-source AGPL desktop app, local-first, spawns the user's own installed and
signed-in `claude` CLI at the user's request, no OAuth-token extraction, no
hosted service, asking for pre-approval per the Agent SDK policy sentence.

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
- **Cheap pre-flight.** A chat round-trip through Codex costs ~12k input
  tokens of harness overhead against the user's plan, so the distill
  pre-flight must not "ping" the model. `ChatModel` gained an optional
  `probe()`: `codex-cli` runs `codex login status` (instant, free, exits
  non-zero when signed out); `cli` just resolves the command. `probeChat()`
  in `src/main/distill/run.ts` prefers `probe()` and falls back to the old
  first-token pull for HTTP providers.

## Configuration

```toml
[talk.chat]
# ChatGPT subscriber with the Codex CLI installed and signed in:
provider = "codex-cli"
model = ""            # empty = your Codex default (~/.codex/config.toml)
command = ""          # optional: full path to codex if not on a standard PATH

# Advanced: any command that reads the question on stdin and prints the
# answer on stdout. You supply it; Nodebook just runs it.
# provider = "cli"
# command = "claude"
# args = ["-p"]
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
- Latency: a trivial `codex exec` round-trip measured ~6.5 s wall (process
  start is small; the model call dominates). The distill pre-flight timeout is
  30 s to accommodate cold starts.

## Failure modes

All fail fast in the pre-flight, before any embedding work:

| Failure | Behaviour |
| --- | --- |
| Binary not found | "Codex CLI not found — install it, or set its full path in `[talk.chat] command`." |
| Signed out | "Codex isn't signed in — run `codex login` in a terminal, then try again." |
| Bad `model` value | Fails on the first extraction call with the CLI's own error (login status can't validate model ids). |
| Mid-run abort | Process killed via the run's `AbortSignal`, same path as HTTP cancellation. |

## Testing

- Pure parts (`flattenChatRequest`, `parseCodexEvents`, `resolveCommand`) are
  unit-tested; the Codex parser against a real recorded `exec --json`
  transcript.
- The spawn path is tested for real in vitest by running `node -e` scripts as
  the generic provider (echo, non-zero exit, abort) and a fake `codex`
  executable emitting the recorded JSONL — no network, no quota.
- e2e is unchanged: `NODEBOOK_E2E` still short-circuits `makeChatModel` to the
  deterministic stub before any CLI code runs.

## Future

- `claude-cli` preset (streaming via `--output-format stream-json
  --include-partial-messages`) once Anthropic approval lands.
- `codex app-server` for streamed Ask answers, if whole-answer display feels
  bad in practice.
- Other CLIs (e.g. Gemini) need no code — they are `provider = "cli"` recipes.
