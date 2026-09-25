// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Persistence for the download panel.
 *
 * The .part files a download leaves behind survive an app restart, but the
 * panel used to forget every entry the moment the window closed: a big
 * installer paused or interrupted yesterday could not be resumed today
 * because nothing in the UI referenced it any more. The panel now persists
 * its entries to localStorage and restores them on launch.
 *
 * Rules the restore follows:
 *   - completed / error / cancelled / page entries come back as they were,
 *     with fresh NEGATIVE ids (Rust hands out positive ids from 0 each
 *     launch; a restored positive id could collide with a new download's).
 *   - active entries cannot survive: the transfer died with the process.
 *     They come back as errors with canResume, which is the truth: the
 *     .part file is on disk and Resume picks up from it.
 *   - queued / browser entries are dropped; they had no progress to keep.
 */

import { DownloadItem } from './downloads';

const ITEMS_KEY = 'fress.downloadItems.v1';
const MAX_PERSISTED = 60;

/** The slice of a download item worth keeping across restarts. */
export function serializeItems(items: DownloadItem[]): string {
  const keep = items
    .filter(
      (it) =>
        it.status === 'completed' ||
        it.status === 'error' ||
        it.status === 'cancelled' ||
        it.status === 'page'
    )
    .slice(0, MAX_PERSISTED)
    .map((it) => ({
      url: it.url,
      name: it.name,
      dir: it.dir,
      bytes: it.bytes,
      total: it.total,
      status: it.status,
      error: it.error,
      path: it.path,
      sha256: it.sha256,
      verified: it.verified,
      canResume: it.canResume,
      startedAt: it.startedAt,
    }));
  try {
    return JSON.stringify(keep);
  } catch {
    return '[]';
  }
}

/** Restore persisted entries. A corrupted store degrades to an empty panel,
 * never to a crash. Ids are re-assigned by the caller (it owns the counter). */
export function deserializeItems(raw: string | null): Array<Omit<DownloadItem, 'id'>> {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<DownloadItem>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (it) =>
          it &&
          typeof it.url === 'string' &&
          /^https?:\/\//i.test(it.url) &&
          typeof it.name === 'string' &&
          (it.status === 'completed' ||
            it.status === 'error' ||
            it.status === 'cancelled' ||
            it.status === 'page')
      )
      .map((it) => ({
        url: it.url as string,
        name: it.name as string,
        dir: typeof it.dir === 'string' ? it.dir : '',
        bytes: typeof it.bytes === 'number' ? it.bytes : 0,
        total: typeof it.total === 'number' ? it.total : 0,
        // A download that was running when the app closed died with the
        // process. Restore it as the failure it now is, resumable.
        status: it.status === 'completed' ? 'completed' : it.status,
        error: typeof it.error === 'string' ? it.error : undefined,
        path: typeof it.path === 'string' ? it.path : undefined,
        sha256: typeof it.sha256 === 'string' ? it.sha256 : undefined,
        verified: it.verified === true ? true : undefined,
        canResume: it.canResume === true ? true : undefined,
        startedAt: typeof it.startedAt === 'number' ? it.startedAt : 0,
        speed: 0,
        eta: 0,
      })) as Array<Omit<DownloadItem, 'id'>>;
  } catch {
    return [];
  }
}

export const DOWNLOAD_ITEMS_KEY = ITEMS_KEY;
