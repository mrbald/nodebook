import { matchesFigure, type FigureSearchHit } from '../shared/figureSearch'
import { resolveNoteFigures, resolveNoteFigureBytes } from './distill/noteFigures'

/** Serve only a managed image belonging to a known note in the currently open vault. */
export function handleFigureRequest(request: Request, vault: string | null): Response {
  const url = new URL(request.url)
  const id = url.pathname.slice(1)
  const note = url.searchParams.get('note')
  if (!vault || request.method !== 'GET' || url.host !== 'asset' || !note || !/^[a-f0-9]{64}$/.test(id)) {
    return new Response(null, { status: 404 })
  }
  const figure = resolveNoteFigureBytes(vault, note, id, url.searchParams.get('run') ?? undefined)
  if (!figure) return new Response(null, { status: 404 })
  return new Response(figure.bytes, {
    headers: { 'Content-Type': figure.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  })
}


export async function searchFigureSources(vault: string, paths: string[], query: string): Promise<FigureSearchHit[]> {
  const hits: FigureSearchHit[] = []
  for (const path of paths) {
    for (const figure of await resolveNoteFigures(vault, path)) {
      if (matchesFigure(figure, query)) hits.push({ path, figure })
      if (hits.length === 20) return hits
    }
  }
  return hits
}
