/// <reference lib="webworker" />
/**
 * Embedding worker — runs transformers.js (onnxruntime-web / WASM) off the UI
 * thread. Loaded lazily, only when "talk to docs" is enabled. The model is
 * fetched from the HF Hub on first use and cached by the renderer (Cache API),
 * so subsequent launches are offline-capable. No note text ever leaves the
 * machine — embedding is fully local.
 */
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

// We always pull models from the Hub (there's no local model dir in the app).
env.allowLocalModels = false

type InMsg =
  | { type: 'init'; model: string }
  | { type: 'embed'; id: number; texts: string[] }

let extractor: FeatureExtractionPipeline | null = null

async function embed(texts: string[]): Promise<{ vectors: Float32Array[]; dims: number }> {
  const out = await extractor!(texts, { pooling: 'mean', normalize: true })
  const dims = out.dims[out.dims.length - 1]
  const data = out.data as Float32Array
  const vectors: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) vectors.push(data.slice(i * dims, (i + 1) * dims))
  return { vectors, dims }
}

self.onmessage = async (e: MessageEvent<InMsg>): Promise<void> => {
  const msg = e.data
  try {
    if (msg.type === 'init') {
      extractor = (await pipeline('feature-extraction', msg.model)) as FeatureExtractionPipeline
      const { dims } = await embed(['probe'])
      self.postMessage({ type: 'ready', dims })
    } else if (msg.type === 'embed') {
      const { vectors } = await embed(msg.texts)
      self.postMessage(
        { type: 'embedded', id: msg.id, vectors },
        vectors.map((v) => v.buffer)
      )
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: 'id' in msg ? msg.id : -1, message: String(err) })
  }
}
