// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { DownloadItem } from './downloads';

/**
 * Screen-reader summary for the download manager.
 *
 * The panel's visual list conveys progress, but nothing in it is announced
 * as it changes. A visually-hidden aria-live region renders this summary so
 * "2 downloading, 1 completed, 1 failed" (and every change to it) is
 * announced politely by screen readers - covering the failure case too,
 * where the red row and the error text mean nothing to a non-sighted user.
 *
 * Pure function so the wording and state mapping are unit-testable without
 * a DOM environment.
 *
 * The optional translator receives the downloads.a11y.* keys with {count} /
 * {list} params; without one the English fallback is byte-identical to the
 * pre-i18n wording (pinned by the existing unit tests).
 */
export function summarizeDownloadStates(
  items: DownloadItem[],
  translate?: (key: string, params?: Record<string, string | number>) => string
): string {
  let active = 0;
  let queued = 0;
  let completed = 0;
  let failed = 0;
  for (const it of items) {
    if (it.status === 'active') active++;
    else if (it.status === 'queued') queued++;
    else if (it.status === 'completed') completed++;
    else if (it.status === 'error' || it.status === 'cancelled') failed++;
  }
  const bit = (n: number, key: string, en: string): string =>
    translate ? translate(key, { count: n }) : en.replace('{count}', String(n));
  const bits: string[] = [];
  if (active > 0) bits.push(bit(active, 'downloads.a11y.summaryDownloading', '{count} downloading'));
  if (queued > 0) bits.push(bit(queued, 'downloads.a11y.summaryQueued', '{count} queued'));
  if (completed > 0) bits.push(bit(completed, 'downloads.a11y.summaryCompleted', '{count} completed'));
  if (failed > 0) bits.push(bit(failed, 'downloads.a11y.summaryFailed', '{count} failed'));
  if (bits.length === 0) return translate ? translate('downloads.a11y.summaryEmpty') : 'Downloads';
  return translate
    ? translate('downloads.a11y.summary', { list: bits.join(', ') })
    : `Downloads: ${bits.join(', ')}`;
}
