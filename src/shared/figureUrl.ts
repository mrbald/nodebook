export function figureUrl(path: string, id: string, runId?: string): string {
  const url = new URL(`nodebook-figure://asset/${id}`)
  url.searchParams.set('note', path)
  if (runId) url.searchParams.set('run', runId)
  return url.href
}
