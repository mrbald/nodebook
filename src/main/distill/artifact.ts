/**
 * The on-disk layout of a distill run — pure path logic plus filesystem writes,
 * with NO database dependency. This is deliberate: the `better-sqlite3` native
 * addon is built for Electron's ABI and can't load under vitest, so the indexed
 * store (a `VaultIndex` over the run's db) lives separately and is e2e-covered.
 * Keeping the layout here means the part that matters most — the firewall — is
 * unit-testable.
 *
 * A run is a self-contained artifact under the vault's `.distill/` dir: a dot-dir
 * the canonical scan and file watcher already ignore. That ignore IS the
 * firewall — staged notes can't reach the canonical index, search, or graph
 * until an explicit promote moves them into the vault proper. Unlike `.nodebook/`
 * (a rebuildable cache) this directory holds work that exists nowhere else, so
 * it is durable staging: written atomically, migrated forward, backed up.
 */

import { readPdfExtraction, type PdfExtraction } from '../../shared/pdfExtraction'
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  existsSync,
  linkSync,
  lstatSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'path'
import { figurePath, parseFigurePath, type FigureCoverage, type FigureRef } from '../../shared/figures'
import { linkedFigurePaths, localDirectory, readFigureFile, readFigureRefs, readLocalFile, readFigureCoverage, rememberWrittenFigure } from './figureFiles'
import { withinRoot } from '../paths'
import { noteName, renderDocumentNote, sourceTitle, type EmittedNote } from './emit'
import {
  rewriteLinks,
  rewriteSourceField,
  rewriteThemeMembers,
  withSameAs,
  type MergeAction,
  type MergePlanEntry,
  confirmedSameAs,
  type SameAsConfirmation
} from './mergePlan'
import type { ExtractedItem } from './extract'

/** A safe run id is one path segment: alphanumeric start, then word/space/.-, no `..`. */
const RUN_ID_RE = /^[A-Za-z0-9][\w .-]*$/

/** Names under `.distill/` that belong to something other than a run — the
 *  source store lives there too (`sources.ts`). A run may not take one, and
 *  `listRuns` never reports one as a run. */
const FIGURE_MERGES_FOLDER = 'figure-merges'
export const RESERVED_RUN_IDS: ReadonlySet<string> = new Set(['sources', FIGURE_MERGES_FOLDER])

export function assertRunId(runId: string): void {
  if (!isRunId(runId)) throw new Error(`invalid distill run id: ${JSON.stringify(runId)}`)
}

/**
 * `<vault>/.distill` — the parent of all runs.
 *
 * A DOT-DIR, so the vault scan and the file watcher skip it exactly as they skip
 * `.nodebook/` (see `paths.ignoredInVault`): the staging firewall is unchanged.
 * What changed is durability. Runs used to live inside `.nodebook/`, which the
 * README calls a rebuildable cache you may delete — and deleting it took every
 * unmerged run with it. `.distill/` holds work that exists nowhere else, so it
 * is documented as durable staging and `.nodebook/` goes back to being a cache.
 */
export function distillRoot(vaultRoot: string): string {
  return join(vaultRoot, '.distill')
}

/** Where runs lived before `.distill/` — read once, at vault open, to move them. */
export function legacyDistillRoot(vaultRoot: string): string {
  return join(vaultRoot, '.nodebook', 'distill')
}

/**
 * One-time move of every legacy run into `.distill/`, run at vault open.
 *
 * A rename, not a copy: the run (notes, `meta.json`, `merge.json`, `run.db`,
 * checkpoint) arrives whole, so a merged run stays undoable across the move. A
 * run whose id already exists in `.distill/` is left where it is rather than
 * clobbering the newer one; anything that fails to move is simply skipped, and
 * the caller can try again next open. Returns the ids actually moved.
 */
