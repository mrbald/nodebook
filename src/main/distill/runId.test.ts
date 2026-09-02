import { describe, it, expect } from 'vitest'
import { distillRunId, uniqueRunId } from './runId'
import { assertRunId, RESERVED_RUN_IDS } from './artifact'

describe('distillRunId', () => {
  it('is the basename, sanitized into one safe path segment', () => {
    expect(distillRunId('/books/On Government.pdf')).toBe('On Government')
    expect(distillRunId('/books/Есть/чай.md')).toBe('run') // nothing safe left
    expect(distillRunId('/books/…leading punctuation.epub')).toBe('leading punctuation')
    expect(distillRunId('/books/a/b/c.txt')).toBe('c')
  })
})

describe('uniqueRunId', () => {
  it('takes the name when it is free, and the next number when it is not', () => {
    expect(uniqueRunId('book', [])).toBe('book')
    expect(uniqueRunId('book', ['book'])).toBe('book-2')
    expect(uniqueRunId('book', ['book', 'book-2'])).toBe('book-3')
  })

  it('de-collides case-insensitively, like the id check itself', () => {
    // The reserved names are compared lowercased by `assertRunId`, so a
    // document called `Sources.pdf` must not be handed the id `Sources`: it
    // passes here and then throws on the first write.
    const id = uniqueRunId('Sources', RESERVED_RUN_IDS)
    expect(id).toBe('Sources-2')
    expect(() => assertRunId(id)).not.toThrow()
    // Same for a run already staged under a different case.
    expect(uniqueRunId('Book', ['book'])).toBe('Book-2')
  })

  it('never returns an id the run layout would refuse', () => {
    const taken = [...RESERVED_RUN_IDS, 'sources-2', 'SOURCES-3']
    const id = uniqueRunId(distillRunId('/books/Sources.pdf'), taken)
    expect(id).toBe('Sources-4')
    expect(() => assertRunId(id)).not.toThrow()
  })
})
