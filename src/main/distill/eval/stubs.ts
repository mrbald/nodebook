/**
 * Deterministic stand-ins for the two impure `distill()` dependencies — an
 * embedder and a chat model — so the eval harness (`scripts/distill-eval.test.ts`)
 * can run the real pipeline end to end with no network, no key, and a byte-
 * identical result every run. Pure functions of their text input; no RNG, no
 * clock, no I/O.
 *
 * `hashEmbedder` stands in for the renderer's WASM embedder: a classic
 * feature-hashing bag-of-words (Weinberger et al. 2009) that clusters real
 * prose on topic well enough for `kmeans` to form sensible themes, without a
 * model.
 *
 * `heuristicChat` stands in for the LLM extraction call: it parses the exact
 * `[chunk N — heading]` prompt `buildExtractionPrompt` (`../extract.ts`)
 * produces and returns valid `parseExtraction` JSON built only from words
 * that are actually in the chunk — so grounding never drops a stubbed item
 * for inventing a quote.
 */

import type { ItemKind } from '../extract'
import type { ChatModel, ChatRequest } from '../../rag/provider'

// --- hashEmbedder ------------------------------------------------------

/** FNV-1a, 32-bit. Cheap, well-distributed, deterministic. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Lowercased word tokens — Unicode-aware so Cyrillic (chapter-ru.md) tokenizes
 *  as real words too, not just ASCII runs. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** One text's hashed bag-of-words vector: each token hashes into a bucket
 *  (`h % dims`) with a sign from a high bit of the same hash (kept separate
 *  from the low bits the modulo uses, so bucket and sign don't correlate for
 *  power-of-two `dims`), then L2-normalized — the standard hashing trick. */
function hashVector(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims)
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok)
    const bucket = h % dims
    const sign = h & 0x80000000 ? -1 : 1
    vec[bucket] += sign
  }
  let normSq = 0
  for (let i = 0; i < dims; i++) normSq += vec[i] * vec[i]
  const norm = Math.sqrt(normSq)
  if (norm > 0) for (let i = 0; i < dims; i++) vec[i] /= norm
  return vec
}

export interface HashEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>
}

/** Deterministic feature-hashing embedder — a drop-in for `DistillEmbedder`
 *  (`../run.ts`) with no model. `dims` should match what `kmeans` is fed;
 *  64 is plenty for a few hundred chunks. */
export function hashEmbedder(dims = 64): HashEmbedder {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => hashVector(t, dims))
    }
  }
}

// --- heuristicChat -------------------------------------------------------

// `\b` is ASCII-only in JS regex even with the `u` flag — it silently fails
// to match at a space-before-Cyrillic (or any non-ASCII-letter) boundary, so
// the word edges are spelled out with lookaround against any Unicode letter
// or digit instead. This matters here: chapter-ru.md is Russian prose.
const CAP_WORD = /(?<![\p{L}\p{N}])\p{Lu}[\p{Ll}'-]+(?![\p{L}\p{N}])/gu

/** Up to `max` distinct title candidates for a chunk: capitalized bigrams
 *  seen ≥ 2 times first (more specific — "New York" over "New"), then
 *  capitalized unigrams, both ranked by frequency (ties broken
 *  lexicographically for determinism). Falls back to the chunk's first three
 *  words when it has no capitalized words at all (e.g. an all-lowercase
 *  translation artifact). */
function topTitles(text: string, max = 3): string[] {
  const words = text.match(CAP_WORD) ?? []
  if (words.length === 0) {
    const fallback = text.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
    return fallback ? [fallback] : []
  }

  const uni = new Map<string, number>()
  for (const w of words) uni.set(w, (uni.get(w) ?? 0) + 1)

  const bigramRe = new RegExp(`(${CAP_WORD.source})\\s(${CAP_WORD.source})`, 'gu')
  const bi = new Map<string, number>()
  let m: RegExpExecArray | null
  while ((m = bigramRe.exec(text))) {
    const key = `${m[1]} ${m[2]}`
    bi.set(key, (bi.get(key) ?? 0) + 1)
  }

  const candidates: { name: string; count: number; bigram: boolean }[] = []
  for (const [name, count] of bi) if (count >= 2) candidates.push({ name, count, bigram: true })
  for (const [name, count] of uni) candidates.push({ name, count, bigram: false })
  candidates.sort((a, b) => b.count - a.count || Number(b.bigram) - Number(a.bigram) || a.name.localeCompare(b.name))

  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c.name)
    if (out.length >= max) break
  }
  return out
}

