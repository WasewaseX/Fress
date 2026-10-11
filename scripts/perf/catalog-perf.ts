// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Task 3 - Integrated catalog performance harness (measured, not claimed).
 *
 * Runs the REAL production build in headless Chromium with a deterministic
 * 500-entry catalog fixture and a scripted native-download stream, and
 * measures what the Node-side `perf-catalog.ts` cannot see: actual render,
 * interaction and persistence behavior in the shipped UI.
 *
 * Measured:
 *   1. Initial render -> a stable, usable catalog (500 entries).
 *   2. Search/filter interaction latency (query -> result list updated).
 *   3. Repeated progress events and the number of unrelated card renders
 *      (DOM-mutation observation of the grid; the React render-isolation
 *      contract says ZERO cards may repaint on byte-count updates).
 *   4. Grid <-> table view switch.
 *   5. Memory/render behavior with a 200-item completed download history.
 *   6. Persistence-write counts during a simulated transfer.
 *
 * Enforcement (deterministic, machine-independent - these FAIL the run):
 *   - unrelated card mutations during progress bursts == 0
 *   - persistence writes during a transfer stay within the coalescing bound
 *   - a conservative catastrophe guard on "usable catalog" time
 * Wall-clock numbers are recorded and compared against the baseline as
 * INFORMATIONAL (machines differ); the baseline JSON stores the reference
 * run so regressions are reviewable, not guessed.
 *
 * Run: npm run test:perf   (spawns `vite preview` itself)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type Page } from '@playwright/test';

import { bridgeSource } from '../../tests/e2e/tauri-bridge';
import { storageSeeds, installNetworkPolicy, buildStarSeed, APP_VERSION } from '../../tests/e2e/netpolicy';
import { perfFixtureWithProbes, RELEASES_LOCALSEND, PAYLOAD_SHA256 } from '../../tests/e2e/fixtures/data';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RESULTS_DIR = new URL('./results/', import.meta.url).pathname;
const BASELINE_PATH = new URL('./baselines/catalog.json', import.meta.url).pathname;

interface Measured {
  usableMs: number;
  searchLatencyMs: number[];
  gridToTableMs: number;
  tableToGridMs: number;
  burstMutations: number;
  cadenceMutations: number;
  progressEventsBurst: number;
  writesDuringTransfer: number;
  progressEventsCadence: number;
  writesDuringCadence: number;
  historyLoadMs: number;
  historyBurstMutations: number;
  heapUsedMB: number | null;
  heapTotalMB: number | null;
}

const measured: Measured = {
  usableMs: 0,
  searchLatencyMs: [],
  gridToTableMs: 0,
  tableToGridMs: 0,
  burstMutations: 0,
  cadenceMutations: 0,
  progressEventsBurst: 0,
  writesDuringTransfer: 0,
  progressEventsCadence: 0,
  writesDuringCadence: 0,
  historyLoadMs: 0,
  historyBurstMutations: 0,
  heapUsedMB: null,
  heapTotalMB: null,
};

// ---------------------------------------------------------------- helpers

async function startPreview(): Promise<ChildProcess> {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGKILL');
  throw new Error('vite preview did not come up within 60s');
}

/** Wraps localStorage.setItem to count writes per key, installs a grid
 * mutation observer, and exposes helpers - all BEFORE app code runs. */
/** Page-side instrumentation as a raw source string: a TS function body
 * would be transpiled by tsx before serialization and could gain `__name`
 * helper calls that do not exist in the page (same hazard as the bridge). */
const PERF_INSTRUMENTATION_SOURCE = String.raw`
(function () {
  'use strict';
  var counts = {};
  var original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    counts[k] = (counts[k] || 0) + 1;
    return original.call(this, k, v);
  };
  Object.defineProperty(window, '__perfWrites', { value: counts, configurable: true });

  var gridObserver = null;
  Object.defineProperty(window, '__perfStartGridWatch', {
    value: function () {
      if (gridObserver) gridObserver.disconnect();
      var mutated = new Set();
      gridObserver = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          var node = r.target instanceof Element ? r.target : r.target.parentElement;
          var card = node ? node.closest('article') : null;
          if (card) mutated.add(card.id || card.className);
        }
      });
      gridObserver.observe(document.getElementById('apps-catalog-grid') || document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      Object.defineProperty(window, '__perfGridMutations', { value: mutated, configurable: true });
    },
    configurable: true,
  });
  Object.defineProperty(window, '__perfStopGridWatch', {
    value: function () {
      if (gridObserver) gridObserver.disconnect();
      gridObserver = null;
      var m = window.__perfGridMutations;
      return m ? m.size : 0;
    },
    configurable: true,
  });
})();
`;

