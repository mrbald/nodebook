import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  claudeCliChat,
  codexCliChat,
  genericCliChat,
  flattenChatRequest,
  parseClaudeLine,
  parseCodexEvents,
  resolveCommand
} from './cliChat'
import type { ChatRequest } from './provider'

const collect = async (stream: AsyncIterable<string>): Promise<string> => {
  let out = ''
  for await (const tok of stream) out += tok
  return out
}

describe('flattenChatRequest', () => {
  it('passes a single user message through untouched', () => {
    expect(flattenChatRequest({ messages: [{ role: 'user', content: 'hello' }] })).toBe('hello')
  })

  it('prepends the system prompt', () => {
    expect(
      flattenChatRequest({ system: 'Be brief.', messages: [{ role: 'user', content: 'hello' }] })
    ).toBe('Be brief.\n\nhello')
  })

  it('labels roles in a multi-turn transcript (the distill repair retry)', () => {
    const req: ChatRequest = {
      system: 'S',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'bad json' },
        { role: 'user', content: 'fix it' }
      ]
    }
    expect(flattenChatRequest(req)).toBe('S\n\nUser:\nq\n\nAssistant:\nbad json\n\nUser:\nfix it')
  })

  it('folds system-role messages into the system section', () => {
    const req: ChatRequest = {
      system: 'S1',
      messages: [
        { role: 'system', content: 'S2' },
        { role: 'user', content: 'q' }
      ]
    }
    expect(flattenChatRequest(req)).toBe('S1\n\nS2\n\nq')
  })
})

describe('parseCodexEvents', () => {
  // A real `codex exec --json` transcript (codex-cli 0.142.5).
  const real = [
    '{"type":"thread.started","thread_id":"019f2bda-c545-7cc1-a8b8-4aba6ed04322"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":11668,"cached_input_tokens":8960,"output_tokens":5,"reasoning_output_tokens":0}}'
  ].join('\n')

  it('extracts the agent message from a real transcript', () => {
    expect(parseCodexEvents(real)).toEqual({ text: 'OK', error: null })
  })

  it('joins multiple agent messages and skips other items', () => {
    const out = parseCodexEvents(
      [
        '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"one"}}',
        'not json at all',
        '{"type":"item.completed","item":{"type":"agent_message","text":"two"}}'
      ].join('\n')
    )
    expect(out).toEqual({ text: 'one\n\ntwo', error: null })
  })

  it('surfaces turn.failed and error events', () => {
    expect(parseCodexEvents('{"type":"turn.failed","error":{"message":"limit reached"}}').error).toBe(
      'limit reached'
    )
    expect(parseCodexEvents('{"type":"error","message":"boom"}').error).toBe('boom')
    expect(parseCodexEvents('{"type":"turn.failed"}').error).toBe('the turn failed')
  })

  it('returns empties for empty output', () => {
    expect(parseCodexEvents('')).toEqual({ text: '', error: null })
  })
})

// Real lines from `claude -p --output-format stream-json --include-partial-messages`
// (claude-code 2.1.233), answering "Reply with exactly: hello from claude".
const CLAUDE_TRANSCRIPT = [
  '{"type":"system","subtype":"init","cwd":"/tmp/empty","session_id":"46d82be3","tools":[],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default"}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"46d82be3","uuid":"b6b0cae1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"h"}},"session_id":"46d82be3","uuid":"e6efd69f"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ello from claude"}},"session_id":"46d82be3","uuid":"602eef09"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from claude"}]},"session_id":"46d82be3"}',
  '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"46d82be3","uuid":"f2d5bbc4"}',
  '{"type":"stream_event","event":{"type":"message_stop"},"session_id":"46d82be3","uuid":"85ee405f"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"hello from claude","session_id":"46d82be3","num_turns":1}'
]

