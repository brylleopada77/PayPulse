import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry on CI so a failure gets a video (video: 'on-first-retry'). A test that passes only
  // on the retry is still reported as FLAKY in the HTML report: flaky tests are fixed, not hidden.
  retries: process.env.CI ? 1 : 0,
  // After the last test: the ledger invariant check (debits = credits, cash = balances + fees + reserves).
  globalTeardown: './tests/global-teardown.ts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  // Every project: a screenshot when a test fails, a video when it is retried.
  use: { baseURL, screenshot: 'only-on-failure', video: 'on-first-retry' },
  expect: {
    // Visual regression: tolerate sub-pixel anti-aliasing noise, nothing more.
    // threshold: per-pixel colour tolerance (default 0.2 is too lax for subtle glass on a light
    // background: a 28px -> 8px corner change slipped through). maxDiffPixelRatio: noise budget.
    toHaveScreenshot: { threshold: 0.05, maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' },
  },
  projects: [
    {
      // REST API tests (no browser).
      name: 'api',
      testDir: './tests/api',
      use: { extraHTTPHeaders: { 'Content-Type': 'application/json' } },
    },
    {
      // Browser suites: chaos / resilience and the end-to-end customer flows, in the installed
      // Google Chrome (also present on GitHub's ubuntu runners, so no browser download is needed).
      name: 'ui',
      testMatch: ['**/resilience.spec.ts', '**/e2e/**/*.spec.ts'],
      timeout: 60_000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
      },
    },
    {
      // Visual regression of the glass dock across viewports (baselines per OS, see the spec).
      name: 'visual',
      testDir: './tests/visual',
      timeout: 60_000,
      use: { channel: 'chrome', trace: 'retain-on-failure' },
    },
  ],
});
