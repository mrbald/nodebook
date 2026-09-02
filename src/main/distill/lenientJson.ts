/**
 * Reading a model's JSON reply when it is almost JSON.
 *
 * Over a 171-window book, four replies (2 %) failed `JSON.parse`, every one
 * with the same slip: a summary quoting Python with double-quoted literals —
 * `tips.groupby(["day", "smoker"])` — written into a JSON string without
 * escaping the quotes. Each cost a second model call to repair, at the price
 * of a whole window's prompt. The slip is mechanical, so it is mended here
 * first; the repair call stays for what a machine cannot mend.
 *
 * The one rule: inside a string, a quote CLOSES the string only when what
 * follows it fits the grammar at that depth. After a key, a colon. After a
 * value in an object, a comma and then another key (a quoted string followed
 * by a colon), or the closing brace. After an element in an array, a comma and
 * then another element, or the closing bracket. And a closing brace or bracket
 * must itself be followed by what its parent expects. Any other quote is text,
 * and is escaped. So `["day", "smoker"])` reads correctly: the quote after
 * `day` is followed by a comma and `"smoker"` — but `"smoker"` is followed by
 * `]`, not a colon, so it is no key, so that comma did not end the value.
 *
 * One more rule, because the lookahead is shallow: after a comma, the member
 * that follows must be one the reply's schema knows (`keys`) — or, for a key
 * the schema does not know (a model padding the reply with `confidence`), a
 * well-formed value must follow it and the member list must then go on to a
 * known member or close properly. Without this, prose quoting a dict literal
 * — `pass {"name":"x","age": 5} to it` — closes the field at `x`, and when the
 * rest happens to be valid JSON the whole reply parses clean with the field
 * truncated and a made-up key (found in review, 2026-09-02). Text that still
 * mimics the grammar, key names included, makes the mended text fail strict
 * parsing, which is the outcome before this module existed — a repair call —
 * never a silently wrong parse. Strict `JSON.parse` is always tried first;
 * valid JSON is never touched. Pure and dependency-free.
 */

/** The outermost `{...}` of a reply, or null. Models wrap JSON in prose and
 *  ```json fences; the object is what is in between. */
export function outerObject(raw: string): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start < 0 || end <= start ? null : raw.slice(start, end + 1)
}

/**
 * Parse the outermost object of `raw`: strictly first, then with stray quotes
 * escaped. `keys` is every key the reply's schema uses, at any depth — the
 * only names a comma may introduce. `undefined` when neither reads — the
 * caller's cue for a repair call.
 */
export function parseLenientObject(raw: string, keys: ReadonlySet<string>): unknown {
  const text = outerObject(raw)
  if (text === null) return undefined
  try {
    return JSON.parse(text)
  } catch {
    /* not strict JSON — try mending it */
  }
  const mended = escapeStrayQuotes(text, keys)
  if (mended === text) return undefined
  try {
    return JSON.parse(mended)
  } catch {
    return undefined
  }
}

type Frame = { kind: 'object' | 'array'; expectKey: boolean }
type Role = 'key' | 'value' | 'element' | 'bare'

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Index just past the closing quote of the plain string starting at `open`
 *  (the quote itself), or -1. "Plain" = a key, which never holds a quote. */
function endOfKey(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i + 1
  }
  return -1
}

/** Could a value start here? */
function startsValue(c: string | undefined): boolean {
  return c !== undefined && /["{[\-\dtfn]/.test(c)
}

/** Index just past the unescaped quote that ends the string opened at `i`. */
function endOfString(text: string, i: number): number {
  for (let k = i + 1; k < text.length; k++) {
    if (text[k] === '\\') k++
    else if (text[k] === '"') return k + 1
  }
  return -1
}

/** Index just past a CLEAN JSON value starting at `i`, or -1. A string ends
 *  at its first quote, and that quote must be followed by a separator — a
 *  value with a stray quote inside is not clean, so an unknown "member"
 *  whose value reads that way is prose, not a member. A bracket is balanced
 *  by count, its strings skipped the same way. Lookahead, not parsing: a
 *  wrong guess makes the mended text fail strict parsing, never parse wrong. */
function skipValue(text: string, i: number): number {
  const c = text[i]
  if (c === '"') {
    const end = endOfString(text, i)
    return end > 0 && /[,}\]]/.test(text[skipWs(text, end)] ?? '') ? end : -1
  }
  if (c === '{' || c === '[') {
    let depth = 0
    for (let k = i; k < text.length; k++) {
      const ch = text[k]
      if (ch === '"') {
        const end = endOfString(text, k)
        if (end < 0) return -1
        k = end - 1
      } else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return k + 1
      }
    }
    return -1
  }
  const m = /^(?:-?\d[\d.eE+-]*|true|false|null)/.exec(text.slice(i, i + 32))
  return m ? i + m[0].length : -1
}

