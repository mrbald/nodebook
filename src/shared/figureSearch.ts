import type { FigureRef } from './figures'

export interface FigureSearchHit {
  path: string
  figure: FigureRef
}

export function matchesFigure(figure: FigureRef, query: string): boolean {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const evidence = [figure.label, figure.location, figure.caption, figure.ocr].join(' ').toLocaleLowerCase()
  return words.every((word) => evidence.includes(word))
}
