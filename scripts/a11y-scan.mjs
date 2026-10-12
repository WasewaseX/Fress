#!/usr/bin/env node
/**
 * Fress — standalone automated accessibility scan (Agent 2, Task 6).
 *
 * Run:  npm i --no-save axe-core && node scripts/a11y-scan.mjs
 * (requires the dev server: npm run dev, or set BASE_URL)
 *
 * Drives the real app in Chromium through every key surface in three
 * languages (en, de, fa-rtl) and runs axe-core on each state:
 *   catalog, command palette (open + filtered), app detail modal,
 *   privacy pack tab, add-app modal, batch modal, compare modal,
 *   export modal, download manager (empty + seeded items), footer.
 *
 * Download items are seeded through the panel's own persistence store
 * ('fress.downloadItems.v1') so the verified / unverified / error /
 * cancelled chips, the Resume-vs-Retry buttons and the SHA copy row are
 * all scanned without needing a real transfer.
 *
 * Two passes:
 *   STRUCTURAL (blocking): every axe rule except color-contrast.
 *     Exit 1 when a serious/critical violation is found.
 *   CONTRAST (report-only): color-contrast rule alone, light + dark
 *     themes on the theme-sensitive surfaces. Reported prefixed with
 *     CONTRAST so theme-ownership triage stays clean; promoted into the
 *     blocking gate once the reported findings are fixed.
 *
 * Output: per-state violation list (serious/critical first).
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const axeSource = readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');

const BASE = process.env.BASE_URL || '';
let server;
if (!BASE) {
  server = await createServer({ root: ROOT, server: { port: 4173 } });
  await server.listen();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function injectAxe() {
  const has = await page.evaluate(() => typeof axe !== 'undefined');
  if (!has) await page.addScriptTag({ content: axeSource });
}

const scanPage = async ({ contrastOnly }) => {
  if (typeof axe === 'undefined') return [{ id: 'axe-missing', impact: 'critical', count: 1, help: 'axe failed to load', sample: [] }];
  try {
    axe.reset();
    if (contrastOnly) {
      // Contrast-only measurement: every other rule disabled.
      axe.configure({ rules: [{ id: 'color-contrast', enabled: true }], disableOtherRules: true });
    } else {
      // Structural pass: everything EXCEPT color-contrast (measured separately).
      axe.configure({ rules: [{ id: 'color-contrast', enabled: false }] });
    }
    const res = await axe.run(document, {});
    return (res.violations || []).map(v => ({
      id: v.id, impact: v.impact, count: v.nodes.length,
      help: v.help,
      sample: v.nodes.slice(0, 2).map(n => n.target.join(' ')),
    }));
  } catch (e) {
    return [{ id: 'axe-error', impact: 'critical', count: 1, help: String((e && e.message) || e), sample: [] }];
  }
};

async function setLang(code) {
  await page.evaluate((c) => localStorage.setItem('fress.lang', c), code);
}

async function setTheme(code) {
  await page.evaluate((c) => localStorage.setItem('fress.theme', c), code);
}

// Seeded download-panel state: exercises every final StatusChip variant and
// the SHA copy row without a real transfer. Values mirror the persisted
// shape deserializeItems() accepts (https URL, known statuses).
const SEED_ITEMS = [
  {
    url: 'https://example.com/fress/Fress_setup_1.0.9.exe',
    name: 'Fress_setup_1.0.9.exe',
    dir: '/downloads', bytes: 104857600, total: 104857600,
    status: 'completed', path: '/downloads/Fress_setup_1.0.9.exe',
    sha256: 'a'.repeat(64), verified: true, startedAt: Date.now(),
  },
  {
    url: 'https://example.com/fress/fress-portable.zip',
    name: 'fress-portable.zip',
    dir: '/downloads', bytes: 52428800, total: 52428800,
    status: 'completed', path: '/downloads/fress-portable.zip',
    sha256: 'b'.repeat(64), startedAt: Date.now(),
  },
  {
    url: 'https://example.com/fress/fress.dmg',
    name: 'fress.dmg',
    dir: '/downloads', bytes: 52428800, total: 104857600,
    status: 'error', error: 'Network connection lost', canResume: true,
    startedAt: Date.now(),
  },
  {
    url: 'https://example.com/fress/fress.AppImage',
    name: 'fress.AppImage',
    dir: '/downloads', bytes: 1048576, total: 104857600,
    status: 'cancelled', startedAt: Date.now(),
  },
];

async function seedDownloads() {
  await page.evaluate((items) => {
    localStorage.setItem('fress.downloadItems.v1', JSON.stringify(items));
  }, SEED_ITEMS);
  await page.reload();
  await page.waitForTimeout(400);
}

async function unseedDownloads() {
  await page.evaluate(() => {
    localStorage.removeItem('fress.downloadItems.v1');
  });
  await page.reload();
  await page.waitForTimeout(400);
}

async function scan(label, contrastOnly = false) {
  await injectAxe();
  const violations = await page.evaluate(scanPage, { contrastOnly });
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const minor = violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
  console.log(`\n== ${label} ==`);
  for (const v of blocking) {
    console.log(`  BLOCKING [${v.impact}] ${v.id} x${v.count} - ${v.help} @ ${v.sample.join(' | ')}`);
  }
  for (const v of minor) {
    console.log(`  moderate [${v.impact}] ${v.id} x${v.count} - ${v.help} @ ${v.sample.join(' | ')}`);
  }
  if (!violations.length) console.log('  clean');
  return blocking.length;
}

let blockingTotal = 0;
let contrastFindings = 0;
const settle = () => page.waitForTimeout(400);

for (const lang of ['en', 'de', 'fa']) {
  const url = `${BASE || 'http://localhost:4173'}/`;
  await page.goto(url);
  await setLang(lang);
  await page.reload();
  await settle();

  blockingTotal += await scan(`${lang}: catalog`);

  // Command palette: default state + localized query
  await page.keyboard.press('Control+k');
  await settle();
  blockingTotal += await scan(`${lang}: palette open`);
  const q = lang === 'de' ? 'vergleichen' : lang === 'fa' ? 'مقایسه' : 'compare';
  await page.keyboard.type(q);
  await settle();
  blockingTotal += await scan(`${lang}: palette filtered (${q})`);
  await page.keyboard.press('Escape');
  await settle();

  // Detail modal via first card's details control
  const detailBtn = page.locator('[id^="view-guide-btn-"]').first();
  if (await detailBtn.count()) {
    await detailBtn.click();
    await settle();
    blockingTotal += await scan(`${lang}: app detail modal`);
    await page.keyboard.press('Escape');
    await settle();
  }

  // Privacy Pack tab via the header page tab (id since visual round 26)
  const privacyTab = page.locator('#page-replace-btn').first();
  if (await privacyTab.count() && await privacyTab.isVisible().catch(() => false)) {
    await privacyTab.click().catch(() => {});
    await settle();
    blockingTotal += await scan(`${lang}: privacy pack`);
    await page.locator('#page-catalog-btn').first().click().catch(() => {});
    await settle();
  } else {
    console.log(`\n== ${lang}: privacy pack ==\n  SKIPPED (tab not reachable)`);
  }

  // Add-app modal
  const addBtn = page.locator('#header-add-app-btn').first();
  if (await addBtn.count()) {
    await addBtn.click().catch(() => {});
    await settle();
    blockingTotal += await scan(`${lang}: add app modal`);
    await page.keyboard.press('Escape');
    await settle();
  }

  // Batch modal
  await page.keyboard.press('b');
  await settle();
  blockingTotal += await scan(`${lang}: batch modal`);
  await page.keyboard.press('Escape');
  await settle();

  // Compare modal
  await page.keyboard.press('m');
  await settle();
  blockingTotal += await scan(`${lang}: compare modal`);
  await page.keyboard.press('Escape');
  await settle();

  // Export modal
  await page.keyboard.press('e');
  await settle();
  blockingTotal += await scan(`${lang}: export modal`);
  await page.keyboard.press('Escape');
  await settle();

  // Download manager: empty panel
  const dlBtn = page.locator('#header-downloads-btn').first();
  if (await dlBtn.count()) {
    await dlBtn.click().catch(() => {});
    await settle();
    blockingTotal += await scan(`${lang}: downloads (empty)`);
    await page.keyboard.press('Escape');
    await settle();

    // Download manager: seeded items (verified, unverified, error+resume, cancelled)
    await seedDownloads();
    await dlBtn.click().catch(() => {});
    await settle();
    blockingTotal += await scan(`${lang}: downloads (seeded items)`);
    await page.keyboard.press('Escape');
    await settle();
    await unseedDownloads();
  }

  // Footer
  await page.locator('#main-app-footer').scrollIntoViewIfNeeded().catch(() => {});
  blockingTotal += await scan(`${lang}: footer`);
}

// Long German strings + narrow viewport (RTL and clipping checks are
// reported separately by the interactive pass; here we scan the states).
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${BASE || 'http://localhost:4173'}/`);
await setLang('de');
await page.reload();
await settle();
blockingTotal += await scan('de @390px: catalog narrow');

// ---------- CONTRAST pass (report-only) ----------
// Agent 1 owns theme inks; PR #44 claims amber warnings hold AA in light.
// Measure rather than trust: light theme across the theme-sensitive
// surfaces, plus one dark-theme control. Prefix CONTRAST, never blocks.
await page.setViewportSize({ width: 1280, height: 900 });
const contrastStates = [
  { label: 'catalog', action: null },
  { label: 'app detail modal', action: 'detail' },
  { label: 'downloads (seeded items)', action: 'downloads' },
  { label: 'privacy pack', action: 'privacy' },
];
for (const theme of ['light', 'dark']) {
  for (const lang of ['en', 'de', 'fa']) {
    await page.goto(`${BASE || 'http://localhost:4173'}/`);
    await setLang(lang);
    await setTheme(theme);
    await page.reload();
    await settle();
    let label = `contrast ${theme}/${lang}`;
    let state = contrastStates[0];
    if (theme === 'light') {
      // full surface set in light (the risky theme after the ink changes)
      for (state of contrastStates) {
        const l = `contrast ${theme}/${lang}: ${state.label}`;
        if (state.action === 'detail') {
          const b = page.locator('[id^="view-guide-btn-"]').first();
          if (!(await b.count())) continue;
          await b.click(); await settle();
          contrastFindings += await scan(l, true);
          await page.keyboard.press('Escape'); await settle();
        } else if (state.action === 'downloads') {
          await seedDownloads();
          const dl = page.locator('#header-downloads-btn').first();
          if (!(await dl.count())) { await unseedDownloads(); continue; }
          await dl.click(); await settle();
          contrastFindings += await scan(l, true);
          await page.keyboard.press('Escape'); await settle();
          await unseedDownloads();
        } else if (state.action === 'privacy') {
          const t = page.locator('#page-replace-btn').first();
          if (!(await t.count()) || !(await t.isVisible().catch(() => false))) continue;
          await t.click(); await settle();
          contrastFindings += await scan(l, true);
          await page.locator('#page-catalog-btn').first().click().catch(() => {}); await settle();
        } else {
          contrastFindings += await scan(l, true);
        }
      }
    } else {
      // dark control: catalog only
      contrastFindings += await scan(`${label}: catalog`, true);
    }
  }
}

await browser.close();
if (server) await server.close();

console.log(`\n${blockingTotal} blocking structural violation(s) across all scans`);
console.log(`${contrastFindings} contrast finding(s) (report-only, light+dark measurement)`);
process.exit(blockingTotal ? 1 : 0);
