import { defineConfig } from '@playwright/test'

// The LIVE e2e: the real app with the real embedding model and the real chat
// provider, on one small document. Not part of `npm run test:e2e` — it needs
// network (the model is downloaded on first run), a signed-in `claude`, and
// minutes rather than seconds. `npm run test:e2e:live` builds and runs it.
export default defineConfig({
  testDir: './e2e/live',
  fullyParallel: false,
  workers: 1,
  // A real run is a model download plus a few sequential model calls.
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    trace: 'on-first-retry'
  }
})