describe('parseClaudeLine', () => {
  it('pulls the text deltas out of a real transcript and nothing else', () => {
    const deltas = CLAUDE_TRANSCRIPT.map(parseClaudeLine)
      .filter((e) => e?.delta)
      .map((e) => e!.delta)
    expect(deltas).toEqual(['h', 'ello from claude'])
  })

  it('ignores the assistant event, which repeats what the deltas already carried', () => {
    const assistant = CLAUDE_TRANSCRIPT.find((l) => l.includes('"type":"assistant"'))!
    expect(parseClaudeLine(assistant)).toBeNull()
  })

  it('reads the whole answer off the final result event', () => {
    expect(parseClaudeLine(CLAUDE_TRANSCRIPT[CLAUDE_TRANSCRIPT.length - 1])).toEqual({
      final: 'hello from claude'
    })
  })

  it('surfaces an errored result, preferring its message over the subtype', () => {
    expect(parseClaudeLine('{"type":"result","is_error":true,"result":"limit reached"}')).toEqual({
      error: 'limit reached'
    })
    expect(parseClaudeLine('{"type":"result","is_error":true,"subtype":"error_max_turns"}')).toEqual({
      error: 'error_max_turns'
    })
    expect(parseClaudeLine('{"type":"result","is_error":true}')).toEqual({ error: 'the run failed' })
  })

  it('skips blank and unparseable lines', () => {
    expect(parseClaudeLine('')).toBeNull()
    expect(parseClaudeLine('not json at all')).toBeNull()
  })
})

describe('resolveCommand', () => {
  const unix = { platform: 'linux' as NodeJS.Platform, env: { PATH: '/usr/bin:/bin' } }

  it('checks a path containing a separator as-is', () => {
    expect(resolveCommand('/x/codex', { ...unix, canRun: (p) => p === '/x/codex' })).toBe('/x/codex')
    expect(resolveCommand('/x/codex', { ...unix, canRun: () => false })).toBeNull()
  })

  it('searches PATH for a bare name', () => {
    expect(resolveCommand('codex', { ...unix, canRun: (p) => p === '/usr/bin/codex' })).toBe(
      '/usr/bin/codex'
    )
  })

  it('falls back to common install dirs missing from a GUI PATH', () => {
    expect(resolveCommand('codex', { ...unix, canRun: (p) => p === '/opt/homebrew/bin/codex' })).toBe(
      '/opt/homebrew/bin/codex'
    )
  })

  it('returns null when nothing runnable exists', () => {
    expect(resolveCommand('codex', { ...unix, canRun: () => false })).toBeNull()
  })

  it('tries Windows executable extensions', () => {
    const want = join('C:\\bin', 'codex.cmd')
    expect(
      resolveCommand('codex', {
        platform: 'win32',
        env: { PATH: 'C:\\bin' },
        canRun: (p) => p === want
      })
    ).toBe(want)
  })
})

