export interface ReadingCopy {
  encoding: string
  text: string
}

/** A damaged source's status in a staged reader, separate from citation text. */
export type StagedReading =
  | { kind: 'source'; copy: ReadingCopy | null }
  | { kind: 'historical-note' }

export interface ReadingCopyPreview {
  id: string
  encoding?: string
  preview?: string
  uncertain?: boolean
  error?: string
}
