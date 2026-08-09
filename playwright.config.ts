import { defineConfig } from "@playwright/test"

export default defineConfig({
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 1,
  fullyParallel: false,
  globalSetup: "./tests/web/global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "web-e2e",
      testDir: "./tests/electron",
      testMatch: "*.electron.spec.ts",
      timeout: 180_000,
    },
    {
      name: "bench",
      testDir: "./tests/bench",
      testMatch: "*.bench.ts",
      timeout: 180_000,
      // Latency budgets are meaningless when independent host/browser pairs
      // contend for the same CPU. Keep functional E2E parallel, benchmarks serial.
      fullyParallel: false,
      workers: 1,
    },
  ],
})