// Real spawns — `node -e` scripts as the generic provider, a fake `codex`
// shell script for the preset. No network, no quota.
describe('genericCliChat (real spawn)', () => {
  it('requires a command', () => {
    expect(() => genericCliChat({ kind: 'cli' })).toThrow(/needs a command/)
  })

  it('feeds the prompt to stdin and yields stdout', async () => {
    const model = genericCliChat({
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)']
    })
    const out = await collect(model.chat({ system: 'S', messages: [{ role: 'user', content: 'echo me' }] }))
    expect(out).toBe('S\n\necho me')
  })

  it('reports a non-zero exit with the stderr tail', async () => {
    const model = genericCliChat({
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'console.error("kaput"); process.exit(3)']
    })
    await expect(collect(model.chat({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow(
      /exit 3.*kaput/s
    )
  })

  it('rejects an empty answer', async () => {
    const model = genericCliChat({ kind: 'cli', command: process.execPath, args: ['-e', ''] })
    await expect(collect(model.chat({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow(
      /printed no answer/
    )
  })

  it('kills the child on abort', async () => {
    const model = genericCliChat({
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)']
    })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const started = Date.now()
    await expect(
      collect(model.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('probe resolves for an existing command and throws for a missing one', async () => {
    await expect(
      genericCliChat({ kind: 'cli', command: process.execPath }).probe!()
    ).resolves.toBeUndefined()
    await expect(genericCliChat({ kind: 'cli', command: 'no-such-cmd-xyz' }).probe!()).rejects.toThrow(
      /not found/
    )
  })
})

describe.skipIf(process.platform === 'win32')('codexCliChat (fake codex script)', () => {
  let dir: string
  let okCodex: string
  let loggedOutCodex: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodebook-clichat-'))
    okCodex = join(dir, 'codex-ok')
    // Drains stdin (like the real CLI), then replays a recorded transcript.
    writeFileSync(
      okCodex,
      [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat <<'EOF'`,
        '{"type":"thread.started","thread_id":"019f2bda-c545-7cc1-a8b8-4aba6ed04322"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
        '{"type":"turn.completed","usage":{"input_tokens":11668,"cached_input_tokens":8960,"output_tokens":5,"reasoning_output_tokens":0}}',
        'EOF',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    loggedOutCodex = join(dir, 'codex-out')
    writeFileSync(loggedOutCodex, '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n', { mode: 0o755 })
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('parses the answer out of the JSONL events', async () => {
    const model = codexCliChat({ kind: 'codex-cli', command: okCodex })
    const out = await collect(model.chat({ messages: [{ role: 'user', content: 'ping' }] }))
    expect(out).toBe('OK')
  })

  it('probe passes when `login status` exits 0 and fails with a sign-in hint otherwise', async () => {
    await expect(codexCliChat({ kind: 'codex-cli', command: okCodex }).probe!()).resolves.toBeUndefined()
    await expect(codexCliChat({ kind: 'codex-cli', command: loggedOutCodex }).probe!()).rejects.toThrow(
      /codex login/
    )
  })

  it('reports a missing binary with an install hint', async () => {
    const model = codexCliChat({ kind: 'codex-cli', command: 'no-such-codex-xyz' })
    await expect(collect(model.chat({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow(
      /Codex CLI not found/
    )
  })
})

describe.skipIf(process.platform === 'win32')('claudeCliChat (fake claude script)', () => {
  let dir: string
  const script = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }
  let ok: string
  let echo: string
  let loggedOut: string
  let noDeltas: string
  let hangs: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodebook-claudechat-'))
    // `auth status` and the chat call share one binary, so the fakes branch on it.
    const auth = (json: string): string => `if [ "$1" = "auth" ]; then echo '${json}'; exit 0; fi`
    ok = script(
      'claude-ok',
      [auth('{"loggedIn":true,"authMethod":"claude.ai"}'), 'cat > /dev/null', "cat <<'EOF'", ...CLAUDE_TRANSCRIPT, 'EOF'].join('\n')
    )
    echo = script(
      'claude-echo',
      [
        'IN=$(cat)',
        `printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"%s"}}}\\n' "$IN"`
      ].join('\n')
    )
    loggedOut = script('claude-out', auth('{"loggedIn":false}'))
    noDeltas = script(
      'claude-nodeltas',
      ['cat > /dev/null', `echo '{"type":"result","subtype":"success","is_error":false,"result":"whole answer"}'`].join('\n')
    )
    hangs = script('claude-hangs', 'cat > /dev/null\nsleep 10')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('streams the answer as separate chunks, not one blob', async () => {
    const model = claudeCliChat({ kind: 'claude-cli', command: ok })
    const chunks: string[] = []
    for await (const tok of model.chat({ messages: [{ role: 'user', content: 'ping' }] })) chunks.push(tok)
    expect(chunks).toEqual(['h', 'ello from claude'])
  })

  it('feeds the flattened prompt to stdin', async () => {
    const model = claudeCliChat({ kind: 'claude-cli', command: echo })
    const out = await collect(model.chat({ messages: [{ role: 'user', content: 'ping' }] }))
    expect(out).toBe('ping')
  })

  it('falls back to the result event when the CLI emits no partial messages', async () => {
    const model = claudeCliChat({ kind: 'claude-cli', command: noDeltas })
    expect(await collect(model.chat({ messages: [{ role: 'user', content: 'x' }] }))).toBe('whole answer')
  })

  it('probe trusts the reported sign-in state over the exit code', async () => {
    await expect(claudeCliChat({ kind: 'claude-cli', command: ok }).probe!()).resolves.toBeUndefined()
    // `auth status` exits 0 here; only the JSON says the user is signed out.
    await expect(claudeCliChat({ kind: 'claude-cli', command: loggedOut }).probe!()).rejects.toThrow(
      /claude auth login/
    )
  })

  it('kills the child on abort', async () => {
    const model = claudeCliChat({ kind: 'claude-cli', command: hangs })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const started = Date.now()
    await expect(
      collect(model.chat({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports a missing binary with an install hint', async () => {
    const model = claudeCliChat({ kind: 'claude-cli', command: 'no-such-claude-xyz' })
    await expect(collect(model.chat({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow(
      /Claude Code CLI not found/
    )
  })
})
