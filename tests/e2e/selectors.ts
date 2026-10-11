// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The selector contract between the E2E suite and the frontend.
 *
 * Rules (agreed with the frontend owners - see docs/quality-gates.md):
 *  1. PREFER stable ids and documented data-testid attributes. The app
 *     already ships a deliberate id convention (`app-card-{id}`,
 *     `cat-filter-btn-{slug}`, `pp-counter-{catId}`, ...) and one testid
 *     (`download-manager-panel`).
 *  2. Otherwise use ACCESSIBLE roles/labels via the dictionaries the app
 *     itself renders from (src/lib/i18n DICTS) - never CSS classes.
 *  3. If a workflow needs a NEW stable hook, ask the component owner to add
 *     an id or data-testid; never encode styling classes here.
 */
import type { Locator, Page } from '@playwright/test';
import { DICTS, type Language } from '../../src/lib/i18n';

/** The dictionary the app will render with for a given language. */
export function dict(lang: Language = 'en'): Record<string, string> {
  return DICTS[lang];
}

export const sel = {
  // Shell / header -----------------------------------------------------
  root: '#awesome-apps-root',
  main: '#main-content',
  header: '#main-app-header',
  searchInput: '#app-search-input',
  downloadsBtn: '#header-downloads-btn',
  downloadsActiveBadge: '#downloads-active-badge',
  pageTabs: '#page-tabs',
  catalogTab: '#page-catalog-btn',
  privacyTab: '#page-replace-btn',
  viewToggle: '#view-mode-toggle',
  grid: '#apps-catalog-grid',
  table: '#apps-data-table',
  tableContainer: '#apps-table-container',

  // Cards ---------------------------------------------------------------
  card: (id: string) => `#app-card-${id}`,
  cardTitle: (id: string) => `#app-title-${id}`,
  catBadge: (id: string) => `#app-cat-badge-${id}`,
  batchCheck: (id: string) => `#batch-check-${id}`,
  tableRow: (id: string) => `#table-row-${id}`,

  // FilterBar -----------------------------------------------------------
  // Categories slug: lowercased, non-alphanumerics -> '-' (FilterBar).
  catBtn: (category: string) => `#cat-filter-btn-${category.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
  countIndicator: (layout: 'desktop' | 'mobile') => `#filter-count-indicator-${layout}`,
  platformChip: (layout: 'desktop' | 'mobile', platform: string) => `#filter-platform-${layout}-${platform}`,

  // Command palette -----------------------------------------------------
  paletteBackdrop: '#command-palette-backdrop',
  paletteModal: '#command-palette-modal',

  // Detail modal --------------------------------------------------------
  // AppDetailModal renders role="dialog" aria-label={...detailsAria...}.
  detailDialog: (page: Page, appName: string): Locator =>
    page.getByRole('dialog', { name: new RegExp(appName) }),
  detailDownloadBox: '#detail-download-box',

  // Download manager ----------------------------------------------------
  downloadsPanel: '[data-testid="download-manager-panel"]',
  downloadRows: '[data-testid="download-manager-panel"] [data-status]',
  downloadRow: (status: string) => `[data-testid="download-manager-panel"] [data-status="${status}"]`,

  // Privacy Pack (ReplaceTab) -------------------------------------------
  ppPicker: (catId: string) => `#pp-picker-${catId}`,
  ppDropdown: (catId: string) => `#pp-dropdown-${catId}`,
  ppOption: (catId: string, altId: string) => `#pp-alt-${catId}-${altId}`,
  ppCounter: (catId: string) => `#pp-counter-${catId}`,
  ppPicked: (catId: string, altId: string) => `#pp-picked-${catId}-${altId}`,
  ppGet: (catId: string, altId: string) => `#pp-get-${catId}-${altId}`,
  ppMainDropdown: (catId: string) => `#pp-main-dropdown-${catId}`,

  // Export modal --------------------------------------------------------
  exportModal: '#export-modal',

  // Batch ----------------------------------------------------------------
  // BatchActionBar floats at the bottom; it is the "batch state" surface.
  batchBar: '#floating-batch-action-bar',
};

/** Opens the command palette with Ctrl+K (the documented shortcut). */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator(sel.paletteModal).waitFor({ state: 'visible' });
}

/** Opens the download manager panel from the header button. */
export async function openDownloads(page: Page, lang: Language = 'en'): Promise<void> {
  await page
    .getByRole('button', { name: dict(lang)['header.downloads'] })
    .first()
    .click();
  await page.locator(sel.downloadsPanel).waitFor({ state: 'visible' });
}

/** Wait until the app has no pending network activity it initiated itself. */
export async function networkIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {
    /* the abort policy can keep long-poll-less pages busy-free; ignore */
  });
}
