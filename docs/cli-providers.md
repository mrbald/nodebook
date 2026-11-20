# Use a command-line app for chat

Nodebook can use your signed-in Codex or Claude Code app for **Ask your notes** and **Distill a document**. The command runs on your computer and sends the request to the service that handles your account. Usage counts against that account's limits. Search by meaning runs locally and has its own setting. [Search, Ask and what gets sent](talk-to-docs.md)

## Connect your account

1. Install the command-line app you want to use. In a terminal, run `codex login` for Codex or `claude auth login` for Claude Code.
2. Choose **Settings** at the bottom of the Nodebook sidebar. In the existing `[talk.chat]` section, set `provider` to `"codex-cli"` or `"claude-cli"` and save. For example, these values use your Codex default model.

   ```toml
   [talk.chat]
   provider = "codex-cli"
   model = ""
   ```

3. Open a vault. Save a note containing “The launch date is 18 April.” Choose **Ask your notes** and ask “What is the launch date?” Open the citation to check the answer. Codex shows the completed answer. Claude Code streams text as it arrives.

Both presets take an optional `model` setting. Leave it empty to use the CLI's default, or enter a model your account can use. Claude Code also accepts aliases such as `sonnet`.

## If the command fails

| Symptom | What to do |
| --- | --- |
| The app works in a terminal but Nodebook cannot find it | Set `command` in `[talk.chat]` to the full path of the executable. Nodebook searches its own PATH and common installation directories. |
| Nodebook reports that you are signed out | Run the login command above. Check the account with `codex login status` or `claude auth status --json`, then try again. |
| The account check passes but the request fails | Read the CLI error. Check the model name and account access. Distill checks sign-in before extraction. Only a model request tests whether that model works. |
| Figure analysis is unavailable | The named presets require a native executable and a model that accepts images. A Windows command shim can handle text requests only. [Figure analysis](distill-documents.md) |

## Use your own text command

Set `provider = "cli"` and `command` to your executable. If it needs arguments, supply them as a TOML string array in `args`. The command reads the complete prompt from standard input and writes its answer to standard output. A nonzero exit or an empty answer is an error. Distill checks that the command exists before it starts. Your command determines which service receives the text.

## Adapter behavior and earlier measurements

Text requests start in a temporary working directory outside the vault. Codex uses `exec --json` with a read-only sandbox. Claude Code runs in print mode with tools and slash commands disabled, a replacement system prompt and strict MCP configuration. The adapter reads text deltas and falls back to the final answer when there are no deltas. Cancellation stops the child process. Tests cover recorded CLI output, sign-in checks, streaming, aborts and process failures using local executables. [Adapters](../src/main/rag/cliChat.ts) · [Tests](../src/main/rag/cliChat.test.ts)

Two Claude Code trials informed those defaults. These figures describe the recorded runs.

| Trial | Result |
| --- | --- |
| Claude Code 2.1.233, one short request | Default settings sent 51,216 input tokens. Disabling tools, external MCP configuration and slash commands and replacing the system prompt reduced that to 537. |
| Claude Code 2.1.258, Haiku, one extraction window | Default thinking used 11,410 thinking tokens in 74 seconds (CLI estimate $0.066). A 1,024-token limit used 243 thinking tokens in 10 seconds ($0.010). |
| Same version, 26 pages of a pandas book, eight windows | With thinking enabled, 64 of 70 items had matching evidence in 882 seconds. With thinking off, 50 of 50 had matching evidence in 117 seconds. Each condition ran once. |

The adapter supplies `MAX_THINKING_TOKENS=0` for Claude Code unless Nodebook already has a value in its environment. An earlier short Codex request incurred about 12,000 input tokens of CLI overhead. Both named presets check login status without sending a model prompt. For more recent import measurements, see [Quality trials](quality-trials.md).