export function migrateDistillRuns(vaultRoot: string): string[] {
  const from = legacyDistillRoot(vaultRoot)
  if (!existsSync(from)) return []
  const to = distillRoot(vaultRoot)
  const moved: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(from, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  for (const id of entries) {
    try {
      assertRunId(id)
      const target = join(to, id)
      if (existsSync(target)) continue
      mkdirSync(to, { recursive: true })
      renameSync(join(from, id), target)
      moved.push(id)
    } catch {
      // Unreadable / unsafe name / cross-device: leave it, report the rest.
    }
  }
  try {
    if (readdirSync(from).length === 0) rmSync(from, { recursive: true, force: true })
  } catch {
    /* not empty, or gone — nothing to tidy */
  }
  return moved
}

/** Write bytes so a reader never sees half a file: temp in the same dir, then
 *  rename (atomic on the same filesystem). Every write under `.distill/` goes
 *  through it — the run artifacts here, and the source store in `sources.ts`. */
export function atomicWrite(path: string, data: string | Buffer, exclusive = false): void {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, data, { flag: 'wx' })
    if (exclusive) linkSync(tmp, path)
    else renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** A run's own folder. Throws on an unsafe id. */
export function runDir(vaultRoot: string, runId: string): string {
  assertRunId(runId)
  return join(distillRoot(vaultRoot), runId)
}

/** The note name for the source book (its `source::` target), from a path.
 *  Reuses emit.ts's `sourceTitle` + `noteName` exactly, so this is always the
 *  same name the emitted notes' `source::` link points at — the link resolves
 *  to a real note instead of a ghost. */
export function sourceNoteName(file: string): string {
  return noteName(sourceTitle(file))
}

export interface RunSource {
  pdf?: PdfExtraction
  figures?: FigureRef[]
  figureCoverage?: FigureCoverage
  /** The document's raw file identifier (e.g. `Federalist.md`). Note names
   *  derive from it via `sourceNoteName`; `meta.json` keeps it as-is. */
  file: string
  text: string
  /** sha1 of `text` — the document's identity in the source store
   *  (`sources.ts`). Recorded in `run.json`, `meta.json` and on the book note,
   *  so two runs of the same document can be told apart from two runs of two
   *  documents. Absent for a run made before the store existed. */
  hash?: string
  /** Absolute path of the file this was converted from — what "Open original"
   *  opens. Never sent to the model. */
  originalPath?: string
}

// --- A run in flight: start marker, converted text, checkpoint -------------
// The run dir is created BEFORE the first model call, not after the last one.
// That is what makes a run resumable: `run.json` says what is being distilled,
// `source.md` holds the converted text (so a resume never re-converts and never
// depends on the original file still being there), and `progress.jsonl` records
// each window as it lands. `meta.json` appearing is what marks the run FINISHED.

/** File names inside a run dir, in the order they appear during a run. */
const RUN_FILE = 'run.json'
const SOURCE_FILE = 'source.md'
const CHECKPOINT_FILE = 'progress.jsonl'
const META_FILE = 'meta.json'

/** What `run.json` records: the run's identity, written at start. */
export interface RunJson {
  pdf?: PdfExtraction
  figures?: FigureRef[]
  figureCoverage?: FigureCoverage
  /** The document's raw file identifier, exactly as given to the run. */
  file: string
  /** ISO timestamp of the run's start. */
  createdAt: string
  /** The source store's identity for the converted text (see `sources.ts`). */
  hash?: string
  /** Where the document was read from — for "Open original" and diagnosis. */
  originalPath?: string
  /** Provider/model the run was started with (free-form, for later diagnosis). */
  settings?: Record<string, string>
  /** What the user asked this reading to focus on (see `extract.ts`), already
   *  normalised. Recorded here because a resume must read the same document
   *  the same way — it is asked once, at the start, and never again. Absent
   *  for a run given no focus, and for every run made before there was one. */
  focus?: string
}

/** Create the run dir and record what the run is, before any model call.
 *  Idempotent for the text; a second call rewrites `run.json`'s timestamp, so
 *  a resume must not call it. */
export function beginRun(
  vaultRoot: string,
  runId: string,
  source: RunSource,
  settings?: Record<string, string>,
  focus?: string
): string {
  const dir = runDir(vaultRoot, runId)
  if (!localDirectory(vaultRoot, dir, true)) throw new Error('Staged run is unavailable.')
  copyRunFigures(vaultRoot, join(distillRoot(vaultRoot), 'sources'), dir, source)
  const run: RunJson = {
    file: source.file,
    pdf: source.pdf,
    ...(source.figures?.length ? { figures: source.figures } : {}),
    ...(source.figureCoverage ? { figureCoverage: source.figureCoverage } : {}),
    createdAt: new Date().toISOString(),
    ...(source.hash ? { hash: source.hash } : {}),
    ...(source.originalPath ? { originalPath: source.originalPath } : {}),
    ...(settings ? { settings } : {}),
    ...(focus ? { focus } : {})
  }
  atomicWrite(join(dir, SOURCE_FILE), source.text)
  atomicWrite(join(dir, RUN_FILE), JSON.stringify(run, null, 2))
  return dir
}

function copyRunFigures(vault: string, from: string, to: string, source: RunSource): void {
  if (!source.figures?.length) return
  if (!localDirectory(vault, join(to, 'figures'), true)) throw new Error('Figure folder is unavailable.')
  const linked = linkedFigurePaths(source.text)
  const copied = new Set<string>()
  for (const ref of source.figures) {
    const path = figurePath(ref)
    if (copied.has(path)) continue
    const staged = linked.has(path) && readFigureFile(vault, from, ref)
    if (!staged) throw new Error(`Saved figure is unavailable: ${ref.label}`)
    atomicWrite(join(to, path), staged.bytes)
    rememberWrittenFigure(vault, to, ref)
    copied.add(path)
  }
}

/** A hand-edited or half-written run file can hold anything, so a `focus` that
 *  is not a string is DROPPED rather than passed on: a resume that took it back
 *  would fail with a type error instead of simply having no focus, and the runs
 *  list would render whatever it found. */
function withCheckedFocus<T extends { focus?: unknown }>(m: T): T {
  if (typeof m.focus === 'string' && m.focus) return m
  const out = { ...m }
  delete out.focus
  return out
}

/** A run's `run.json`, or null when it predates the start marker / is unreadable. */
export function readRunJson(vaultRoot: string, runId: string): RunJson | null {
  try {
    const raw = readLocalFile(vaultRoot, join(runDir(vaultRoot, runId), RUN_FILE))
    if (!raw) return null
    const m = JSON.parse(raw.toString('utf8')) as RunJson
    if (typeof m.file !== 'string' || typeof m.createdAt !== 'string') return null
    return withCheckedFocus({ ...m, figures: readFigureRefs(m.figures), figureCoverage: readFigureCoverage(m.figureCoverage) })
  } catch {
    return null
  }
}

/** The run's own copy of the converted document — what a resume re-reads. */
export function readRunSource(vaultRoot: string, runId: string): RunSource | null {
  const run = readRunJson(vaultRoot, runId)
  if (!run) return null
  try {
    const raw = readLocalFile(vaultRoot, join(runDir(vaultRoot, runId), SOURCE_FILE))
    if (!raw || (run.hash && contentHash(raw) !== run.hash)) return null
    return {
      file: run.file,
      pdf: readPdfExtraction(run.pdf),
      text: raw.toString('utf8'),
      ...(run.figures?.length ? { figures: run.figures } : {}),
      ...(run.figureCoverage ? { figureCoverage: run.figureCoverage } : {}),
      ...(run.hash ? { hash: run.hash } : {}),
      ...(run.originalPath ? { originalPath: run.originalPath } : {})
    }
  } catch {
    return null
  }
}

/** A run that started but never finished: it has a start marker and no
 *  `meta.json`. That is the whole definition — it holds for a cancelled run, a
 *  crashed one, and one whose provider died half-way. */
export function isUnfinishedRun(vaultRoot: string, runId: string): boolean {
  const dir = runDir(vaultRoot, runId)
  return existsSync(join(dir, RUN_FILE)) && !existsSync(join(dir, META_FILE))
}

/**
 * One model call a window actually took.
 *
 * A planned window is not always one call: a provider that rejects it for
 * length has it halved and both halves read (`run.ts`). Grounding then looks
 * for a mislabelled quote among *the chunks shown in the same call*, so a
 * resume that replayed the window as its planned whole would search a wider set
 * than the original attempt did — and a quote that was unique could come back
 * ambiguous. Recording the calls as they happened is what keeps a resumed run
 * byte-identical to an uninterrupted one.
 */
export interface WindowGroup {
  /** Chunk ids shown in this one call. */
  ids: number[]
  /** How many of the record's `items` this call produced. They are stored in
   *  call order, so a replay slices them back out. */
  count: number
  /** False when the call came back unusable (bad JSON, or too long even at the
   *  split bound) — those chunks were never really read. */
  ok: boolean
}

/** One line of the checkpoint log. Append-only: the plan once, then each
 *  window as it completes or fails, then the theme names once they are known.
 *  A window record also carries what it COST (`calls`, `splits`) and how it
 *  fell into calls (`groups`), so a resumed run's stats and grounding match an
 *  uninterrupted one's. Both are absent in logs written before that. */
export type CheckpointRecord =
  | { type: 'plan'; windows: number[][] }
  | {
      type: 'window'
      index: number
      items: ExtractedItem[]
      groups?: WindowGroup[]
      calls?: number
      splits?: number
    }
  | {
      type: 'window'
      index: number
      failed: true
      groups?: WindowGroup[]
      calls?: number
      splits?: number
    }
  | { type: 'themes'; names: string[] }

/** A window a previous attempt already read (see `Checkpoint.done`). */
export interface DoneWindow {
  items: ExtractedItem[]
  failed: boolean
  /** The calls it took, in order. Null in a log from before they were
   *  recorded — such a window replays as one call over its planned chunks. */
  groups: WindowGroup[] | null
  /** Model calls it cost, and how many splits they included — summed back into
   *  the run's stats on replay, so `calls` stays "calls actually attempted". */
  calls: number
  splits: number
}

/** The log replayed into the state a resume needs. */
export interface Checkpoint {
  /** Chunk ids shown per window — the plan the first attempt committed to, so
   *  a resume neither re-embeds nor re-clusters. Null when not recorded yet. */
  plan: number[][] | null
  /** Windows already attempted: index → what came back (`failed` windows are
   *  not retried by a resume; they are counted, exactly as in a single run). */
  done: Map<number, DoneWindow>
  /** One name per theme, as the naming call answered — so a resume that got
   *  past it re-groups the notes (cheap, local) without paying for the call
   *  again. Null when the run never reached naming. */
  themes: string[] | null
}

/** Where the orchestrator reads and writes its progress. Pure interface: the
 *  run loop never touches the filesystem, and a test can hand it a fake. */
export interface CheckpointStore {
  load(): Checkpoint | null
  save(record: CheckpointRecord): void
}

/** The per-call breakdown of a window record, or null when the log predates it
 *  (or holds anything but the expected shape — a hand-edited or torn line must
 *  degrade to "replay it as one call", never throw). */
function readGroups(raw: unknown): WindowGroup[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: WindowGroup[] = []
  for (const g of raw) {
    if (typeof g !== 'object' || g === null) return null
    const { ids, count, ok } = g as { ids?: unknown; count?: unknown; ok?: unknown }
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i))) return null
    if (!Number.isInteger(count) || (count as number) < 0 || typeof ok !== 'boolean') return null
    out.push({ ids: ids as number[], count: count as number, ok })
  }
  return out
}

