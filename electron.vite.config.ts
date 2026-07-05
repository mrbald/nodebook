import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps node_modules deps out of the bundle; the
    // explicit `external` is belt-and-suspenders for the native addon so it is
    // resolved at runtime against Electron's ABI, never bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'sqlite-vec']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        // The ONNX wasm runtime files, imported as bundled assets by the embed
        // worker (see embed.worker.ts) so the app never fetches them from a
        // CDN. An alias because onnxruntime-web's package `exports` does not
        // expose ./dist/* for direct import.
        '@ort-wasm': resolve('node_modules/onnxruntime-web/dist')
      }
    },
    optimizeDeps: {
      // These are `?url` ASSET imports (see embed.worker.ts), but the alias
      // makes them look like bare package imports, so the dev-server dep
      // optimizer tries to pre-bundle the .mjs and crashes ("optimized info
      // should be defined"). The production build is unaffected either way.
      // Both bare and ?url-suffixed forms: the optimizer registers the id
      // WITH the query (seen in the crash: …__mjs?url.js).
      exclude: [
        '@ort-wasm/ort-wasm-simd-threaded.asyncify.mjs',
        '@ort-wasm/ort-wasm-simd-threaded.asyncify.wasm',
        '@ort-wasm/ort-wasm-simd-threaded.asyncify.mjs?url',
        '@ort-wasm/ort-wasm-simd-threaded.asyncify.wasm?url'
      ]
    },
    plugins: [react()]
  }
})