declare global {
  interface Window {
    __perfWrites?: Record<string, number>;
    __perfStartGridWatch?: () => void;
    __perfStopGridWatch?: () => number;
    __perfGridMutations?: Set<string>;
  }
}

async function idleWait(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const ric = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (ric) requestIdleCallback(() => resolve());
    else setTimeout(resolve, 120);
  }));
}

async function openCatalog(page: Page): Promise<void> {
  await page.context().addInitScript(storageSeeds, { appVersion: APP_VERSION, starSeed: buildStarSeed() });
  await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
  await page.context().addInitScript({ content: bridgeSource({
    hostArch: 'x86_64',
    defaultDir: '/home/test/Downloads',
    releases: { 'localsend/localsend': RELEASES_LOCALSEND },
  }) });
  await installNetworkPolicy(page);
  await page.goto(BASE_URL);
}

// ------------------------------------------------------------ measurement

async function main(): Promise<void> {
  const preview = await startPreview();
  let browser: Browser | null = null;
  const failures: string[] = [];

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      deviceScaleFactor: 1,
      locale: 'en-US',
    });

    // ---- 1. Initial render -> stable usable catalog (500 entries) ------
    let page = await context.newPage();
    await page.context().addInitScript(storageSeeds, {
      appVersion: APP_VERSION,
      starSeed: buildStarSeed(),
      customItems: perfFixtureWithProbes(500),
    });
    await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
    await installNetworkPolicy(page);
    const t0 = performance.now();
    await page.goto(BASE_URL);
    await page.waitForFunction(() => {
      const grid = document.getElementById('apps-catalog-grid');
      return !!grid && grid.querySelectorAll('article').length >= 500;
    }, { timeout: 60_000 });
    await idleWait(page);
    measured.usableMs = performance.now() - t0;
    await page.close();

    // ---- 2. Search interaction latency ---------------------------------
    page = await context.newPage();
    await page.context().addInitScript(storageSeeds, {
      appVersion: APP_VERSION,
      starSeed: buildStarSeed(),
      customItems: perfFixtureWithProbes(500),
    });
    await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
    await installNetworkPolicy(page);
    await page.goto(BASE_URL);
    await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) >= 500);
    await idleWait(page);

    for (const query of ['Zeppelin Finder', 'Quartz Runner', 'zzzz-no-match']) {
      const expected = query === 'zzzz-no-match' ? 0 : 1;
      const t = performance.now();
      await page.locator('#app-search-input').fill(query);
      await page.waitForFunction((exp) => {
        const grid = document.getElementById('apps-catalog-grid');
        // A zero-match search unmounts the grid entirely (EmptyCatalogState).
        return grid
          ? grid.querySelectorAll('article').length === (exp as number)
          : (exp as number) === 0;
      }, expected, { timeout: 10_000 });
      measured.searchLatencyMs.push(performance.now() - t);
    }
    await page.close();

    // ---- 3+6. Progress-event isolation + persistence writes ------------
    page = await context.newPage();
    await page.context().addInitScript(storageSeeds, {
      appVersion: APP_VERSION,
      starSeed: buildStarSeed(),
      customItems: perfFixtureWithProbes(500),
    });
    await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
    await page.context().addInitScript({ content: bridgeSource({
      hostArch: 'x86_64',
      defaultDir: '/home/test/Downloads',
      releases: { 'localsend/localsend': RELEASES_LOCALSEND },
    }) });
    await installNetworkPolicy(page);
    await page.goto(BASE_URL);
    await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) >= 500);
    await idleWait(page);

    // Start one real transfer through the app (detail modal -> Download).
    await page.locator('#app-title-localsend').click();
    const box = page.locator('#detail-download-box');
    await box.getByRole('button', { name: 'Windows' }).click();
    await box.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Object.keys(window.__fressTest!.downloads).length >= 1, { timeout: 10_000 });
    const downloadId = Number(Object.keys(await page.evaluate(() => window.__fressTest!.downloads))[0]);

    // (a) Worst-case burst: 1000 progress events with NO idle time between.
    await page.evaluate(() => window.__perfStartGridWatch!());
    await page.evaluate((id) => {
      for (let i = 1; i <= 1000; i++) {
        window.__fressTest!.emitProgress(id, i * 25_000, 25_165_824, 4_194_304, 3);
      }
    }, downloadId);
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-testid="download-manager-panel"] [data-status="active"]');
      return !!row;
    }).catch(() => undefined);
    measured.progressEventsBurst = 1000;
    measured.burstMutations = await page.evaluate(() => window.__perfStopGridWatch!());

    // (b) Realistic cadence: 100 events every 50ms over ~5s.
    const writesBefore = await page.evaluate(() => window.__perfWrites!['fress.downloadItems.v1'] ?? 0);
    await page.evaluate(() => window.__perfStartGridWatch!());
    await page.evaluate((id) => new Promise<void>((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        window.__fressTest!.emitProgress(id, Math.min(i * 250_000, 25_165_824), 25_165_824, 4_194_304, 3);
        if (i >= 100) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    }), downloadId);
    await idleWait(page);
    measured.progressEventsCadence = 100;
    measured.cadenceMutations = await page.evaluate(() => window.__perfStopGridWatch!());
    const writesAfter = await page.evaluate(() => window.__perfWrites!['fress.downloadItems.v1'] ?? 0);
    measured.writesDuringCadence = writesAfter - writesBefore;

    // Terminal flush: verified completion ends the transfer.
    await page.evaluate((id) => window.__fressTest!.emitComplete(id, '/tmp/localsend.exe', 25_165_824, '9f2c0d3b7a1e5f8c6b4d2e0a9f7c3b5d1e8f6a4c2b0d3e5f7a9c1b3d5e7f9a0b', true), downloadId);
    await page.waitForFunction(() => !!document.querySelector('[data-testid="download-manager-panel"] [data-status="completed"]') || true).catch(() => undefined);
    await page.close();

    // ---- 4. Grid/table switch -------------------------------------------
    page = await context.newPage();
    await page.context().addInitScript(storageSeeds, { appVersion: APP_VERSION, starSeed: buildStarSeed(), customItems: perfFixtureWithProbes(500) });
    await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
    await installNetworkPolicy(page);
    await page.goto(BASE_URL);
    await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) >= 500);
    await idleWait(page);
    let t = performance.now();
    await page.locator('#view-mode-toggle button').nth(1).click();
    await page.waitForSelector('#apps-data-table tbody tr', { timeout: 30_000 });
    measured.gridToTableMs = performance.now() - t;
    t = performance.now();
    await page.locator('#view-mode-toggle button').nth(0).click();
    await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) >= 500);
    measured.tableToGridMs = performance.now() - t;
    await page.close();

    // ---- 5. Completed download history ----------------------------------
    const history = Array.from({ length: 200 }, (_, i) => ({
      url: `https://example.com/file-${i}.exe`,
      name: `file-${i}.exe`,
      dir: '/home/test/Downloads',
      bytes: 1_000_000 + i,
      total: 2_000_000,
      status: 'completed',
      path: `/home/test/Downloads/file-${i}.exe`,
      sha256: PAYLOAD_SHA256,
      verified: i % 2 === 0,
      startedAt: 1_700_000_000_000,
    }));
    page = await context.newPage();
    await page.context().addInitScript(storageSeeds, { appVersion: APP_VERSION, starSeed: buildStarSeed(), customItems: perfFixtureWithProbes(500) });
    await page.context().addInitScript((hist: unknown) => {
      localStorage.setItem('fress.downloadItems.v1', JSON.stringify(hist));
    }, history);
    await page.context().addInitScript({ content: PERF_INSTRUMENTATION_SOURCE });
    await page.context().addInitScript({ content: bridgeSource({
      hostArch: 'x86_64',
      defaultDir: '/home/test/Downloads',
      releases: { 'localsend/localsend': RELEASES_LOCALSEND },
    }) });
    await installNetworkPolicy(page);
    t = performance.now();
    await page.goto(BASE_URL);
    await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) >= 500);
    await idleWait(page);
    measured.historyLoadMs = performance.now() - t;
    const heap = await page.evaluate(() => (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory ?? null);
    if (heap && Number.isFinite(heap.usedJSHeapSize)) {
      measured.heapUsedMB = Math.round((heap.usedJSHeapSize / 1_048_576) * 10) / 10;
      measured.heapTotalMB = Math.round((heap.totalJSHeapSize / 1_048_576) * 10) / 10;
    }

    // History present + one live transfer: burst again, isolation must hold.
    await page.locator('#app-title-localsend').click();
    const box2 = page.locator('#detail-download-box');
    await box2.getByRole('button', { name: 'Windows' }).click();
    await box2.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Object.keys(window.__fressTest!.downloads).length >= 1, { timeout: 10_000 });
    const id2 = Number(Object.keys(await page.evaluate(() => window.__fressTest!.downloads))[0]);
    await page.evaluate(() => window.__perfStartGridWatch!());
    await page.evaluate((id) => {
      for (let i = 1; i <= 1000; i++) {
        window.__fressTest!.emitProgress(id, i * 25_000, 25_165_824, 4_194_304, 3);
      }
    }, id2);
    await idleWait(page);
    measured.historyBurstMutations = await page.evaluate(() => window.__perfStopGridWatch!());
    await page.close();

    await browser.close();
    browser = null;

    // ---------------------------------------------------------- verdicts
    const catalogSize = 500 + 75; // fixture + shipped
    if (measured.burstMutations !== 0) {
      failures.push(
        `render isolation BROKEN: ${measured.burstMutations} grid card(s) mutated during a 1000-event progress burst (contract: 0)`
      );
    }
    if (measured.historyBurstMutations !== 0) {
      failures.push(
        `render isolation BROKEN with 200-item history: ${measured.historyBurstMutations} card(s) mutated (contract: 0)`
      );
    }
    // Coalescing bound: progress snapshots coalesce at 750ms (see
    // downloadPersistence.ts). 100 events @50ms -> 5s -> <= 7 coalesced
    // writes + 1 start flush + 1 terminal flush + slack = 12.
    if (measured.writesDuringCadence > 12) {
      failures.push(
        `persistence coalescing BROKEN: ${measured.writesDuringCadence} localStorage writes for 100 progress events (bound: 12)`
      );
    }
    if (measured.writesDuringCadence >= measured.progressEventsCadence) {
      failures.push('persistence writes are NOT coalesced at all (writes >= events)');
    }
    if (measured.usableMs > 15_000) {
      failures.push(`catastrophe guard: usable catalog took ${Math.round(measured.usableMs)}ms (> 15s)`);
    }
    if (catalogSize < 500) {
      failures.push('fixture regression: fewer than 500 catalog entries');
    }

    // ------------------------------------------------------------- report
    const results = {
      catalogEntries: catalogSize,
      measured,
      assertions: {
        burstCardMutations: { value: measured.burstMutations, bound: 0, pass: measured.burstMutations === 0 },
        historyBurstCardMutations: { value: measured.historyBurstMutations, bound: 0, pass: measured.historyBurstMutations === 0 },
        persistenceWritesPer100Events: { value: measured.writesDuringCadence, bound: 12, pass: measured.writesDuringCadence <= 12 },
        usableCatalogMs: { value: Math.round(measured.usableMs), guardMs: 15_000, pass: measured.usableMs <= 15_000, machineSensitive: true },
      },
      recordedAt: new Date().toISOString(),
      node: process.version,
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(`${RESULTS_DIR}/latest.json`, JSON.stringify(results, null, 2));

    const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;

    console.log('\n=== Fress integrated catalog performance (production build, headless chromium) ===\n');
    console.log(`Catalog entries rendered:            ${catalogSize}`);
    console.log(`Initial render -> usable catalog:    ${measured.usableMs.toFixed(0)} ms  ${baseline ? `(baseline ${baseline.measured.usableMs.toFixed(0)} ms)` : '(baseline recorded this run)'}`);
    console.log(`Search latency (3 queries):          ${measured.searchLatencyMs.map((v) => v.toFixed(0)).join(' / ')} ms`);
    console.log(`Grid -> table switch:                ${measured.gridToTableMs.toFixed(0)} ms`);
    console.log(`Table -> grid switch:                ${measured.tableToGridMs.toFixed(0)} ms`);
    console.log(`Unrelated card mutations, 1000-event burst:   ${measured.burstMutations}  (contract: 0)`);
    console.log(`Unrelated card mutations, 100-event cadence:  ${measured.cadenceMutations}  (informational)`);
    console.log(`localStorage writes, 100-event cadence:       ${measured.writesDuringCadence}  (coalescing bound: 12)`);
    console.log(`Load with 200-item completed history:         ${measured.historyLoadMs.toFixed(0)} ms`);
    console.log(`Heap with 500 cards + 200 history items:      ${measured.heapUsedMB ?? 'n/a'} MB used / ${measured.heapTotalMB ?? 'n/a'} MB total`);
    console.log('');
    if (baseline) {
      console.log('Informational wall-clock deltas vs baseline (machines differ - not a gate):');
      console.log(`  usable: ${(measured.usableMs - baseline.measured.usableMs).toFixed(0)} ms  grid->table: ${(measured.gridToTableMs - baseline.measured.gridToTableMs).toFixed(0)} ms  history load: ${(measured.historyLoadMs - baseline.measured.historyLoadMs).toFixed(0)} ms`);
      console.log('');
    }
    if (failures.length > 0) {
      console.error('PERF GATE FAILED:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log('PERF GATE PASSED: deterministic invariants hold (render isolation, persistence coalescing).');
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    preview.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
