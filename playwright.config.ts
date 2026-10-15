import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // flaky tests should be fixed, not hidden behind retries
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: { baseURL },
  projects: [
    {
      // REST API tests (no browser).
      name: 'api',
      testDir: './tests/api',
      use: { extraHTTPHeaders: { 'Content-Type': 'application/json' } },
    },
    {
      // Browser tests of the web wallet. Uses the installed Google Chrome (also present on
      // GitHub's ubuntu runners), so no browser download is needed.
      name: 'ui',
      testMatch: 'resilience.spec.ts',
      timeout: 60_000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    },
  ],
});
