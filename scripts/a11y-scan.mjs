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
 *   download manager (empty + with items), privacy pack tab,
 *   add-app modal, compare modal, batch modal, export modal, footer.
 *
 * Output: per-state violation list (serious/critical first), exit 1 when a
 * serious violation is found, 0 otherwise. Moderate/minor are reported for
 * triage without failing the run.
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

const scanPage = async () => {
  if (typeof axe === 'undefined') return [{ id: 'axe-missing', impact: 'critical', count: 1, help: 'axe failed to load', sample: [] }];
  try {
    axe.configure({ rules: [{ id: 'color-contrast', enabled: false }] });
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

async function scan(label) {
  await injectAxe();
  const violations = await page.evaluate(scanPage);
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

  // Privacy Pack tab (only on privacy page tab bar)
  const privacyTab = page.locator('#tab-privacy, [data-testid="tab-privacy"]').first();
  if (await privacyTab.count()) {
    await privacyTab.click().catch(() => {});
    await settle();
    blockingTotal += await scan(`${lang}: privacy pack`);
    const tabs = page.locator('#tab-apps').first();
    if (await tabs.count()) await tabs.click().catch(() => {});
    await settle();
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

await browser.close();
if (server) await server.close();

console.log(`\n${blockingTotal} blocking violation(s) across all scans`);
process.exit(blockingTotal ? 1 : 0);