/** Replay checkpoint lines into a Checkpoint. A crash can tear the last line,
 *  and a torn line means "that window never landed" — skip it, don't fail. */
export function replayCheckpoint(text: string): Checkpoint {
  const cp: Checkpoint = { plan: null, done: new Map(), themes: null }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: CheckpointRecord
    try {
      rec = JSON.parse(line) as CheckpointRecord
    } catch {
      continue
    }
    if (rec.type === 'plan' && Array.isArray(rec.windows)) cp.plan = rec.windows
    else if (rec.type === 'window' && Number.isInteger(rec.index)) {
      const failed = 'failed' in rec && rec.failed === true
      const items = 'items' in rec && Array.isArray(rec.items) ? rec.items : []
      cp.done.set(rec.index, {
        items,
        failed,
        groups: readGroups(rec.groups),
        // A record from before the cost was written down still cost at least
        // the one call that produced it.
        calls: typeof rec.calls === 'number' && rec.calls >= 0 ? rec.calls : 1,
        splits: typeof rec.splits === 'number' && rec.splits >= 0 ? rec.splits : 0
      })
    } else if (rec.type === 'themes' && Array.isArray(rec.names)) {
      cp.themes = rec.names.filter((n): n is string => typeof n === 'string')
    }
  }
  return cp
}

/** The filesystem checkpoint for one run: a JSON line per event, appended as
 *  the run goes, so a kill -9 loses at most the window in flight. */
export function checkpointStore(vaultRoot: string, runId: string): CheckpointStore {
  const path = join(runDir(vaultRoot, runId), CHECKPOINT_FILE)
  return {
    load(): Checkpoint | null {
      if (!existsSync(path)) return null
      try {
        return replayCheckpoint(readFileSync(path, 'utf8'))
      } catch {
        return null
      }
    },
    save(record: CheckpointRecord): void {
      mkdirSync(runDir(vaultRoot, runId), { recursive: true })
      appendFileSync(path, `${JSON.stringify(record)}\n`)
    }
  }
}

export interface PlannedFile {
  /** Path relative to the run dir. */
  relPath: string
  content: string
}

/**
 * The files a run consists of: the source book as a note (named `sourceNoteName`
 * so `source::` resolves to a real node, not a ghost), each emitted note, and a
 * `meta.json` — which keeps the RAW source file identifier, the run's one record
 * of machine provenance now the notes carry only the short title. Pure — decides
 * the layout without touching disk. `stats` (the pipeline's run stats) is
 * persisted so a bad run — say, zero notes because every claim failed quote
 * verification — stays diagnosable after the completion banner is dismissed.
 */
