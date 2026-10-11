// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Vitest scope guard, added with the E2E suite.
 *
 * The unit runner must never collect the browser E2E specs (tests/e2e)
 * or the perf harness (scripts/perf): those are Playwright's to run, in
 * a real Chromium against the production build. Without this file vitest's
 * default spec glob swept the whole repo and failed on specs it was never
 * meant to execute.
 *
 * The Vite config is merged in unchanged, so the unit environment stays
 * exactly what it was (same plugins, same aliases, jsdom via the existing
 * per-file pragmas).
 */
import { mergeConfig, defineConfig, type UserConfig } from 'vitest/config';
import viteConfig from './vite.config';

// The Vite config is exported in callback form; resolve it before merging
// (it ignores the command/mode arguments, so a plain call is safe here).
const resolvedViteConfig =
  typeof viteConfig === 'function' ? (viteConfig as unknown as () => UserConfig)() : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['tests/**', 'scripts/**', 'node_modules/**', 'dist/**'],
    },
  })
);
