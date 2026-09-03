/**
 * The distill eval harness — `npm run eval:distill`
 * (`vitest run --config vitest.eval.config.ts`, a separate suite from the
 * default `npm test`; see vitest.eval.config.ts for why).
 *
 * Runs the real `distill()` pipeline (`src/main/distill/run.ts`) over three
 * fixtures under `e2e/fixtures/distill/` — a multi-chapter English book, a
 * generated ~20-page PDF with header/footer/hyphenation defects, and a
 * Russian short story — against their hand-curated `golden.json`, and prints
 * one markdown metrics table (see `src/main/distill/eval/metrics.ts`).
 *
 * By default both the embedder and the chat model are deterministic stubs
 * (`src/main/distill/eval/stubs.ts`) — no network, no key, no renderer WASM
 * bridge (which doesn't exist in this headless Node run anyway, hence the
 * embedder is *always* the stub, provider or not). Set `DISTILL_EVAL_PROVIDER`
 * to swap in a real chat model instead — see the header comment on
 * `buildChat` below for the env vars and an example.
 *
 * This test only asserts *sanity* (every metric finite, rates in [0,1]) —
 * never a fixed target — so it stays green as the pipeline changes across
 * the later phases in docs/distill-documents.md. The numbers themselves,
 * committed to `docs/distill-documents.md`'s baseline section and written
 * fresh to `scripts/out/distill-eval.md` (gitignored) on every run, are what
 * those phases compare against.
 *
 * Every run also saves what it scored — each fixture's emitted notes and
 * stats — to `scripts/out/run-<provider>-<fixture>.json`. The same command
 * with `DISTILL_EVAL_REPLAY=1` re-scores those instead of running the
 * pipeline, so a metric can be redefined and re-read against a real model's
 * output without paying for the model again (a real-provider run is ~25
 * minutes).
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { convertDocument } from '../src/main/distill/convert'
import { distill, type DistillSource, type DistillDeps, type DistillResult } from '../src/main/distill/run'
import { hashEmbedder, heuristicChat } from '../src/main/distill/eval/stubs'
import {
  computeMetrics,
  type GoldenSet,
  type EvalMetrics,
  type EvalDistillResult
} from '../src/main/distill/eval/metrics'
import { makeChatModel } from '../src/main/rag/chat'
import type { ChatModel, ProviderConfig, ProviderKind } from '../src/main/rag/provider'

const FIXTURES_DIR = join(__dirname, '..', 'e2e', 'fixtures', 'distill')
const OUT_DIR = join(__dirname, 'out')
const OUT_FILE = join(OUT_DIR, 'distill-eval.md')

// --- Fixture loading -------------------------------------------------------

interface FixtureSpec {
  /** Matches a top-level key in golden.json. */
  key: string
  load(): Promise<DistillSource>
}

const FIXTURES: FixtureSpec[] = [
  {
    key: 'book-en',
    // Seven Federalist Papers essays, one book: concatenate in filename
    // order (each already carries its own `# Federalist No. N: …` heading).
    load: async () => {
      const dir = join(FIXTURES_DIR, 'book-en')
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
      const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n')
      return { file: 'book-en.md', text }
    }
  },
  {
    key: 'paper.pdf',
    // Through the real converter — pdf.js text extraction with page headings,
    // then the `cleanPdf` pass (de-hyphenation, running header/footer removal,
    // paragraph reconstruction) exactly as a real run gets it.
    load: async () => ({ file: 'paper.pdf', text: await convertDocument(join(FIXTURES_DIR, 'paper.pdf')) })
  },
  {
    key: 'chapter-ru.md',
    load: async () => ({
      file: 'chapter-ru.md',
      text: await convertDocument(join(FIXTURES_DIR, 'chapter-ru.md'))
    })
  }
]

function loadGolden(): Record<string, GoldenSet> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'golden.json'), 'utf8')) as Record<string, GoldenSet>
}

// --- Chat model: stub by default, a real provider via env ------------------

/**
 * Build the chat half of `DistillDeps`. Default: the deterministic
 * `heuristicChat` stub (no env needed). Set `DISTILL_EVAL_PROVIDER` (one of
 * `ProviderKind` — `anthropic`, `openai-compat`, `ollama`, `codex-cli`,
 * `claude-cli`, `cli`) to route through `makeChatModel` instead, configured
 * the same way `src/main/settings.ts`'s `chatProviderConfig()` configures
 * "Ask": `DISTILL_EVAL_MODEL` / `DISTILL_EVAL_BASE_URL` / `DISTILL_EVAL_COMMAND`,
 * plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the HTTP providers (CLI
 * providers authenticate via the CLI's own sign-in, no key). `NODEBOOK_E2E`
 * is unset first — `makeChatModel` forces the network-free stub when it's
 * set, which would silently defeat a real-provider run.
 *
 * Example: `DISTILL_EVAL_PROVIDER=anthropic DISTILL_EVAL_MODEL=claude-sonnet-4-6
 * ANTHROPIC_API_KEY=sk-... npm run eval:distill`.
 */
