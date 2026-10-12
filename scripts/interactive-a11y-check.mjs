/**
 * Agent 2 final acceptance — interactive keyboard/AT verification (Chromium).
 * Real key events against the dev server; prints PASS/FAIL per check.
 * Covers: palette full keyboard flow (de/fa), activedescendant sync,
 * contextual copy control, stacked-modal Escape + focus restore, RTL flip,
 * Privacy dropdown keyboard flow, long-German-string overflow checks.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = '/home/z/my-project/fress';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

const server = await createServer({ root: ROOT, server: { port: 4175 } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const settle = (ms = 350) => page.waitForTimeout(ms);

async function setLang(code) {
  await page.evaluate((c) => localStorage.setItem('fress.lang', c), code);
  await page.reload();
  await settle(600);
}

// ---------- German palette flow ----------
await page.goto('http://localhost:4175/');
await setLang('de');

await page.keyboard.press('Control+k');
await settle();
ok('de: palette opens via Ctrl+K', await page.locator('#command-palette-modal').isVisible());
ok('de: dialog named by visible heading', await page.evaluate(() =>
  document.getElementById('command-palette-title')?.textContent === 'Befehlspalette'));
ok('de: combobox references list', await page.evaluate(() =>
  document.getElementById('command-palette-input')?.getAttribute('aria-controls') === 'command-palette-list'));

// localized discovery
await page.keyboard.type('vergleichen');
await settle();
const firstOptionId = await page.evaluate(() =>
  document.querySelector('#command-palette-list [role="option"]')?.id);
ok('de: localized action discovery (vergleichen)', firstOptionId === 'palette-item-act-compare', firstOptionId);
ok('de: activedescendant follows first result', await page.evaluate(
  (id) => document.getElementById('command-palette-input')?.getAttribute('aria-activedescendant') === id,
  firstOptionId
));

// arrows move + exactly one aria-selected
await page.keyboard.press('ArrowDown');
ok('de: ArrowDown moves activedescendant + selection sync', await page.evaluate(() => {
  const input = document.getElementById('command-palette-input');
  const active = input?.getAttribute('aria-activedescendant');
  const opts = [...document.querySelectorAll('#command-palette-list [role="option"]')];
  const selected = opts.filter((o) => o.getAttribute('aria-selected') === 'true');
  return active && selected.length === 1 && selected[0].id === active;
}));

// contextual copy control appears for app rows; type app name
await page.keyboard.press('Backspace');
await page.keyboard.type('x');
await page.keyboard.press('Backspace');
await settle();
await page.fill('#command-palette-input', '');
await page.keyboard.type('signal');
await settle();
const ctxLabel = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#command-palette-modal button')];
  return btns.map((b) => b.textContent || '').find((t) => t.includes('Installationsbefehl'));
});
ok('de: contextual copy control names highlighted app', Boolean(ctxLabel), (ctxLabel || '').slice(0, 60));

// Escape closes one layer + focus restore (opener = body here, focus must leave dialog)
await page.keyboard.press('Escape');
await settle();
ok('de: Escape closes palette', !(await page.locator('#command-palette-modal').isVisible().catch(() => false)));

// Stacked: detail modal -> palette -> Escape closes ONLY palette
const detailBtn = page.locator('[id^="view-guide-btn-"]').first();
await detailBtn.click();
await settle();
ok('de: detail modal opens', await page.locator('[role="dialog"][aria-modal="true"]').first().isVisible());
await page.keyboard.press('Control+k');
await settle();
ok('de: palette stacks over detail', await page.locator('#command-palette-modal').isVisible());
await page.keyboard.press('Escape');
await settle();
const stackAfter = await page.evaluate(() => ({
  palette: Boolean(document.getElementById('command-palette-modal')),
  dialogs: [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.getClientRects().length > 0).length,
  active: document.activeElement?.id || document.activeElement?.tagName,
}));
console.log('   stacked-after-escape state:', JSON.stringify(stackAfter));
ok('de: Escape closed only the topmost layer', !stackAfter.palette && stackAfter.dialogs >= 1);
ok('de: focus parked inside parent dialog after close', await page.evaluate(() => {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest('[role="dialog"]'));
}));

// close detail
await page.keyboard.press('Escape');
await settle();

// ---------- German long strings: footer + downloads ----------
await page.locator('#main-app-footer').scrollIntoViewIfNeeded();
await settle(200);
const footerOk = await page.evaluate(() => {
  const f = document.getElementById('main-app-footer');
  if (!f) return false;
  return document.documentElement.scrollWidth <= window.innerWidth + 1;
});
ok('de: footer long strings cause no horizontal overflow', footerOk);

// narrow viewport German
await page.setViewportSize({ width: 390, height: 800 });
await page.goto('http://localhost:4175/');
await settle(700);
ok('de @390px: no horizontal overflow (long labels)', await page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1));
await page.setViewportSize({ width: 1280, height: 900 });

// ---------- Persian RTL + privacy dropdown ----------
await setLang('fa');
ok('fa: document flips to RTL', await page.evaluate(() => document.documentElement.dir === 'rtl'));
ok('fa @1280: no horizontal overflow', await page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1));

// privacy pack keyboard flow
const privacyTab = page.locator('#page-replace-btn').first();
await privacyTab.click();
await settle(700);
const onPrivacy = await page.evaluate(() => Boolean(document.querySelector('[id^="pp-card-"]')));
if (onPrivacy) {
  const trigger = page.locator('[id^="pp-picker-"]').first();
  await trigger.click();
  await settle();
  ok('fa: privacy dropdown opens with listbox', await page.evaluate(() =>
    Boolean(document.querySelector('[id^="pp-dropdown-"]'))));
  const optCount = await page.evaluate(() =>
    document.querySelectorAll('[id^="pp-dropdown-"] [role="option"]').length);
  ok('fa: dropdown options present', optCount > 0, `${optCount} options`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settle();
  const afterActivate = await page.evaluate(() => ({
    dropdownOpen: Boolean(document.querySelector('[id^="pp-dropdown-"]')),
    active: document.activeElement?.id || document.activeElement?.tagName,
    selected: [...document.querySelectorAll('[id^="pp-dropdown-"] [role="option"]')].filter((o) => o.getAttribute('aria-selected') === 'true').length,
  }));
  // Multi-select contract: Enter toggles the option and the list STAYS open
  // (up to three alternatives per category); focus remains on the option.
  ok('fa: Enter toggles option, multi-select stays open, selection marked',
    afterActivate.dropdownOpen && afterActivate.selected === 1, JSON.stringify(afterActivate));
  await page.keyboard.press('Escape');
  await settle();
  const afterEscape = await page.evaluate(() => ({
    dropdownOpen: Boolean(document.querySelector('[id^="pp-dropdown-"]')),
    active: document.activeElement?.id || document.activeElement?.tagName,
  }));
  ok('fa: Escape closes dropdown; focus back on trigger',
    !afterEscape.dropdownOpen && afterEscape.active.startsWith('pp-picker-'), JSON.stringify(afterEscape));
  const counter = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((s) => /از ۳|از 3/.test(s.textContent || '') && s.className.includes('sr-only'));
    return el ? el.textContent : null;
  });
  ok('fa: localized selected-count sentence present', Boolean(counter), counter || '');
} else {
  ok('fa: privacy pack reachable', false, 'no pp cards found');
}

// fa narrow RTL overflow
await page.setViewportSize({ width: 390, height: 800 });
await page.goto('http://localhost:4175/');
await settle(700);
ok('fa @390px RTL: no horizontal overflow', await page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1));

console.log(`\npage errors: ${errors.length ? errors.join(' | ') : 'none'}`);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
await server.close();
process.exit(fail ? 1 : 0);
