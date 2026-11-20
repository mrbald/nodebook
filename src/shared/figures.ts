export type FigureExtension = 'png' | 'jpg' | 'gif' | 'webp'

export interface FigureRef {
  id: string
  ext: FigureExtension
  label: string
  location: string
  caption?: string
  ocr?: string
}

export interface CapturedFigure extends FigureRef {
  bytes: Uint8Array
}

export interface FigureAnalysis {
  text: string
  provider: string
  model: string
  createdAt: string
}

export interface FigureAnalysisStatus {
  analysis: FigureAnalysis | null
  available: boolean
  providerLabel?: string
  reason?: string
}

export type FigureContext = Pick<FigureRef, 'label' | 'location' | 'caption'>

export interface FigureCoverage {
  skipped: number
  uninspectedPages?: number
}

export function figurePath(ref: Pick<FigureRef, 'id' | 'ext'>): string {
  return `figures/${ref.id}.${ref.ext}`
}

export function parseFigurePath(path: string): Pick<FigureRef, 'id' | 'ext'> | null {
  const match = /^(?:\.\/)?figures\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/.exec(path)
  return match ? { id: match[1], ext: match[2] as FigureExtension } : null
}

export function figureMarkdown(ref: FigureRef): string {
  const alt = ref.label.replace(/\s+/g, ' ').replace(/[\\[\]!`*_<>|]/g, '\\$&')
  return `![${alt}](${figurePath(ref)})`
}
