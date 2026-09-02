import { spawn } from 'child_process'
import { accessSync, constants, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  ContextLengthError,
  isContextLengthMessage,
  type ChatModel,
  type ChatRequest,
  type ProviderConfig
} from './provider'
import { tagError, isAuthMessage } from '../distill/retry'

/**
 * CLI-backed chat adapters: run a local command the user already has installed
 * and signed in (their subscription, no API key) and treat it as a `ChatModel`.
 * See docs/cli-providers.md for the design and the policy line.
 *
 * - `codexCliChat` — preset for the OpenAI Codex CLI: `codex exec --json`,
 *   prompt on stdin, answer parsed from its JSONL events (no incremental
 *   deltas, so the whole answer arrives as one chunk).
 * - `claudeCliChat` — preset for Anthropic's Claude Code CLI: `claude -p`,
 *   prompt on stdin, answer streamed token-by-token from its JSONL events.
 * - `genericCliChat` — user-supplied `command`/`args`; contract: prompt on
 *   stdin, answer on stdout.
 *
 * Spawning is always an argument array (never a shell), with `cwd` in an empty
 * scratch dir so the CLI can't pick up AGENTS.md/CLAUDE.md context from
 * wherever the app was launched.
 */

/** Where a bare command name is searched beyond PATH: a GUI-launched Electron
 *  app inherits the login PATH, not the shell PATH, so Homebrew/npm dirs are
 *  usually missing from it. */
function extraDirs(): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), 'bin')]
}

interface ResolveOpts {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Injectable "is this an executable file" check, for tests. */
  canRun?: (path: string) => boolean
}

/** Find the executable for `cmd`: a path with a separator is checked as-is;
 *  a bare name is searched on PATH plus the usual install dirs. Windows also
 *  tries the .exe/.cmd/.bat forms. Returns null when nothing runnable exists. */
