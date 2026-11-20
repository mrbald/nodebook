import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import { readGraphRows } from './graphRows'
import { readNoteVectors } from './rag/store'
import { projectVaultThemes } from './vaultThemes'

export interface VaultThemesWork {
  dbPath: string
  root: string
  semantic: { model: string; extension: string } | null
}

const { dbPath, root, semantic } = workerData as VaultThemesWork
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  if (semantic) db.loadExtension(semantic.extension)
  const { graph, vectors } = db.transaction(() => {
    const graph = readGraphRows(db)
    // Both rows and centroids come from the same committed WAL snapshot. A
    // model reset or disable may have landed before this reader first ran.
    const vectorTable = semantic && db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'chunk_vec'").get()
    const model = vectorTable && db.prepare("SELECT v FROM talk_meta WHERE k = 'model'").pluck().get()
    const docs = new Set(graph.files.filter(({ kind }) => kind === 'document').map(({ path }) => path))
    const vectors = semantic && model === semantic.model ? readNoteVectors(db, docs) : new Map()
    return { graph, vectors }
  })()
  db.close()
  parentPort?.postMessage(projectVaultThemes(root, graph, vectors))
} finally {
  if (db.open) db.close()
}
