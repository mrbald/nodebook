import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { type GraphRows } from './graph'
import { harvest } from './harvest'
import { projectVaultThemes } from './vaultThemes'

const root = resolve('theme-test-vault')

function rows(content: Record<string, string>): GraphRows {
  const files: GraphRows['files'] = []
  const triples: GraphRows['triples'] = []
  for (const [name, markdown] of Object.entries(content)) {
    const path = join(root, `${name}.md`)
    const note = harvest(path, markdown)
    files.push({ path, title: note.title, kind: note.kind })
    triples.push(...note.triples.map((triple) => ({ ...triple, source_file: path })))
  }
  return { files, triples }
}

function vectors(entries: [string, number[]][]): Map<string, Float32Array> {
  return new Map(entries.map(([name, vector]) => [join(root, `${name}.md`), Float32Array.from(vector)]))
}

describe('whole-vault Themes', () => {
  it('uses full index link evidence offline and keeps all other canonical notes reachable', () => {
    const graph = rows({
      Alpha: '# Alpha representative\n\n[[Beta]] and [[Gamma]]',
      Beta: '# Beta example\n\n[[Gamma]]',
      Gamma: '# Gamma example\n\n[[Alpha]]',
      Alternate: '# Alpha alias\n\nsame_as:: [[Alpha]]',
      '.distill/run/Hidden': '# Staged-only note\n\n[[Alpha]]',
      'Saved view.map': '# Saved map\n\n[[Gamma]]',
      ...Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`Unmatched ${i}`, `# Other note ${i}`]))
    })
    const result = projectVaultThemes(root, graph, new Map())
    expect(result).toMatchObject({ noteCount: 213, embeddedCount: 0 })
    expect(result.themes).toHaveLength(1)
    expect(result.themes[0]).toMatchObject({
      label: 'Alpha representative',
      examples: ['Gamma example', 'Beta example']
    })
    expect(result.themes[0].notes.map(({ title }) => title)).toEqual([
      'Alpha representative', 'Beta example', 'Gamma example'
    ])
    expect(result.unmatched).toHaveLength(210)
    expect(result.unmatched).toContainEqual({
      path: join(root, 'Unmatched 209.md'), title: 'Other note 209', relativePath: 'Unmatched 209.md'
    })
    expect(projectVaultThemes(root, { files: [...graph.files].reverse(), triples: [...graph.triples].reverse() }, new Map()))
      .toEqual(result)
  })

  it('uses current vectors and links together while preserving notes with no coverage', () => {
    const result = projectVaultThemes(root, rows({
      Alder: '# Alder leaf\n\n[[Ash]]', Ash: '# Ash leaf', Birch: '# Birch leaf',
      Oak: '# Oak leaf\n\ncompares:: [[Alder]]',
      Flight: '# Flight', Cabin: '# Cabin', Engine: '# Engine',
      Leftover: '# Leftover'
    }), vectors([
      ['Alder', [1, 0]], ['Ash', [1, 0]], ['Birch', [1, 0]],
      ['Flight', [0, 1]], ['Cabin', [0, 1]], ['Engine', [0, 1]]
    ]))
    expect(result.embeddedCount).toBe(6)
    expect(result.themes.map(({ notes }) => notes.map(({ title }) => title))).toEqual([
      ['Alder leaf', 'Ash leaf', 'Birch leaf', 'Oak leaf'], ['Cabin', 'Engine', 'Flight']
    ])
    expect(result.unmatched.map(({ title }) => title)).toEqual(['Leftover'])
  })

  it('leaves a tiny vault, uniform vectors and provenance around a book without themes', () => {
    const small = rows({ A: '[[B]] [[C]]', B: '[[A]] [[C]]', C: '[[A]] [[B]]' })
    expect(projectVaultThemes(root, small, new Map()).themes).toEqual([])

    const content = {
      Book: '---\nkind: document\n---\n\n# The document',
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
        `Note ${i}`, `# Note ${i}\n\nsource:: [[Book]]\n\n[[Note ${i + 1}]]`
      ]))
    }
    const result = projectVaultThemes(root, rows(content), vectors(
      Object.keys(content).map((name) => [name, [1, 0]])
    ))
    expect(result.themes).toEqual([])
    expect(result.unmatched).toHaveLength(13)
  })

  it('uses unambiguous path links and never treats ambiguous names as identity or affinity', () => {
    const content = {
      'Left/Twin': '# Left copy', 'Right/Twin': '# Right copy',
      Crown: 'supports:: [[Twin]]\n\n[[Leaf]]', Leaf: '[[Crown]]\n\n[[Twin]]',
      Alias: 'same_as:: [[Twin]]', Extra: '', Spare: ''
    }
    const ambiguous = projectVaultThemes(root, rows(content), new Map())
    expect(ambiguous.themes).toEqual([])
    expect(ambiguous.noteCount).toBe(7)
    const confirmed = projectVaultThemes(root, rows({
      ...content, Crown: 'supports:: [[Left/Twin]]\n\n[[Leaf]]'
    }), new Map())
    expect(confirmed.themes[0]?.notes.map(({ title }) => title)).toEqual(['Crown', 'Leaf', 'Left copy'])
  })

  it('retains coverage of every note above the exact semantic comparison limit', () => {
    const entries: [string, number[]][] = Array.from({ length: 180 }, (_, i) => [
      `Topic ${i % 3} note ${i}`, [Number(i % 3 === 0), Number(i % 3 === 1), Number(i % 3 === 2)]
    ])
    const graph = rows(Object.fromEntries(entries.map(([name]) => [name, `# ${name}`])))
    const result = projectVaultThemes(root, graph, vectors(entries))
    expect(result.embeddedCount).toBe(180)
    expect(result.themes.length).toBeGreaterThanOrEqual(3)
    expect(new Set([...result.unmatched, ...result.themes.flatMap(({ notes }) => notes)].map(({ path }) => path)).size)
      .toBe(180)
    for (const { notes } of result.themes) {
      expect(new Set(notes.map(({ title }) => title.slice(0, 7))).size).toBe(1)
    }
  })
})