export function planRunFiles(
  source: RunSource,
  notes: EmittedNote[],
  stats?: Record<string, number>,
  themes?: string[],
  focus?: string
): PlannedFile[] {
  const sourceFile = `${sourceNoteName(source.file)}.md`
  const files: PlannedFile[] = [
    { relPath: join('notes', sourceFile), content: renderDocumentNote(source).content }
  ]
  for (const n of notes) {
    // Backstop: emitNotes reserves the source name, so a collision here means
    // the caller forgot to pass it — fail loudly instead of silently writing
    // the concept over the book.
    if (n.fileName.toLowerCase() === sourceFile.toLowerCase())
      throw new Error(
        `distill: emitted note "${n.fileName}" would overwrite the source note — emitNotes must reserve "${sourceFile}"`
      )
    files.push({ relPath: join('notes', n.fileName), content: n.content })
  }
  files.push({
    relPath: 'meta.json',
    content: JSON.stringify(
      {
        source: source.file,
        ...(source.hash ? { sourceHash: source.hash } : {}),
        notes: notes.length,
        ...(focus ? { focus } : {}),
        ...(themes?.length ? { themes } : {}),
        ...(stats ? { stats } : {})
      },
      null,
      2
    )
  })
  return files
}

/** What `meta.json` records about a run (see `planRunFiles`). */
export interface RunMeta {
  /** The raw source file identifier, exactly as given to the run. */
  source: string
  /** The converted text's identity in the source store (see `sources.ts`).
   *  Absent for a run made before the store existed. */
  sourceHash?: string
  notes: number
  /** The run's theme names, in map order — what the runs list shows under a
   *  run so you can tell one run of a book from another. Absent when the run
   *  was too small to group (see `themes.ts`). */
  themes?: string[]
  /** What this reading was asked to focus on. The other half of telling two
   *  runs of one book apart, and the run's only record of the question it was
   *  answering. Absent = no focus was given. */
  focus?: string
  stats?: Record<string, number>
}

/** Read a run's `meta.json`; null when missing/unreadable (pre-stats runs
 *  still parse — `stats` is simply absent). */
export function readRunMeta(vaultRoot: string, runId: string): RunMeta | null {
  try {
    const raw = readFileSync(join(runDir(vaultRoot, runId), 'meta.json'), 'utf8')
    const m = JSON.parse(raw) as RunMeta
    if (typeof m.source !== 'string' || typeof m.notes !== 'number') return null
    return withCheckedFocus(m)
  } catch {
    return null
  }
}

export interface RunArtifact {
  dir: string
  /** Absolute paths of the note files (source + emitted) — what the caller indexes. */
  notePaths: string[]
}

/**
 * Write a run's files to disk, replacing any previous artifact for that id.
 * Filesystem only — no indexing. Returns the note paths for the caller to index
 * into the run's separate database.
 *
 * Finishing a run REPLACES `notes/` and `meta.json` and drops the checkpoint —
 * it must not wipe the whole dir, because `run.json` and `source.md` were
 * written at the start and the book note here is derived from that same text.
 * (A caller that never called `beginRun` gets them written now, so every run
 * dir has one shape.)
 */
export function writeRunArtifact(
  vaultRoot: string,
  runId: string,
  source: RunSource,
  notes: EmittedNote[],
  stats?: Record<string, number>,
  themes?: string[],
  focus?: string
): RunArtifact {
  const dir = runDir(vaultRoot, runId)
  if (!existsSync(join(dir, RUN_FILE)) || !existsSync(join(dir, SOURCE_FILE)))
    beginRun(vaultRoot, runId, source, undefined, focus)
  rmSync(join(dir, 'notes'), { recursive: true, force: true })
  mkdirSync(join(dir, 'notes'), { recursive: true })
  copyRunFigures(vaultRoot, dir, join(dir, 'notes'), source)
  const notePaths: string[] = []
  for (const f of planRunFiles(source, notes, stats, themes, focus)) {
    const abs = join(dir, f.relPath)
    atomicWrite(abs, f.content)
    if (f.relPath.startsWith(`notes${sep}`)) notePaths.push(abs)
  }
  // The run is finished (meta.json exists): its progress log has no more use,
  // and leaving it would make the run look resumable.
  rmSync(join(dir, CHECKPOINT_FILE), { force: true })
  return { dir, notePaths }
}

/** A run's own `notes/` directory — the only place a staged read may reach. */
function notesDir(vaultRoot: string, runId: string): string {
  return join(runDir(vaultRoot, runId), 'notes')
}

/** One staged note, as the merge planner and the read-only pane see it. */
export interface StagedNote {
  /** Note name (basename without `.md`). */
  name: string
  content: string
  /** sha1 of the bytes — what `mergePlan` compares against the vault. */
  hash: string
}

/** Every note a run staged, in name order (the source book's copy included). */
export function readRunNotes(vaultRoot: string, runId: string): StagedNote[] {
  const dir = notesDir(vaultRoot, runId)
  if (!localDirectory(vaultRoot, dir)) return []
  const out: StagedNote[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue
    const bytes = readLocalFile(vaultRoot, join(dir, file))
    if (!bytes) continue
    out.push({ name: file.replace(/\.md$/i, ''), content: bytes.toString('utf8'), hash: sha1(bytes) })
  }
  return out
}

/**
 * Resolve a legacy note name or an exact note path from this run's graph.
 * The renderer supplies the selector, so require one direct child of `notes/`.
 */
export function stagedNotePath(vaultRoot: string, runId: string, note: string): string | null {
  if (typeof runId !== 'string' || !isRunId(runId) || typeof note !== 'string' || !note) return null
  const dir = notesDir(vaultRoot, runId)
  const name = basename(note)
  if (isAbsolute(note)) {
    return note === join(dir, name) && /\.md$/i.test(name) ? note : null
  }
  if (name !== note) return null
  return join(dir, `${name.replace(/\.md$/i, '')}.md`)
}

/** One staged note's text, for the read-only staged pane. */
export function readStagedNote(vaultRoot: string, runId: string, note: string): string | null {
  const abs = stagedNotePath(vaultRoot, runId, note)
  if (!abs) return null
  try {
    const actual = realpathSync(abs)
    if (!withinRoot(notesDir(realpathSync(vaultRoot), runId), actual)) return null
    return readFileSync(actual, 'utf8')
  } catch {
    return null
  }
}

/**
 * Existing run ids under the vault, sorted.
 *
 * Only directories that ARE runs: `.distill/` also holds the source store, and
 * anything else a user or a crash left there (`_tmp`, a backup copy) is not a
 * run either. The filter is the same one `assertRunId` enforces, so every id
 * this returns can be turned into a path — a caller must never be handed a name
 * that throws the moment it asks anything about it.
 */
export function listRuns(vaultRoot: string): string[] {
  const base = distillRoot(vaultRoot)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isRunId(e.name))
    .map((e) => e.name)
    .sort()
}

