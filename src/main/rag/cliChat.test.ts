import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { codexCliChat, genericCliChat, flattenChatRequest, parseCodexEvents, resolveCommand } from './cliChat'
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
