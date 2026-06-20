import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

/**
 * `[[` autocomplete. Sourced from a callback so the option list can change
 * without rebuilding the editor — today it's the in-memory vault file list;
 * in step 4 the same callback reads from the SQLite index instead.
 */
export function wikilinkComplete(getNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match the most recent open `[[` up to the cursor. The capture excludes
    // `[` as well as `]` so a line with an earlier `[[...]]` (or literal `[[`)
    // anchors to the LAST `[[` rather than greedily swallowing the whole tail.
    // Fires as soon as `[[` is typed — showing the note list immediately feels best.
    const before = context.matchBefore(/\[\[([^[\]\n]*)$/)
    if (!before) return null

    const from = before.from + 2 // start of the typed name, after `[[`
    const options = getNames().map((name) => ({
      label: name,
      type: 'class',
      apply: `${name}]]` // close the link on accept
    }))

    return {
      from,
      options,
      validFor: /^[^[\]\n]*$/
    }
  }
}
