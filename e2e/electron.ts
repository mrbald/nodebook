import { expect, test as base, _electron } from '@playwright/test'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

type Run = {
  child: ChildProcess
  closed: Promise<void>
  started: string
  crashDumps?: string
  stderr: string
  expectedExit: boolean
  exited: boolean
  failures: string[]
  reported: boolean
}

const runs = new Map<ElectronApplication, Run>()

// The SDK's bootstrap_look_up can check the actual service under Seatbelt.
// Use macOS's system Ruby FFI so this restricted-shell check needs no build.
const macGuiProbe = `
lib = Fiddle::Handle::DEFAULT
lookup = Fiddle::Function.new(lib["bootstrap_look_up"],
  [Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)
bootstrap = Fiddle::Pointer.new(lib["bootstrap_port"])[0, 4].unpack1("I")
results = ARGV.map do |name|
  result = lookup.call(bootstrap, name, Fiddle::Pointer.malloc(4))
  puts "#{name}: #{result}" unless result.zero?
  result
end
exit 72 if results.include?(1100) # BOOTSTRAP_NOT_PRIVILEGED
exit(results.all?(&:zero?) ? 0 : 73)
`
let macGuiFailure: string | null | undefined

function checkMacGui(): void {
  if (process.platform !== 'darwin' || process.env.CODEX_SANDBOX !== 'seatbelt') return
  if (macGuiFailure === undefined) {
    const probe = spawnSync('/usr/bin/ruby', [
      '-rfiddle', '-', 'com.apple.coreservices.launchservicesd', 'com.apple.windowserver.active'
    ], { input: macGuiProbe, encoding: 'utf8', timeout: 3000 })
    const detail = probe.stdout?.trim().replaceAll('\n', ', ') || probe.error?.message || `probe exit ${probe.status}`
    const reason = probe.status === 72
      ? 'macOS denied access to a required GUI service'
      : 'the test could not verify access to macOS GUI services'
    macGuiFailure = probe.status === 0 ? null
      : `Electron launch blocked: ${reason} (${detail}). Rerun from a GUI-capable shell outside the restricted sandbox.`
  }
  if (macGuiFailure) throw new Error(macGuiFailure)
}

export { expect }
export const test = base.extend<{ electronDiagnostics: void }>({
  // Playwright requires a destructured first argument, even without dependencies.
  // eslint-disable-next-line no-empty-pattern
  electronDiagnostics: [async ({}, use, info) => {
    await use()
    for (const [app, run] of runs) {
      try {
        await checkRun(run, info)
      } finally {
        if (run.exited) runs.delete(app)
      }
    }
  }, { auto: true }]
})

async function attachLog(info: TestInfo, filename: string, log: string): Promise<void> {
  const path = info.outputPath(filename)
  await writeFile(path, stripVTControlCharacters(log), 'utf8')
  await info.attach(filename, { path, contentType: 'text/plain' })
}

export async function launchElectron(
  options: Parameters<typeof _electron.launch>[0]
): Promise<ElectronApplication> {
  const started = new Date().toISOString()
  const info = base.info()
  let crashDumps: string | undefined
  let app: ElectronApplication
  try {
    checkMacGui()
    if (process.platform === 'darwin' && options?.env?.NODEBOOK_E2E === '1') {
      // Apps shared by a spec can outlive the test whose beforeAll launched them.
      await mkdir(info.project.outputDir, { recursive: true })
      crashDumps = await mkdtemp(join(info.project.outputDir, 'electron-crash-'))
      options = { ...options, env: { ...options.env, NODEBOOK_E2E_CRASH_DUMPS: crashDumps } }
    }
    app = await _electron.launch(options)
  } catch (error) {
    // Launch failures are already enriched with child output by Playwright.
    await attachLog(info, 'electron-launch.log', `${started}\n${String(error)}${crashDumpLocation(crashDumps)}\n`)
    throw error
  }

  const child = app.process()
  const closed = new Promise<void>((resolve) => child.once('close', resolve))
  const run: Run = {
    child, closed, started, crashDumps, stderr: '', expectedExit: false, exited: false,
    failures: [], reported: false
  }
  runs.set(app, run)
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    run.stderr = (run.stderr + chunk).slice(-32_768)
  })
  child.once('exit', () => recordExit(run))
  app.context().once('close', () => {
    if (!run.expectedExit) run.failures.push('Electron browser context closed unexpectedly')
  })
  const watchWindow = (page: Page): void => {
    page.once('crash', () => run.failures.push(
      run.expectedExit ? 'Electron renderer crashed during shutdown' : 'Electron renderer crashed'
    ))
  }
  app.on('window', watchWindow)
  for (const page of app.windows()) watchWindow(page)
  recordExit(run)
  return app
}

function recordExit(run: Run): void {
  const { exitCode, signalCode } = run.child
  if (run.exited || (exitCode === null && signalCode === null)) return
  run.exited = true
  if (!run.expectedExit || exitCode !== 0 || signalCode !== null) {
    const phase = run.expectedExit ? 'during shutdown' : 'unexpectedly'
    run.failures.push(`Electron main process exited ${phase} (code=${exitCode}, signal=${signalCode})`)
  }
}

function crashDumpLocation(path?: string): string {
  return path ? `\nCrashpad directory: ${path}` : ''
}

async function checkRun(run: Run, info: TestInfo): Promise<void> {
  recordExit(run)
  if (!run.failures.length || run.reported) return
  run.reported = true
  const detail = run.failures.join('\n') + crashDumpLocation(run.crashDumps)
  await attachLog(
    info,
    `electron-${run.child.pid}.log`,
    `Launched ${run.started}: ${run.child.spawnfile} (PID ${run.child.pid})\n` +
    `Observed ${new Date().toISOString()}\n${detail}\n\nRecent stderr\n${run.stderr}\n`
  )
  throw new Error(detail)
}

// Call before a tested action that should quit the app without app.close().
export function expectElectronExit(app: ElectronApplication): void {
  const run = runs.get(app)
  if (!run) return
  recordExit(run)
  run.expectedExit = true
}

export async function closeElectron(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  const run = runs.get(app)
  expectElectronExit(app)
  try {
    await app.close()
    // close() can also return when just the DevTools connection is gone.
    if (run && !run.exited && !run.failures.length) await run.closed
  } finally {
    // Playwright's close resolves on process termination, including a crash.
    if (run) await checkRun(run, base.info())
  }
}
