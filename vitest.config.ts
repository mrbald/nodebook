import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Pure-logic unit tests run in Node — CodeMirror's EditorState/parsing work
// without a DOM. The Playwright Electron specs under e2e/ are excluded here;
// run them with `npm run test:e2e`.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'out/**']
  }
})