export function resolveCommand(cmd: string, opts: ResolveOpts = {}): string | null {
  const platform = opts.platform ?? process.platform
  const win = platform === 'win32'
  const canRun =
    opts.canRun ??
    ((p: string): boolean => {
      try {
        if (win) return existsSync(p)
        accessSync(p, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  if (cmd.includes('/') || (win && cmd.includes('\\'))) return canRun(cmd) ? cmd : null
  const env = opts.env ?? process.env
  // PATH delimiter follows the *target* platform (injectable in tests), not the host.
  const dirs = [...(env.PATH ?? '').split(win ? ';' : ':'), ...(win ? [] : extraDirs())].filter(Boolean)
  const names = win ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd] : [cmd]
  for (const dir of [...new Set(dirs)]) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (canRun(candidate)) return candidate
    }
  }
  return null
}

/** A `ChatRequest` is a system prompt + turns; a CLI call is one prompt string.
 *  Single-turn requests pass through untouched; multi-turn transcripts (the
 *  distill JSON-repair retry) become role-labelled sections. */
export function flattenChatRequest(req: ChatRequest): string {
  const system = [req.system ?? '', ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n')
  const turns = req.messages.filter((m) => m.role !== 'system')
  const body =
    turns.length <= 1
      ? (turns[0]?.content ?? '')
      : turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`).join('\n\n')
  return [system, body].filter(Boolean).join('\n\n')
}

interface CodexEvent {
  type?: string
  item?: { type?: string; text?: string }
  error?: { message?: string }
  message?: string
}

/** Parse `codex exec --json` JSONL: collect the agent's message(s), surface the
 *  first failure event. Unparseable lines are skipped (warnings, partial writes). */
export function parseCodexEvents(stdout: string): { text: string; error: string | null } {
  const texts: string[] = []
  let error: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: CodexEvent
    try {
      ev = JSON.parse(trimmed) as CodexEvent
    } catch {
      continue
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      texts.push(ev.item.text)
    } else if (ev.type === 'turn.failed') {
      error ??= ev.error?.message ?? 'the turn failed'
    } else if (ev.type === 'error') {
      error ??= ev.message ?? 'unknown error'
    }
  }
  return { text: texts.join('\n\n'), error }
}

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

const tail = (s: string): string => s.trim().slice(-400)

/** A CLI has no status codes — its verdict is whatever it printed. When that
 *  text says the prompt was too long, report it as the one error distill can
 *  actually fix (by sending less) instead of a generic failure. */
function cliFailure(message: string, evidence: string, tags: Parameters<typeof tagError>[1]): Error {
  if (isContextLengthMessage(evidence)) return new ContextLengthError(message)
  return tagError(new Error(message), tags)
}

// One empty directory reused for every CLI call, so the child never sees the
// app's (or a vault's) files as "project context".
let scratch: string | null = null
function scratchCwd(): string {
  if (!scratch) {
    scratch = join(tmpdir(), 'nodebook-cli')
    try {
      mkdirSync(scratch, { recursive: true })
    } catch {
      scratch = tmpdir()
    }
  }
  return scratch
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Spawn `file args…`, feed `input` to stdin, collect stdout/stderr, kill on
 *  abort. Resolves with the exit code (never rejects on non-zero — callers turn
 *  that into their own message); rejects on spawn failure or abort. */
function runCli(
  file: string,
  args: string[],
  opts: { input?: string; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError())
    // npm shims on Windows are .cmd files, which Node refuses to spawn without
    // a shell. Args here are flag tokens from our own code/settings (the prompt
    // travels on stdin), so shell quoting is not a concern.
    const shell = /\.(cmd|bat)$/i.test(file)
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      child.kill('SIGTERM')
      settle(() => reject(abortError()))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    child.on('error', (err) => settle(() => reject(err)))
    child.on('close', (code) => settle(() => resolve({ code, stdout, stderr })))
    // The child may exit before reading all of stdin (e.g. usage error) — an
    // EPIPE here must not crash the app.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

/** Sibling of `runCli` for backends that emit incremental output: spawn, feed
 *  stdin, and yield complete stdout lines as they arrive instead of buffering
 *  the whole answer. `label` names the command in the non-zero-exit message.
 *  The child is killed on abort and on early consumer exit (the `finally`). */
async function* runCliLines(
  file: string,
  args: string[],
  label: string,
  opts: { input?: string; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): AsyncIterable<string> {
  if (opts.signal?.aborted) throw abortError()
  const shell = /\.(cmd|bat)$/i.test(file)
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell })
  const onAbort = (): void => {
    child.kill('SIGTERM')
    // Killing the child does not reap a grandchild that inherited this pipe (a
    // shell wrapper leaves one behind), and the iteration below would wait for
    // *every* writer to let go. Drop our end instead of stalling past the abort.
    child.stdout.destroy()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => (stderr += d))
  // Spawn failure (ENOENT) and exit code both land here; `close` fires after
  // both stdio streams end, so awaiting it below never truncates output.
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
  // An abort returns before `closed` is awaited; mark it handled so a spawn
  // error on the way out is not an unhandled rejection.
  void closed.catch(() => {})
  child.stdin.on('error', () => {})
  child.stdin.end(opts.input ?? '')
  try {
    child.stdout.setEncoding('utf8')
    let buf = ''
    try {
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) yield line
        }
      }
      if (buf.trim()) yield buf
    } catch (err) {
      // Destroying stdout on abort surfaces here as a premature close; the
      // abort is the real story.
      if (opts.signal?.aborted) throw abortError()
      throw err
    }
    // Report the abort before waiting on the exit code: a killed child exits
    // non-zero, and `close` may lag behind a grandchild that outlived it.
    if (opts.signal?.aborted) throw abortError()
    const code = await closed
    if (code !== 0)
      // Tagged so distill's retry policy can tell "the CLI fell over" (worth
      // another go) from "you are not signed in" (never worth another go) and
      // from "that prompt was too long" (worth sending less).
      throw cliFailure(
        `${label} failed (exit ${code}): ${tail(stderr) || 'no error output'}`,
        stderr,
        { exitCode: code, authFailure: isAuthMessage(stderr) }
      )
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

/** The user's own OpenAI Codex CLI (`codex exec`) under their ChatGPT sign-in. */
export function codexCliChat(cfg: ProviderConfig): ChatModel {
  const cmd = cfg.command || 'codex'
  const resolve = (): string => {
    const file = resolveCommand(cmd)
    if (!file)
      throw new Error(
        'Codex CLI not found — install it (npm install -g @openai/codex, or brew install codex), or set its full path in [talk.chat] command.'
      )
    return file
  }
  return {
    id: `codex-cli:${cfg.model || 'default'}`,
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const file = resolve()
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        ...(cfg.model ? ['-m', cfg.model] : []),
        '-' // read the prompt from stdin
      ]
      const { code, stdout, stderr } = await runCli(file, args, {
        input: flattenChatRequest(req),
        signal: req.signal,
        cwd: scratchCwd()
      })
      const { text, error } = parseCodexEvents(stdout)
      if (error)
        throw cliFailure(`Codex: ${error}`, error, { retryable: !isAuthMessage(error) })
      if (code !== 0)
        throw cliFailure(
          `Codex failed (exit ${code}): ${tail(stderr) || 'no error output'}`,
          stderr,
          { exitCode: code, authFailure: isAuthMessage(stderr) }
        )
      if (!text) throw new Error('Codex returned no answer.')
      yield text
    },
    // `codex login status` is instant and free; a real chat round-trip costs
    // ~12k tokens of Codex harness overhead against the user's plan quota.
    async probe(signal?: AbortSignal): Promise<void> {
      const file = resolve()
      const { code } = await runCli(file, ['login', 'status'], { signal })
      if (code !== 0)
        throw new Error('Codex isn\'t signed in — run "codex login" in a terminal, then try again.')
    }
  }
}

interface ClaudeEvent {
  type?: string
  event?: { type?: string; delta?: { type?: string; text?: string } }
  is_error?: boolean
  subtype?: string
  result?: string
}

/** Parse one line of `claude -p --output-format stream-json`: a token delta, the
 *  whole answer, or an error. Unparseable lines are skipped (warnings, partial
 *  writes). The `assistant` event is ignored on purpose — it repeats the text
 *  the deltas already carried, and taking both would duplicate the answer. */
export function parseClaudeLine(
  line: string
): { delta?: string; final?: string; error?: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let ev: ClaudeEvent
  try {
    ev = JSON.parse(trimmed) as ClaudeEvent
  } catch {
    return null
  }
  if (ev.type === 'stream_event') {
    const inner = ev.event
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta')
      return typeof inner.delta.text === 'string' ? { delta: inner.delta.text } : null
    return null
  }
  if (ev.type === 'result') {
    if (ev.is_error) return { error: ev.result || ev.subtype || 'the run failed' }
    // Fallback: a build that doesn't emit partial messages still puts the whole
    // answer on the terminal `result` event.
    return typeof ev.result === 'string' && ev.result ? { final: ev.result } : null
  }
  return null
}

/** Replaces Claude Code's own coding-agent system prompt. Nodebook wants a plain
 *  chat model here — the grounding instructions travel with the request — and the
 *  agent persona would both skew the answer and cost tokens on every call. */
const CLAUDE_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the request directly and completely.'

/** Environment for the `claude` child. Claude Code's own default is to let the
 *  model think at length before every answer — right for a coding agent, and
 *  the biggest cost of a chat call by far: on one distill window of ~8k
 *  characters, Haiku spent 11k thinking tokens to write a 1.3k-token answer,
 *  74 s and 7× the price of the same call with thinking off (measured against
 *  claude-code 2.1.258; see docs/cli-providers.md). The HTTP adapters send no
 *  thinking either, so this is parity, not a downgrade. A value already in the
 *  environment is the user's own choice and wins. */
function claudeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? '0' }
}

/** The user's own Claude Code CLI (`claude -p`) under their Claude sign-in.
 *
 *  The flags make it a pure chat backend rather than a coding agent: no tools
 *  (it cannot read files or reach the web), no MCP servers, no slash commands,
 *  its own system prompt replaced, and no extended thinking (`claudeEnv`).
 *  That is also what makes it cheap — measured against claude-code 2.1.233,
 *  the per-call overhead drops from ~51k input tokens to ~540, cached to
 *  near-nothing on the calls after the first. A distill run makes one call per
 *  window, so this matters. */
export function claudeCliChat(cfg: ProviderConfig): ChatModel {
  const cmd = cfg.command || 'claude'
  const resolve = (): string => {
    const file = resolveCommand(cmd)
    if (!file)
      throw new Error(
        'Claude Code CLI not found — install it (npm install -g @anthropic-ai/claude-code), or set its full path in [talk.chat] command.'
      )
    return file
  }
  return {
    id: `claude-cli:${cfg.model || 'default'}`,
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const file = resolve()
      // Node does not quote arguments when it goes through a shell (the .cmd
      // case on Windows), where a bare empty string would vanish and `--tools`
      // would swallow the next flag.
      const none = /\.(cmd|bat)$/i.test(file) ? '""' : ''
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--tools',
        none,
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--system-prompt',
        CLAUDE_SYSTEM_PROMPT,
        ...(cfg.model ? ['--model', cfg.model] : [])
      ]
      let streamed = false
      let final = ''
      let failure: string | null = null
      for await (const line of runCliLines(file, args, 'Claude CLI', {
        input: flattenChatRequest(req),
        signal: req.signal,
        cwd: scratchCwd(),
        env: claudeEnv()
      })) {
        const ev = parseClaudeLine(line)
        if (!ev) continue
        if (ev.error) failure ??= ev.error
        else if (ev.delta) {
          streamed = true
          yield ev.delta
        } else if (ev.final) final = ev.final
      }
      if (failure)
        throw cliFailure(`Claude: ${failure}`, failure, { retryable: !isAuthMessage(failure) })
      if (streamed) return
      if (!final) throw new Error('Claude CLI returned no answer.')
      yield final
    },
    // `claude auth status` is instant and free; a real chat round-trip bills the
    // user's plan. It reports sign-in as JSON, so trust that over the exit code.
    async probe(signal?: AbortSignal): Promise<void> {
      const file = resolve()
      const { code, stdout } = await runCli(file, ['auth', 'status', '--json'], { signal })
      let loggedIn = code === 0
      try {
        const status = JSON.parse(stdout) as { loggedIn?: boolean }
        if (typeof status.loggedIn === 'boolean') loggedIn = status.loggedIn
      } catch {
        /* keep the exit-code verdict */
      }
      if (!loggedIn)
        throw new Error(
          'Claude Code isn\'t signed in — run "claude auth login" in a terminal, then try again.'
        )
    }
  }
}

/** Generic escape hatch: any user-supplied command that reads the prompt on
 *  stdin and prints the answer on stdout. */
export function genericCliChat(cfg: ProviderConfig): ChatModel {
  const cmd = cfg.command
  if (!cmd)
    throw new Error('The "cli" provider needs a command — set [talk.chat] command in Settings.')
  const resolve = (): string => {
    const file = resolveCommand(cmd)
    if (!file)
      throw new Error(
        `"${cmd}" not found — check [talk.chat] command (use a full path if it's not on PATH).`
      )
    return file
  }
  return {
    id: `cli:${cmd}`,
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const file = resolve()
      const { code, stdout, stderr } = await runCli(file, cfg.args ?? [], {
        input: flattenChatRequest(req),
        signal: req.signal,
        cwd: scratchCwd()
      })
      if (code !== 0)
        throw cliFailure(
          `"${cmd}" failed (exit ${code}): ${tail(stderr) || 'no error output'}`,
          stderr,
          { exitCode: code, authFailure: isAuthMessage(stderr) }
        )
      const out = stdout.trim()
      if (!out) throw new Error(`"${cmd}" printed no answer.`)
      yield out
    },
    async probe(): Promise<void> {
      resolve()
    }
  }
}