function buildChat(): ChatModel {
  const kind = process.env.DISTILL_EVAL_PROVIDER
  if (!kind) return heuristicChat()

  delete process.env.NODEBOOK_E2E

  const isCli = kind === 'codex-cli' || kind === 'claude-cli' || kind === 'cli'
  const apiKey = isCli
    ? undefined
    : kind === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY

  const cfg: ProviderConfig = {
    kind: kind as ProviderKind,
    model: process.env.DISTILL_EVAL_MODEL || undefined,
    baseUrl: process.env.DISTILL_EVAL_BASE_URL || undefined,
    command: process.env.DISTILL_EVAL_COMMAND || undefined,
    apiKey
  }
  return makeChatModel(cfg)
}

function buildDeps(): DistillDeps {
  // The embedder is always the stub: there is no renderer WASM bridge in a
  // headless Node vitest run, real-provider chat or not.
  return { embedder: hashEmbedder(), chat: buildChat() }
}

// --- Saved runs: re-score without re-running -----------------------------

/** Where a fixture's last run under this provider is kept — the slice the
 *  metrics read (`notes` + `stats`), keyed by provider so a stub run never
 *  overwrites a paid one. */
function runFile(key: string): string {
  return join(OUT_DIR, `run-${process.env.DISTILL_EVAL_PROVIDER || 'stub'}-${key}.json`)
}

function saveRun(key: string, result: DistillResult): void {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(runFile(key), JSON.stringify({ notes: result.notes, stats: result.stats }, null, 2), 'utf8')
}

function loadRun(key: string): EvalDistillResult {
  const path = runFile(key)
  if (!existsSync(path))
    throw new Error(`DISTILL_EVAL_REPLAY: no saved run at ${path} — run the same command once without it first`)
  return JSON.parse(readFileSync(path, 'utf8')) as EvalDistillResult
}

// --- Reporting ---------------------------------------------------------

const COLUMNS = [
  'yieldPer10k',
  'coverage',
  'dropped',
  'failedWindows',
  'merged',
  'edgesPerNote',
  'ghostLinkRate',
  'components',
  'duplicateTitleRate',
  'conceptRecall',
  'edgePrecision',
  'edgesJudged',
  'edgeRecall'
] as const

function formatTable(rows: { fixture: string; metrics: EvalMetrics }[]): string {
  const header = `| fixture | ${COLUMNS.join(' | ')} |`
  const sep = `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`
  const body = rows.map(({ fixture, metrics }) => {
    const cells = COLUMNS.map((c) => {
      const v = metrics[c]
      return typeof v === 'number' ? v.toFixed(2) : '—'
    })
    return `| ${fixture} | ${cells.join(' | ')} |`
  })
  return [header, sep, ...body].join('\n') + '\n'
}

// --- The eval itself -----------------------------------------------------

describe('distill eval', () => {
  it('runs the pipeline over every fixture and reports metrics', async () => {
    const golden = loadGolden()
    const replay = Boolean(process.env.DISTILL_EVAL_REPLAY)
    const deps = replay ? null : buildDeps()
    const rows: { fixture: string; metrics: EvalMetrics }[] = []

    for (const fx of FIXTURES) {
      const source = await fx.load()
      let result: EvalDistillResult
      if (deps) {
        const fresh = await distill(source, deps)
        saveRun(fx.key, fresh)
        result = fresh
      } else result = loadRun(fx.key)
      const metrics = computeMetrics(source.text, result, golden[fx.key])
      rows.push({ fixture: fx.key, metrics })

      for (const [k, v] of Object.entries(metrics)) {
        expect(Number.isFinite(v), `${fx.key}.${k} should be a finite number`).toBe(true)
      }
      expect(metrics.coverage, `${fx.key}.coverage`).toBeGreaterThanOrEqual(0)
      expect(metrics.coverage, `${fx.key}.coverage`).toBeLessThanOrEqual(1)
      for (const rate of ['conceptRecall', 'edgePrecision', 'edgeRecall'] as const) {
        const v = metrics[rate]
        if (v === undefined) continue
        expect(v, `${fx.key}.${rate}`).toBeGreaterThanOrEqual(0)
        expect(v, `${fx.key}.${rate}`).toBeLessThanOrEqual(1)
      }
    }

    const table = formatTable(rows)
    console.log(`\n${table}`)
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(OUT_FILE, table, 'utf8')
  })
})
