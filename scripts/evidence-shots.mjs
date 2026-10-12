// Evidence screenshots for the acceptance round.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: '/home/z/my-project/fress', server: { port: 4187 } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const settle = (ms = 600) => page.waitForTimeout(ms);
const OUT = '/home/z/my-project/fress-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const SEED = [
  { url: 'https://example.com/fress/Fress_setup_1.0.9.exe', name: 'Fress_setup_1.0.9.exe', dir: '/d', bytes: 104857600, total: 104857600, status: 'completed', path: '/downloads/Fress_setup_1.0.9.exe', sha256: 'a'.repeat(64), verified: true, startedAt: 1 },
  { url: 'https://example.com/fress/fress.dmg', name: 'fress.dmg', dir: '/d', bytes: 52428800, total: 104857600, status: 'error', error: 'Network connection lost', canResume: true, startedAt: 1 },
];

// 1. Light-theme palette with the selected row on the cocoa chip
await page.goto('http://localhost:4187/');
await page.evaluate(() => { localStorage.setItem('fress.theme', 'light'); localStorage.setItem('fress.lang', 'de'); });
await page.reload(); await settle(800);
await page.keyboard.press('Control+k'); await settle();
await page.keyboard.type('signal'); await settle();
await page.screenshot({ path: `${OUT}/a6-light-palette-chip.png` });
await page.keyboard.press('Escape'); await settle();

// 2. Light-theme privacy pack (emerald-800 badge, renamed triggers)
await page.locator('#page-replace-btn').click(); await settle(700);
await page.screenshot({ path: `${OUT}/a6-light-privacy.png` });
await page.locator('#page-catalog-btn').click(); await settle();

// 3. Light-theme downloads with seeded items (SHA row content-naming)
await page.evaluate((items) => localStorage.setItem('fress.downloadItems.v1', JSON.stringify(items)), SEED);
await page.reload(); await settle(800);
await page.locator('#header-downloads-btn').click(); await settle();
await page.screenshot({ path: `${OUT}/a6-light-downloads.png` });
await page.keyboard.press('Escape'); await settle();

// 4. Dark-theme header (documents Agent 1's primary-button contrast finding)
await page.evaluate(() => { localStorage.removeItem('fress.downloadItems.v1'); localStorage.setItem('fress.theme', 'dark'); });
await page.reload(); await settle(800);
await page.screenshot({ path: `${OUT}/a6-dark-header-primary.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });

await browser.close();
await server.close();
console.log('screenshots saved');