/** Longest run of unknown members the lookahead follows before giving up. */
const MEMBER_LOOKAHEAD = 16

/**
 * Does a member start at `i`: `"<key>"` then a colon? A key the schema knows
 * is enough. An unknown key counts only when a well-formed value follows it
 * and the member list then continues with another member (checked the same
 * way) or closes with a brace that is itself followed by a separator or the
 * end. A dict literal quoted in prose fails that: its brace is followed by
 * more prose.
 */
function memberFollows(text: string, i: number, keys: ReadonlySet<string>, depth = 0): boolean {
  const q = skipWs(text, i)
  if (text[q] !== '"') return false
  const after = endOfKey(text, q)
  if (after < 0) return false
  const colon = skipWs(text, after)
  if (text[colon] !== ':') return false
  if (keys.has(text.slice(q + 1, after - 1))) return true
  if (depth >= MEMBER_LOOKAHEAD) return false
  const end = skipValue(text, skipWs(text, colon + 1))
  if (end < 0) return false
  const next = skipWs(text, end)
  if (text[next] === ',') return memberFollows(text, next + 1, keys, depth + 1)
  if (text[next] !== '}') return false
  const beyond = text[skipWs(text, next + 1)]
  return beyond === undefined || beyond === ',' || beyond === ']' || beyond === '}'
}

/** After a container closed at `i`, is what follows what its parent expects? */
function parentAccepts(text: string, i: number, parent: Frame | undefined, keys: ReadonlySet<string>): boolean {
  const k = skipWs(text, i)
  if (!parent) return k >= text.length // the outermost object ends the text
  const c = text[k]
  if (parent.kind === 'array') return c === ',' || c === ']'
  return (c === ',' && memberFollows(text, k + 1, keys)) || c === '}'
}

/** Does the quote at `i` close a string of this `role`, given what follows it? */
function closes(text: string, i: number, role: Role, stack: Frame[], keys: ReadonlySet<string>): boolean {
  const k = skipWs(text, i + 1)
  const c = text[k]
  switch (role) {
    case 'bare':
      return true
    case 'key':
      return c === ':'
    case 'value': {
      if (c === '}') return parentAccepts(text, k + 1, stack[stack.length - 2], keys)
      return c === ',' && memberFollows(text, k + 1, keys)
    }
    case 'element': {
      if (c === ']') return parentAccepts(text, k + 1, stack[stack.length - 2], keys)
      return c === ',' && startsValue(text[skipWs(text, k + 1)])
    }
  }
}

/**
 * `text` with every quote that cannot be a closing quote escaped. Returns the
 * input itself (same reference) when nothing needed escaping, so a caller can
 * tell "mended" from "was fine".
 */
export function escapeStrayQuotes(text: string, keys: ReadonlySet<string>): string {
  const out: string[] = []
  const stack: Frame[] = []
  let inString = false
  let role: Role = 'bare'
  let changed = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') {
        out.push(c, text[i + 1] ?? '')
        i++
      } else if (c === '"') {
        if (closes(text, i, role, stack, keys)) {
          inString = false
          out.push(c)
        } else {
          out.push('\\"')
          changed = true
        }
      } else out.push(c)
      continue
    }
    switch (c) {
      case '{':
        stack.push({ kind: 'object', expectKey: true })
        break
      case '[':
        stack.push({ kind: 'array', expectKey: false })
        break
      case '}':
      case ']':
        stack.pop()
        break
      case ':': {
        const top = stack[stack.length - 1]
        if (top?.kind === 'object') top.expectKey = false
        break
      }
      case ',': {
        const top = stack[stack.length - 1]
        if (top?.kind === 'object') top.expectKey = true
        break
      }
      case '"': {
        const top = stack[stack.length - 1]
        role = !top ? 'bare' : top.kind === 'array' ? 'element' : top.expectKey ? 'key' : 'value'
        inString = true
        break
      }
    }
    out.push(c)
  }
  return changed ? out.join('') : text
}
