// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Playwright configuration for the integration E2E + visual regression suite.
 *
 * Design decisions (documented in docs/quality-gates.md):
 * - The suite runs against the PRODUCTION build served by `vite preview`
 *   (not the dev server): the E2E contract is the artifact that ships, and
 *   Vite's HMR/overlay machinery must never be able to mask a bug.
 * - Deterministic fixtures only: the suite never calls GitHub, F-Droid or
 *   any vendor endpoint. `tests/e2e/netpolicy.ts` answers every resolver
 *   endpoint from fixtures and aborts all other external requests, so a
 *   failing PR cannot be flaky because of shared API quota.
 * - Visual snapshots: same explicit viewport per shot, deviceScaleFactor 1,
 *   animations disabled by Playwright AND by a test-only stylesheet, fonts
 *   awaited via document.fonts.ready, sensible thresholds (maxDiffPixelRatio
 *   0.02) so one antialiasing pixel between OSes cannot fail CI.
 * - Tauri-mode tests inject `window.__TAURI_INTERNALS__` before any app
 *   script runs (tests/e2e/tauri-bridge.ts), mirroring the exact IPC/event
 *   contract of @tauri-apps/api 2.x including the event plugin internals.
 */
import { defineConfig } from '@playwright/test';

const PORT = 3000;

export default defineConfig({
  testDir: './tests/e2e',
  // Perf has its own harness (npm run test:perf); visual is part of this suite.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // OS-level antialiasing variance: 2% of pixels may differ. Real layout
      // regressions move far more than that.
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'Etc/UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: {
    // --host pins IPv4: in some CI containers localhost resolves to ::1 and
    // the loopback probe would hit the wrong stack.
    command: 'npx vite preview --port 3000 --host 127.0.0.1',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
