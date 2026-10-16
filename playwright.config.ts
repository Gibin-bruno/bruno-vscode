import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // Each worker launches its own VS Code instance; locally they run one at a time.
  workers: process.env.CI ? 3 : 1,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  reporter: process.env.CI ? [['list'], ['html']] : [['list']],
  use: {
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx tsx tests/e2e/server/index.ts',
    url: 'http://127.0.0.1:8081/ping',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
