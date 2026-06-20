import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { wikilinkComplete } from './wikilinkComplete'

const NAMES = ['Graph Model', 'Roadmap', 'welcome']
const source = wikilinkComplete(() => NAMES)

function contextAt(doc: string, pos = doc.length, explicit = false): CompletionContext {
  const state = EditorState.create({ doc })
  return new CompletionContext(state, pos, explicit)
}

describe('wikilinkComplete', () => {
  it('offers every note right after `[[`', () => {
    const result = source(contextAt('See also [['))
    expect(result).not.toBeNull()
    expect(result!.options.map((o) => o.label)).toEqual(NAMES)
    expect(result!.from).toBe('See also [['.length) // anchored just after `[[`
  })

  it('anchors to the LAST `[[` when a line has an earlier one (regression)', () => {
    // The old greedy regex matched from the first `[[`, capturing the whole
    // tail as the query so the popup came up empty.
    const doc = 'Type [[ anywhere, then [['
    const result = source(contextAt(doc))
    expect(result).not.toBeNull()
    expect(result!.from).toBe(doc.length)
  })

  it('returns null when the cursor is not inside an open `[[`', () => {
    expect(source(contextAt('no brackets here'))).toBeNull()
    expect(source(contextAt('single [ bracket'))).toBeNull()
  })

  it('keeps the query region after a partially typed name', () => {
    const doc = 'x [[Gra'
    const result = source(contextAt(doc))
    expect(result!.from).toBe('x [['.length)
  })

  it('closes the link on accept', () => {
    const result = source(contextAt('x [['))
    const opt = result!.options.find((o) => o.label === 'Roadmap')!
    expect(opt.apply).toBe('Roadmap]]')
  })
})
