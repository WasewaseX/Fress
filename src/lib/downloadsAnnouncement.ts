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
 */
export function summarizeDownloadStates(items: DownloadItem[]): string {
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
  const bits: string[] = [];
  if (active > 0) bits.push(`${active} downloading`);
  if (queued > 0) bits.push(`${queued} queued`);
  if (completed > 0) bits.push(`${completed} completed`);
  if (failed > 0) bits.push(`${failed} failed`);
  if (bits.length === 0) return 'Downloads';
  return `Downloads: ${bits.join(', ')}`;
}
