// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Playwright configuration for the API-gate suite (pure request-context
 * tests - NO browser launches, NO vite build, NO fixtures app).
 *
 * The suite runs against the hermetic api-mock origin (scripts/api-mock/
 * server.mjs), started here and reused if already listening, so both
 * `npm run test:api` locally and the CI job get the same deterministic
 * origin. Nothing in tests/api can reach the real network: the mock owns
 * every route the specs name, and a typo'd URL fails on the mock's 404
 * instead of hitting GitHub.
 *
 * The LIVE complement - the same contracts against the real GitHub,
 * F-Droid and updater endpoints - is the Bruno collection
 * (tests/api/bruno) plus the scheduled network-smoke workflow, never a
 * PR gate: shared quota must not decide whether a PR is green.
 */
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.API_MOCK_PORT || 8787);

export default defineConfig({
  testDir: './tests/api',
  // Wire contracts are milliseconds-fast; the timeout exists to catch a
  // hung mock, not to accommodate a slow origin.
  timeout: 15_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Pure request context: no browser is ever launched by this project.
  },
  webServer: {
    command: 'node scripts/api-mock/server.mjs',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
