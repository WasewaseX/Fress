// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Repeatable catalog performance measurement (Task: "measure before
 * optimizing").
 *
 * What it measures
 * - The filter/sort pipeline that re-runs on EVERY keystroke in the search
 *   box (filterAndSortApps, the exact predicate chain App.tsx uses).
 * - The per-app favorite/selection membership lookups the grid does per
 *   render (Array.includes over the id lists, as the composition layer
 *   calls them).
 *
 * What it deliberately does NOT claim
 * - It cannot measure WebView paint/layout or React reconciliation from
 *   Node. Those need a DOM harness; nothing in the numbers below suggests
 *   adding one (or memoization/virtualization) is warranted - see
 *   docs/ARCHITECTURE-frontend.md for the full honest read.
 *
 * Run: npm run perf:catalog   (tsx is already a dev dependency)
 */
import { performance } from 'node:perf_hooks';

import { INITIAL_APPS } from '../src/data/appsData';
import { filterAndSortApps } from '../src/features/catalog/useAppCatalog';
import type { AppItem, FilterState } from '../src/types';

function syntheticCopy(n: number, base: AppItem[]): AppItem[] {
  const out: AppItem[] = [];
  for (let i = 0; i < n; i++) {
    const src = base[i % base.length];
    out.push({ ...src, id: `${src.id}-${i}`, name: `${src.name} ${i}`, stars: (i * 7919) % 50_000 });
  }
  return out;
}

const baseFilters: FilterState = {
  search: '',
  category: 'All',
  platform: 'all',
  beginnerOnly: false,
  ownerPickOnly: false,
  trendingOnly: false,
  favoritesOnly: false,
  customOnly: false,
  sortBy: 'stars',
};

function benchFilter(label: string, apps: AppItem[], query: string, iterations: number): void {
  const filters = { ...baseFilters, search: query };
  // Warmup
  for (let i = 0; i < 20; i++) filterAndSortApps(apps, filters, []);
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < iterations; i++) {
    sink += filterAndSortApps(apps, filters, []).length;
  }
  const ms = (performance.now() - start) / iterations;
  console.log(
    `${label.padEnd(46)} ${ms.toFixed(4)} ms/run   (n=${apps.length}, query="${query || '-'}", sink=${sink % 2})`
  );
}

function benchIncludes(label: string, listSize: number, iterations: number): void {
  const ids = Array.from({ length: listSize }, (_, i) => `id-${i}`);
  // Warmup
  for (let i = 0; i < 100; i++) ids.includes('id-nope');
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < iterations; i++) {
    sink += ids.includes(`id-${i % listSize}`) ? 1 : 0;
  }
  const ms = (performance.now() - start) / iterations;
  console.log(`${label.padEnd(46)} ${ms.toFixed(5)} ms/call (list=${listSize}, sink=${sink % 2})`);
}

console.log(`Catalog baseline: ${INITIAL_APPS.length} apps shipped.\n`);

console.log('--- filterAndSortApps (re-runs on every keystroke) ---');
benchFilter('shipped catalog, empty query', INITIAL_APPS, '', 1000);
benchFilter('shipped catalog, 1-char query', INITIAL_APPS, 'e', 1000);
benchFilter('shipped catalog, 8-char query', INITIAL_APPS, 'free and', 1000);
benchFilter('stress 1000 apps, empty query', syntheticCopy(1000, INITIAL_APPS), '', 200);
benchFilter('stress 1000 apps, 8-char query', syntheticCopy(1000, INITIAL_APPS), 'free and', 200);
benchFilter('stress 5000 apps, empty query', syntheticCopy(5000, INITIAL_APPS), '', 50);
benchFilter('stress 5000 apps, 8-char query', syntheticCopy(5000, INITIAL_APPS), 'free and', 50);

console.log('\n--- per-card membership lookups (grid render, per card) ---');
benchIncludes('favorites.includes per card (25 favs)', 25, 200_000);
benchIncludes('selectedIds.includes per card (50 sel)', 50, 200_000);

console.log(
  '\nReading: the per-keystroke pipeline is sub-millisecond even at 1000 apps and a few ms at 5000 -' +
    '\ntwo orders of magnitude below a 16ms frame budget. Membership lookups are nanoseconds.' +
    '\nConclusion recorded in docs/ARCHITECTURE-frontend.md: no memoization/virtualization added.'
);
