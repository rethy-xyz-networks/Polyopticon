'use strict';

// End-to-end tests: drive the real Electron app (tests/e2e). Unit tests run
// separately with node:test (tests/unit) — see the "test" scripts in package.json.

const { defineConfig } = require('@playwright/test');

// On Linux the app must run on the virtual display scripts/playwright.js sets up, or its windows open on the desktop.
if (process.platform === 'linux' && process.env.POLYOPTICON_XVFB !== '1')
  throw new Error('Run the e2e tests with `npm run test:e2e` (or test:perf), which keeps their windows off the desktop.');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,                        // one Electron window at a time
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
