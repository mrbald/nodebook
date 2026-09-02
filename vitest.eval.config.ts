import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// The distill eval harness (`npm run eval:distill`) — a *separate* vitest
// project from the default one (`vitest.config.ts`, `npm test`), so it never
// runs as part of the ordinary suite: it reads real fixture files (a ~20-page
// PDF, whole books) and, with a real provider configured via
// DISTILL_EVAL_PROVIDER, makes network/CLI calls — the opposite of what a
// fast, hermetic default `npm test` run wants. See scripts/distill-eval.test.ts.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'out/**'],
    // A real-provider run (DISTILL_EVAL_PROVIDER set) makes many sequential
    // network/CLI calls; the default stubbed run finishes in a few seconds.
    testTimeout: 300_000
  }
})