/** Whether `id` is a usable run id — what `assertRunId` accepts, as a test. */
export function isRunId(id: string): boolean {
  return typeof id === 'string' && RUN_ID_RE.test(id) && !id.includes('..') && !RESERVED_RUN_IDS.has(id.toLowerCase())
}

/** Delete a run's whole artifact. */
export function removeRun(vaultRoot: string, runId: string): void {
  const dir = runDir(vaultRoot, runId)
  if (!localDirectory(vaultRoot, dir)) return
  const manifest = readMergeManifest(vaultRoot, runId)
  if (manifest?.complete && manifest.figureSource) {
    const folder = join(distillRoot(vaultRoot), FIGURE_MERGES_FOLDER)
    if (!localDirectory(vaultRoot, folder, true)) throw new Error('Figure receipts are unavailable.')
    atomicWrite(join(folder, `${runId}.json`), JSON.stringify(manifest, null, 2))
  }
  rmSync(dir, { recursive: true, force: true })
}

// --- Merge into the vault (reversible) -----------------------------------
// "Merge" copies a run's notes OUT of the staged dir into a namespaced vault
// subfolder, so they become real notes the canonical index picks up. It records
// a manifest of exactly what it wrote, so "un-merge" is just deleting those.
//
// The BOOK is the exception: it is one document, not this run's opinion of it,
// so it lands once in `Sources/` and later runs of the same document share it.

/** The vault folder every distilled document lands in, whatever run brought it. */
export const SOURCES_FOLDER = 'Sources'

/** What a merge did with one file. `shared` is the converted document itself:
 *  it goes to `Sources/`, outside the run's own folder, and more than one run
 *  can point at it — so undo treats it with more care than the rest. */
export type MergeFileAction = MergeAction | 'shared'

/** One file a merge wrote: where it landed, and the bytes it landed with. */
export interface MergeFile {
  /** Vault-relative path — inside the manifest's `folder`, or in `Sources/`
   *  for the document itself. */
  path: string
  /** sha1 hex of the bytes written. Absent in manifests from before hashing —
   *  undo can't tell those apart from edited files, so it trashes them. */
  hash?: string
  /** What the plan decided about this note: `new` under its own name,
   *  `collides` — renamed to sit beside a vault note of the same name — or
   *  `shared`, the document in `Sources/`. */
  action?: MergeFileAction
  /** Whether this digest path was created by a merge or supplied by the user. */
  asset?: 'owned' | 'existing'
}

/** Record of one merge, so it can be undone cleanly. Stored beside the run. */
export interface MergeManifest {
  /** Vault-relative folder the run was merged into (e.g. `Distilled/sapiens`). */
  folder: string
  /** Every file the merge planned to write, with the hash it wrote. */
  files: MergeFile[]
  /** False while the copy is still in flight: the manifest is written BEFORE
   *  the files so a crash mid-merge is still undoable. */
  complete: boolean
  /** Staged notes the plan skipped because the vault already held them
   *  byte-for-byte. Names only, never paths: an `identical` note is the USER'S
   *  file, outside the merge folder, and undo must never be able to delete it. */
  skipped?: string[]
  /** True when THIS merge created the vault's `Sources/` folder. Undo removes
   *  that folder only then: a `Sources/` the user made and filled themselves is
   *  theirs, and an undo that happens to empty it must leave it standing. */
  createdSourcesDir?: boolean
  createdFigureDirs?: string[]
  figureSource?: { path: string; hash: string; citeOffset: number; figures: FigureRef[] }
}

/** The namespaced vault folder a run merges into (vault-relative). */
export function mergeFolder(runId: string): string {
  assertRunId(runId)
  return join('Distilled', runId)
}

/**
 * Where this run's converted document should land in `Sources/`, and whether
 * it is already there.
 *
 * The document is content-addressed, so a second run of the same book finds the
 * file the first run wrote and shares it instead of writing a copy. A DIFFERENT
 * book that happens to share a title takes the next free name — a title is not
 * an identity, and nothing of the user's is ever overwritten.
 */
