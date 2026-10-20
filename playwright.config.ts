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
      // Screenshots and videos are kept for every run, so the HTML report shows passing flows too.
      name: 'ui',
      testMatch: ['**/resilience.spec.ts', '**/e2e/**/*.spec.ts'],
      timeout: 60_000,
      use: {
        channel: 'chrome',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'on',
        video: 'on',
      },
    },
    {
      // Visual regression of the glass dock across viewports (baselines per OS, see the spec).
      name: 'visual',
      testDir: './tests/visual',
      timeout: 60_000,
      use: { channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    },
  ],
});