/** Verbatim sentences of `text` (Latin/Cyrillic terminal punctuation), each an
 *  exact substring of `text` so it always survives `groundItems`' quote
 *  location. Falls back to the whole trimmed text as one "sentence" when no
 *  terminal punctuation is found (e.g. a heading-only chunk). */
function sentences(text: string): string[] {
  const RE = /[^.!?…]+[.!?…]+(?=[\s)\]"']|$)/gu
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = RE.exec(text))) {
    const s = m[0].trim()
    if (s) out.push(s)
  }
  if (out.length === 0 && text.trim()) out.push(text.trim())
  return out
}

/** concept for a proper-name-shaped (multi-word capitalized) title, entity
 *  when a lone capitalized word looks like a name and the sentence names a
 *  thing without asserting anything about it, else claim — a placeholder
 *  rule, not real NLP, but a real (if coarse) three-way split. */
function guessKind(title: string, sentence: string): ItemKind {
  if (/\s/.test(title)) return 'entity'
  if (/\b(is|are|was|were|means|refers)\b/iu.test(sentence)) return 'concept'
  return 'claim'
}

interface ChunkBlock {
  chunkId: number
  heading: string
  text: string
}

/** Recover the chunk blocks `buildExtractionPrompt` (../extract.ts) wrote —
 *  `[chunk N — heading]\n<text>` — by finding each marker's position and
 *  slicing up to the next one (or the string's end). Robust to the chunk's
 *  own text containing blank lines, since it never depends on a blank-line
 *  separator, only on where the next real marker starts. */
function splitChunkBlocks(prompt: string): ChunkBlock[] {
  const marker = /\[chunk (\d+)(?: — ([^\]]*))?\]\n/g
  const hits: { chunkId: number; heading: string; index: number; bodyStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = marker.exec(prompt))) {
    hits.push({ chunkId: Number(m[1]), heading: m[2] ?? '', index: m.index, bodyStart: marker.lastIndex })
  }
  return hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : prompt.length
    return { chunkId: h.chunkId, heading: h.heading, text: prompt.slice(h.bodyStart, end).trim() }
  })
}

interface StubItem {
  kind: ItemKind
  title: string
  summary: string
  evidence: { chunkId: number; quote: string }[]
  links: { relation: string; target: string }[]
}

/** 1-3 items for one chunk: title from `topTitles`, summary = the chunk's
 *  first sentence, one verbatim evidence quote per item (cycling through the
 *  chunk's sentences so items in the same chunk don't all cite the same
 *  line). Links are filled in afterwards, across the whole call. */
function itemsForChunk(chunk: ChunkBlock): Omit<StubItem, 'links'>[] {
  const titles = topTitles(chunk.text)
  if (titles.length === 0) return []
  const sents = sentences(chunk.text)
  const firstSentence = sents[0] ?? chunk.text.trim()
  return titles.map((title, i) => {
    const quote = sents.length ? sents[i % sents.length] : chunk.text.trim()
    return {
      kind: guessKind(title, firstSentence),
      title,
      summary: firstSentence,
      evidence: quote ? [{ chunkId: chunk.chunkId, quote }] : []
    }
  })
}

/** Chain-link every item produced in this call to the previous one — gives
 *  the stub's output a real (if arbitrary) cross-item graph to exercise
 *  dedup/emit/metrics on, alternating relation so it isn't monotone. */
function linkItems(items: Omit<StubItem, 'links'>[]): StubItem[] {
  return items.map((item, i) => ({
    ...item,
    links: i === 0 ? [] : [{ relation: i % 2 === 0 ? 'part_of' : 'about', target: items[i - 1].title }]
  }))
}

function extractionReply(prompt: string): string {
  const blocks = splitChunkBlocks(prompt)
  const items = linkItems(blocks.flatMap(itemsForChunk))
  return JSON.stringify({ items })
}

/** A `ChatModel` that answers a distill extraction call deterministically
 *  from the prompt's own `[chunk N — heading]` text — see the module header.
 *  Reads only `messages[0]` (the original user prompt): a repair retry
 *  (`run.ts`'s `extractCluster`) resends it unchanged as `messages[0]` and
 *  appends the model's bad first reply plus a follow-up as later messages —
 *  reading the whole joined transcript would let that assistant/follow-up
 *  text bleed into the last chunk's captured span (no later `[chunk …]`
 *  marker bounds it). So a repair call finds the same chunk blocks and
 *  returns the same JSON — never a different, "fixed" answer, since there
 *  was nothing to fix. Never streams garbage: valid JSON is generated
 *  directly. */
export function heuristicChat(): ChatModel {
  return {
    id: 'heuristic-stub',
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const prompt = req.messages[0]?.content ?? ''
      yield extractionReply(prompt)
    }
  }
}
