// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Concurrency gate for the download manager.
 *
 * A batch download used to fire every file at the network at once: thirty
 * selected apps meant thirty parallel streams fighting for bandwidth (and
 * on the mobile connections this app's users often have, each one crawling).
 * Real download managers keep a small number of active transfers and hold
 * the rest in a FIFO queue; this helper is that queue, kept as pure logic
 * so it can be unit-tested without React or Tauri.
 */

/** How many transfers run at once. 3 is the classic download-manager
 * default: enough parallelism to keep slow per-connection servers busy,
 * few enough that one connection still gets a useful share. */
export const MAX_CONCURRENT_DOWNLOADS = 3;

/** One waiting download, exactly what startDownload received. */
export interface QueuedDownload {
  url: string;
  name?: string;
  opts?: { expectedSha256?: string; resume?: boolean; dir?: string | null };
}

export class DownloadQueue {
  private items: QueuedDownload[] = [];
  /** Monotonic ticket for dedupe: the same (url, name) pair may not be
   * enqueued twice while it is still waiting. */
  private byKey = new Set<string>();

  /** How many downloads are waiting. */
  get size(): number {
    return this.items.length;
  }

  private keyOf(q: QueuedDownload): string {
    return `${q.url}|${q.opts?.dir ?? ''}`;
  }

  /** Enqueue unless the same target is already waiting. Returns false when
   * deduplicated (the item is already in line). */
  push(q: QueuedDownload): boolean {
    const k = this.keyOf(q);
    if (this.byKey.has(k)) return false;
    this.byKey.add(k);
    this.items.push(q);
    return true;
  }

  /** Next download to start, or null when the queue is empty. */
  shift(): QueuedDownload | null {
    const q = this.items.shift() ?? null;
    if (q) this.byKey.delete(this.keyOf(q));
    return q;
  }

  /** Remove every waiting download matching a predicate (used when the user
   * cancels a queued entry or clears the panel). Returns how many went. */
  removeWhere(pred: (q: QueuedDownload) => boolean): number {
    const before = this.items.length;
    this.items = this.items.filter((q) => {
      if (pred(q)) {
        this.byKey.delete(this.keyOf(q));
        return false;
      }
      return true;
    });
    return before - this.items.length;
  }

  clear(): void {
    this.items = [];
    this.byKey.clear();
  }
}
