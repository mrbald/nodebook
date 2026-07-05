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
    plugins: [react()]
  }
})
