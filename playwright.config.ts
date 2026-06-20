import { defineConfig } from '@playwright/test'

// Electron e2e: drives the real app over the Chromium DevTools protocol — no
// OS Accessibility/Screen-Recording permissions needed. Requires a fresh build
// (`npm run build`) first; `npm run test:e2e` chains that automatically.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // Hard 10s ceiling: the whole app is local and every interaction is sub-second,
  // so anything slower is a real functional/perf bug — fail fast, never hang.
  timeout: 10_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    trace: 'on-first-retry'
  }
})
