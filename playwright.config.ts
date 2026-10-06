import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    // Pure Node. Imports the main-process modules directly — no Electron,
    // no Python, no fixtures on disk. Always runnable.
    { name: 'unit', testDir: './tests/unit' },

    // Spawns the Python sidecar and/or a headless Electron main process.
    // Serial because several specs drive one SQLite database across
    // consecutive Electron launches.
    { name: 'integration', testDir: './tests/integration', workers: 1 },

    // The pre-existing UI end-to-end suite. Kept out of the default run:
    // @playwright/test's electron.launch() passes --remote-debugging-port=0,
    // which this project's Electron rejects ("bad option"), so every spec in
    // here fails at launch regardless of app code. Run explicitly with
    // `npx playwright test --project=e2e` once that mismatch is resolved.
    { name: 'e2e', testDir: './tests/e2e' }
  ]
})