export function planSourceNote(
  vaultRoot: string,
  bookName: string,
  hash: string
): { path: string; exists: boolean } {
  const dir = join(vaultRoot, SOURCES_FOLDER)
  if (lstatSync(dir, { throwIfNoEntry: false }) && !localDirectory(vaultRoot, dir)) {
    throw new Error('Sources folder is unavailable.')
  }
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${bookName}.md` : `${bookName} ${n}.md`
    const rel = join(SOURCES_FOLDER, name)
    const abs = join(dir, name)
    if (!lstatSync(abs, { throwIfNoEntry: false })) return { path: rel, exists: false }
    const bytes = readLocalFile(vaultRoot, abs)
    if (!bytes) throw new Error(`Source note cannot be read: ${rel}`)
    if (sha1(bytes) === hash) return { path: rel, exists: true }
  }
}

function manifestPath(vaultRoot: string, runId: string): string {
  return join(runDir(vaultRoot, runId), 'merge.json')
}

/** sha1 hex of some bytes — the identity undo compares a file against. */
function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

/** The content hash both sides of a merge plan speak in (see `mergePlan`). */
export function contentHash(bytes: Buffer | string): string {
  return sha1(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
}

/**
 * The merge manifest for a run, or null if it hasn't been merged.
 *
 * Undo deletes what this file names, so it is parsed as UNTRUSTED input: the
 * folder must be the one this run merges into, and every listed path must
 * resolve inside that folder — or inside `Sources/`, where the document itself
 * lands (a `..` entry would otherwise escape the vault). Anything unexpected →
 * null, i.e. "not merged", which is the safe answer. The legacy shape
 * (`files: string[]`, no `complete`) normalises to hash-less, complete entries.
 */
export function readMergeManifest(vaultRoot: string, runId: string): MergeManifest | null {
  if (!isRunId(runId)) return null
  return parseMergeManifest(vaultRoot, runId, manifestPath(vaultRoot, runId))
}

function parseMergeManifest(vaultRoot: string, runId: string, path: string): MergeManifest | null {
  const bytes = readLocalFile(vaultRoot, path)
  if (!bytes) return null
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as { folder?: unknown; files?: unknown; complete?: unknown }
  let expectedFolder: string
  try {
    expectedFolder = mergeFolder(runId)
  } catch {
    return null
  }
  if (m.folder !== expectedFolder || !Array.isArray(m.files)) return null

  const allowedBases = [expectedFolder, SOURCES_FOLDER]
  const allowedFigureDirs = allowedBases.map((base) => join(base, 'figures'))
  const legacy = m.files.every((e) => typeof e === 'string')
  const files: MergeFile[] = []
  const ACTIONS = new Set(['new', 'collides', 'identical', 'shared'])
  for (const e of m.files) {
    if (typeof e !== 'string' && (!e || typeof e !== 'object')) return null
    const entry = typeof e === 'string' ? { path: e } :
      (e as { path?: unknown; hash?: unknown; action?: unknown; asset?: unknown })
    if (typeof entry.path !== 'string' || isAbsolute(entry.path) || normalize(entry.path) !== entry.path) return null
    const parent = dirname(entry.path)
    if (entry.asset === 'owned' || entry.asset === 'existing') {
      if (!allowedFigureDirs.includes(parent) || !parseFigurePath(`figures/${basename(entry.path)}`)) return null
    } else if (!allowedBases.includes(parent) || !/\.md$/i.test(entry.path)) return null
    const action = entry.action
    files.push({
      path: entry.path,
      ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}),
      ...(typeof action === 'string' && ACTIONS.has(action)
        ? { action: action as MergeFileAction }
        : {}),
      ...(entry.asset === 'owned' || entry.asset === 'existing' ? { asset: entry.asset } : {})
    })
  }
  const { skipped, createdSourcesDir } = m as { skipped?: unknown; createdSourcesDir?: unknown }
  const rawFigureSource = (m as { figureSource?: MergeManifest['figureSource'] }).figureSource
  const figures = readFigureRefs(rawFigureSource?.figures)
  const figureSource = rawFigureSource && figures?.length && /^[0-9a-f]{40}$/.test(rawFigureSource.hash) &&
    Number.isSafeInteger(rawFigureSource.citeOffset) && rawFigureSource.citeOffset >= 0 &&
    files.some((f) => f.path === rawFigureSource.path && f.action === 'shared' && !f.asset &&
      dirname(f.path) === SOURCES_FOLDER)
    ? { path: rawFigureSource.path, hash: rawFigureSource.hash, citeOffset: rawFigureSource.citeOffset, figures }
    : null
  const rawDirs = (m as { createdFigureDirs?: unknown }).createdFigureDirs
  const createdFigureDirs = Array.isArray(rawDirs) ? rawDirs.filter((dir) => allowedFigureDirs.includes(dir)) : []
  return {
    folder: expectedFolder,
    files,
    complete: typeof m.complete === 'boolean' ? m.complete : legacy,
    ...(Array.isArray(skipped) && skipped.every((x) => typeof x === 'string')
      ? { skipped: skipped as string[] }
      : {}),
    ...(createdSourcesDir === true ? { createdSourcesDir: true } : {}),
    ...(createdFigureDirs.length ? { createdFigureDirs } : {}),
    ...(figureSource ? { figureSource } : {})
  }
}

export function archivedFigureRunIds(vaultRoot: string): string[] {
  const folder = join(distillRoot(vaultRoot), FIGURE_MERGES_FOLDER)
  if (!localDirectory(vaultRoot, folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5)).filter(isRunId)
}

export function archivedFigureMerge(vaultRoot: string, runId: string): MergeManifest | null {
  if (!isRunId(runId)) return null
  const archived = parseMergeManifest(vaultRoot, runId, join(distillRoot(vaultRoot), FIGURE_MERGES_FOLDER, `${runId}.json`))
  return archived?.complete && archived.figureSource ? archived : null
}

/** The name of the staged note that holds the converted document itself — the
 *  run says which document it is (`run.json`, else `meta.json`) and
 *  `sourceNoteName` turns that into the one name used everywhere. */
function sourceNoteNameOf(vaultRoot: string, runId: string): string | null {
  const raw = readRunJson(vaultRoot, runId)?.file ?? readRunMeta(vaultRoot, runId)?.source
  return raw ? sourceNoteName(raw) : null
}

interface FigureProjection {
  folder: string
  links: Set<string>
  shared: boolean
}

function planFigureProjection(
  vault: string, stagedNotes: string, refs: FigureRef[], projects: FigureProjection[], prior: MergeManifest[]
): { files: MergeFile[]; pending: Map<string, Buffer>; directories: string[] } {
  const files: MergeFile[] = []
  const pending = new Map<string, Buffer>()
  const directories: string[] = []
  const savedRefs = new Map(refs.map((ref) => [figurePath(ref), ref]))
  const checked = new Map<string, { bytes: Buffer; hash: string }>()
  for (const { folder, links, shared } of projects) {
    const selected = [...links].filter((link) => savedRefs.has(link))
    if (!selected.length) continue
    const relativeDirectory = join(folder, 'figures')
    const directory = join(vault, relativeDirectory)
    const hasDirectory = !!lstatSync(directory, { throwIfNoEntry: false })
    const base = join(vault, folder)
    if ((hasDirectory && !localDirectory(vault, directory)) ||
        (lstatSync(base, { throwIfNoEntry: false }) && !localDirectory(vault, base))) {
      throw new Error(`Figure folder is unavailable: ${relativeDirectory}`)
    }
    if (!hasDirectory || prior.some((receipt) => receipt.createdFigureDirs?.includes(relativeDirectory))) {
      directories.push(relativeDirectory)
    }
    for (const link of selected) {
      const ref = savedRefs.get(link)!
      const path = join(folder, link)
      const present = !!lstatSync(join(vault, path), { throwIfNoEntry: false })
      let image = checked.get(link)
      if (!image) {
        const saved = readFigureFile(vault, stagedNotes, ref)
        if (!saved) throw new Error(`Saved figure is unavailable: ${ref.label}`)
        image = { bytes: saved.bytes, hash: contentHash(saved.bytes) }
        checked.set(link, image)
      }
      if (present && !readFigureFile(vault, base, ref)) {
        throw new Error(`A different file already occupies this figure path: ${path}`)
      }
      const { hash } = image
      const owned = !present || prior.some((receipt) => receipt.files.some(
        (entry) => entry.path === path && entry.asset === 'owned' && entry.hash === hash))
      files.push({ path, hash, action: shared ? 'shared' : 'new', asset: owned ? 'owned' : 'existing' })
      if (!present) pending.set(path, image.bytes)
    }
  }
  return { files, pending, directories }
}

/**
 * Copy a run's notes into a namespaced vault subfolder and record what it wrote.
 * Filesystem only — the caller indexes the new files into the canonical index
 * (the watcher would too). Returns the manifest plus the absolute paths written.
 *
 * `plan` (from `mergePlan`) decides the NAME each note lands under, so a run
 * never writes over a note of yours that happens to share a title: a collision
 * is saved beside it as `Faction (Federalist).md`, and every `[[Faction]]` the
 * run wrote is re-pointed at the new name so the merged notes still link to each
 * other (`rewriteLinks`). A note the vault already holds byte-for-byte is
 * skipped. `opts.sameAs` holds the confirmations — the staged notes the USER
 * ticked as the same thing as their vault twin, each with the twin the dialog
 * showed (`confirmedSameAs` keeps a tick only while that is still the entry's
 * twin); each gets one `same_as:: [[Faction]]` body line — a durable,
 * human-readable, deletable decision the map then collapses. Nothing of the
 * user's is edited either way.
 *
 * With no plan every note merges under its own name (the pre-plan behaviour).
 *
 * The converted document is not one of those notes. It is the book, not this
 * run's reading of it, so it goes to `Sources/<Title>.md` — ONCE. A second run
 * of the same document finds the same bytes already there and shares them
 * (manifest action `shared`, nothing written); a different book with the same
 * title takes the next free name, and the run's `source:: [[Title]]` links are
 * re-pointed at whichever name it actually landed under.
 *
 * Crash-safe by construction: the manifest is written FIRST (every planned file
 * with the hash it will get, `complete: false`), each note is then written to a
 * dot-prefixed temp name and renamed into place (so a reader never sees half a
 * note), and only then is the manifest rewritten as complete. A crash at any
 * point leaves a manifest that names everything undo must clean up.
 */
export function mergeRun(
  vaultRoot: string,
  runId: string,
  plan?: MergePlanEntry[],
  opts: { sameAs?: SameAsConfirmation[] } = {}
): { manifest: MergeManifest; written: string[] } {
  const folder = mergeFolder(runId)
  const targetAbs = join(vaultRoot, folder)
  const previous = readMergeManifest(vaultRoot, runId)
  if (previous?.complete) return { manifest: previous, written: [] }
  const stagedDir = runDir(vaultRoot, runId)
  if (!localDirectory(vaultRoot, stagedDir)) throw new Error('Staged run is unavailable.')
  const staged = readRunNotes(vaultRoot, runId)
  const bookName = sourceNoteNameOf(vaultRoot, runId)
  const book = bookName
    ? (staged.find((n) => n.name.toLowerCase() === bookName.toLowerCase()) ?? null)
    : null

  const byName = new Map((plan ?? []).map((e) => [e.name.toLowerCase(), e]))
  const entryFor = (name: string): MergePlanEntry =>
    byName.get(name.toLowerCase()) ?? { name, action: 'new', targetName: name }

  // Every rename the plan made, so links between the run's own notes follow.
  const renames = new Map<string, string>()
  for (const note of staged) {
    if (note === book) continue
    const e = entryFor(note.name)
    if (e.action === 'collides' && e.targetName !== note.name) renames.set(note.name, e.targetName)
  }
  const confirmed = new Map(
    confirmedSameAs(plan ?? [], opts.sameAs ?? []).map((c) => [c.name.toLowerCase(), c.twin])
  )

  // The document goes to `Sources/`, once — and every `source:: [[Title]]` in
  // this run follows it to the name it actually landed under.
  const sourceNote = book ? planSourceNote(vaultRoot, book.name, book.hash) : null
  if (book && sourceNote) {
    const landed = basename(sourceNote.path).replace(/\.md$/i, '')
    if (landed !== book.name) renames.set(book.name, landed)
  }

  const planned: { path: string; bytes: Buffer; action: MergeFileAction }[] = []
  const skipped: string[] = []
  for (const note of staged) {
    if (note === book) continue
    const e = entryFor(note.name)
    if (e.action === 'identical') {
      skipped.push(note.name)
      continue
    }
    // Every place this run wrote a name that moved: the body's `[[links]]`, the
    // frontmatter `source:` the citation panel resolves, and a theme note's
    // plain-text member list.
    let content = rewriteThemeMembers(
      rewriteSourceField(rewriteLinks(note.content, renames), renames),
      renames
    )
    const twin = confirmed.get(note.name.toLowerCase())
    if (twin) content = withSameAs(content, twin)
    planned.push({
      path: join(folder, `${e.targetName}.md`),
      bytes: Buffer.from(content, 'utf8'),
      action: e.action
    })
  }

  const files: MergeFile[] = planned.map((f) => ({
    path: f.path,
    hash: sha1(f.bytes),
    action: f.action
  }))
  // Recorded whether or not it is written: undo has to know this run points at
  // that file, so it can leave it alone while another run still does too.
  if (book && sourceNote)
    files.push({ path: sourceNote.path, hash: book.hash, action: 'shared' })

  const run = readRunSource(vaultRoot, runId)
  const figureSource = run?.hash && run.figures?.length && sourceNote
    ? { path: sourceNote.path, hash: run.hash, citeOffset: renderDocumentNote(run).citeOffset, figures: run.figures }
    : undefined
  const figures = figureSource && book ? planFigureProjection(
    vaultRoot, join(stagedDir, 'notes'), figureSource.figures, [
      { folder: SOURCES_FOLDER, links: linkedFigurePaths(book.content), shared: true },
      { folder, links: linkedFigurePaths(planned.map(({ bytes }) => bytes.toString('utf8')).join('\n')), shared: false }
    ], [...otherMerges(vaultRoot, runId), ...(previous ? [previous] : [])]
  ) : undefined
  if (figures) files.push(...figures.files)

  // Whether `Sources/` is this merge's doing, decided BEFORE anything is
  // written — that is the only moment the answer is knowable, and undo needs it.
  const createdSourcesDir = !!previous?.createdSourcesDir ||
    (book !== null && sourceNote !== null && !sourceNote.exists && !existsSync(join(vaultRoot, SOURCES_FOLDER)))

  const manifest: MergeManifest = { folder, files, complete: false, skipped, createdSourcesDir,
    ...(figureSource ? { figureSource } : {}),
    ...(figures?.directories.length ? { createdFigureDirs: figures.directories } : {}) }

  const mPath = manifestPath(vaultRoot, runId)
  atomicWrite(mPath, JSON.stringify(manifest, null, 2))

  if (!localDirectory(vaultRoot, targetAbs, true)) throw new Error('Merge folder is unavailable.')
  const written: string[] = []
  const writeInto = (rel: string, bytes: Buffer): void => {
    const abs = join(vaultRoot, rel)
    if (!localDirectory(vaultRoot, dirname(abs), true)) throw new Error('Merge folder is unavailable.')
    atomicWrite(abs, bytes)
    written.push(abs)
  }
  for (const [rel, bytes] of figures?.pending ?? []) {
    const abs = join(vaultRoot, rel)
    if (!localDirectory(vaultRoot, dirname(abs), true)) throw new Error('Figure folder is unavailable.')
    // Another writer that appeared after planning must not be overwritten.
    try {
      atomicWrite(abs, bytes, true)
      rememberWrittenFigure(vaultRoot, dirname(dirname(abs)), parseFigurePath(`figures/${basename(abs)}`)!)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        const entry = manifest.files.find((f) => f.path === rel)
        if (entry) entry.asset = 'existing'
        atomicWrite(mPath, JSON.stringify(manifest, null, 2))
      }
      throw err
    }
  }
  for (const f of planned) writeInto(f.path, f.bytes)
  if (book && sourceNote && !sourceNote.exists)
    writeInto(sourceNote.path, Buffer.from(book.content, 'utf8'))

  manifest.complete = true
  atomicWrite(mPath, JSON.stringify(manifest, null, 2))
  return { manifest, written }
}

/**
 * Undo a merge: take back exactly what it wrote, then drop the now-empty folder
 * and the manifest.
 *
 * A file whose bytes still hash to what the merge wrote is deleted outright —
 * nothing of the user's is in it. A file that DIFFERS (they edited it after
 * merging), or that a pre-hash manifest can't vouch for, goes to `trash`
 * instead, so an undo can never destroy their work. Missing files are skipped.
 * `trash` is injected (main passes `shell.trashItem`) to keep this unit-testable.
 *
 * The document in `Sources/` is shared, so it survives one more test: another
 * merged run still pointing at the same file keeps it. Undoing one reading of a
 * book must not take the book away from the other. The `Sources/` FOLDER is
 * removed only when this merge created it (`createdSourcesDir`) — one the user
 * made is theirs, and an undo that empties it leaves it standing.
 */
export async function unmergeRun(
  vaultRoot: string,
  runId: string,
  trash: (absPath: string) => Promise<void>
): Promise<{ removed: string[]; trashed: string[] }> {
  const manifest = readMergeManifest(vaultRoot, runId)
  if (!manifest) return { removed: [], trashed: [] }
  const stillWanted = pathsOtherRunsMerged(vaultRoot, runId)
  const removed: string[] = []
  const trashed: string[] = []
  const retainedLinks = new Map<string, Set<string>>()
  const entries = [...manifest.files.filter((entry) => !entry.asset), ...manifest.files.filter((entry) => entry.asset)]
  for (const entry of entries) {
    if (entry.asset === 'existing' || (entry.action === 'shared' && stillWanted.has(entry.path))) continue
    const abs = join(vaultRoot, entry.path)
    if (entry.asset) {
      const noteDir = dirname(dirname(abs))
      if (!retainedLinks.has(noteDir)) retainedLinks.set(noteDir, siblingFigureLinks(vaultRoot, noteDir))
      if (retainedLinks.get(noteDir)?.has(`figures/${basename(abs)}`)) continue
    }
    const bytes = readLocalFile(vaultRoot, abs)
    if (!bytes) continue // already gone or no longer a local file
    if (entry.hash && sha1(bytes) === entry.hash) {
      rmSync(abs, { force: true })
      removed.push(abs)
    } else {
      // Edited (or unverifiable): recoverable move only, never an rm.
      await trash(abs)
      trashed.push(abs)
    }
  }
  // The run's own folder is always the merge's doing, so an empty one goes.
  // `Sources/` only goes if THIS merge made it: a folder the user created is
  // theirs, empty or not.
  const folders = [
    ...(manifest.createdFigureDirs ?? []), manifest.folder,
    ...(manifest.createdSourcesDir ? [SOURCES_FOLDER] : [])
  ]
  for (const folder of folders) {
    const abs = join(vaultRoot, folder)
    try {
      if (localDirectory(vaultRoot, abs)) rmdirSync(abs)
    } catch {
      /* not there, or not empty — leave it */
    }
  }
  rmSync(manifestPath(vaultRoot, runId), { force: true })
  return { removed, trashed }
}

function siblingFigureLinks(vault: string, directory: string): Set<string> {
  const links = new Set<string>()
  if (!localDirectory(vault, directory)) return links
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || !/\.md$/i.test(entry.name)) continue
    const text = readLocalFile(vault, join(directory, entry.name))?.toString('utf8')
    if (text) for (const link of linkedFigurePaths(text)) links.add(link)
  }
  return links
}

/** Vault-relative paths that OTHER merged runs still list in their manifests —
 *  what an undo of `runId` must leave alone. */
function pathsOtherRunsMerged(vaultRoot: string, runId: string): Set<string> {
  return new Set(otherMerges(vaultRoot, runId).flatMap((manifest) => manifest.files.map((f) => f.path)))
}

function otherMerges(vaultRoot: string, runId: string): MergeManifest[] {
  const manifests: MergeManifest[] = []
  for (const id of listRuns(vaultRoot)) {
    if (id === runId) continue
    const manifest = readMergeManifest(vaultRoot, id)
    if (manifest) manifests.push(manifest)
  }
  for (const id of archivedFigureRunIds(vaultRoot)) {
    const manifest = archivedFigureMerge(vaultRoot, id)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}
