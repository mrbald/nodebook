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
 * The lookahead is shallow on purpose. Text that mimics the grammar closely
 * enough to fool it makes the mended text fail strict parsing, which is the
 * same outcome as before this module — a repair call — never a silently wrong
 * parse. Strict `JSON.parse` is always tried first; valid JSON is never touched.
 * Pure and dependency-free.
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
 * escaped. `undefined` when neither reads — the caller's cue for a repair call.
 */
export function parseLenientObject(raw: string): unknown {
  const text = outerObject(raw)
  if (text === null) return undefined
  try {
    return JSON.parse(text)
  } catch {
    /* not strict JSON — try mending it */
  }
  const mended = escapeStrayQuotes(text)
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

/** After a container closed at `i`, is what follows what its parent expects? */
function parentAccepts(text: string, i: number, parent: Frame | undefined): boolean {
  const k = skipWs(text, i)
  if (!parent) return k >= text.length // the outermost object ends the text
  const c = text[k]
  if (parent.kind === 'array') return c === ',' || c === ']'
  return (c === ',' && text[skipWs(text, k + 1)] === '"') || c === '}'
}

/** Does the quote at `i` close a string of this `role`, given what follows it? */
function closes(text: string, i: number, role: Role, stack: Frame[]): boolean {
  const k = skipWs(text, i + 1)
  const c = text[k]
  switch (role) {
    case 'bare':
      return true
    case 'key':
      return c === ':'
    case 'value': {
      if (c === '}') return parentAccepts(text, k + 1, stack[stack.length - 2])
      if (c !== ',') return false
      const q = skipWs(text, k + 1)
      if (text[q] !== '"') return false
      const after = endOfKey(text, q)
      return after > 0 && text[skipWs(text, after)] === ':'
    }
    case 'element': {
      if (c === ']') return parentAccepts(text, k + 1, stack[stack.length - 2])
      return c === ',' && startsValue(text[skipWs(text, k + 1)])
    }
  }
}

/**
 * `text` with every quote that cannot be a closing quote escaped. Returns the
 * input itself (same reference) when nothing needed escaping, so a caller can
 * tell "mended" from "was fine".
 */
export function escapeStrayQuotes(text: string): string {
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
        if (closes(text, i, role, stack)) {
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
