import { spawn } from 'child_process'
import { accessSync, constants, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import type { ChatModel, ChatRequest, ProviderConfig } from './provider'

/**
 * CLI-backed chat adapters: run a local command the user already has installed
 * and signed in (their subscription, no API key) and treat it as a `ChatModel`.
 * See docs/cli-providers.md for the design and the policy line.
 *
 * - `codexCliChat` — preset for the OpenAI Codex CLI: `codex exec --json`,
 *   prompt on stdin, answer parsed from its JSONL events (no incremental
 *   deltas, so the whole answer arrives as one chunk).
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
  opts: { input?: string; signal?: AbortSignal; cwd?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError())
    // npm shims on Windows are .cmd files, which Node refuses to spawn without
    // a shell. Args here are flag tokens from our own code/settings (the prompt
    // travels on stdin), so shell quoting is not a concern.
    const shell = /\.(cmd|bat)$/i.test(file)
    const child = spawn(file, args, { cwd: opts.cwd, env: process.env, shell })
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
      if (error) throw new Error(`Codex: ${error}`)
      if (code !== 0) throw new Error(`Codex failed (exit ${code}): ${tail(stderr) || 'no error output'}`)
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
      if (code !== 0) throw new Error(`"${cmd}" failed (exit ${code}): ${tail(stderr) || 'no error output'}`)
      const out = stdout.trim()
      if (!out) throw new Error(`"${cmd}" printed no answer.`)
      yield out
    },
    async probe(): Promise<void> {
      resolve()
    }
  }
}
