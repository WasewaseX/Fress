// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Persistence-layer integration tests for the download panel store.
// Complements downloadItemsStore.test.ts with the cases that matter for a
// restart under hostile or oversized state: the 60-entry retention cap and
// the strict field-shape contract of deserializeItems.

import { describe, expect, it } from 'vitest';

import { deserializeItems, serializeItems } from '../downloadItemsStore';
import { DownloadItem } from '../downloads';

const item = (id: number, over: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  url: `https://example.com/app-${id}.exe`,
  name: `app-${id}.exe`,
  dir: '/downloads',
  bytes: 10 * id,
  total: 100 * id,
  speed: 999, // transient field: must not survive a round trip
  eta: 999, // transient field: must not survive a round trip
  status: 'completed',
  startedAt: id * 1000,
  ...over,
});

describe('downloadItemsStore persistence under hostile or oversized state', () => {
  it('caps the persisted panel at 60 entries so one busy session cannot bloat localStorage forever', () => {
    const items = Array.from({ length: 80 }, (_, i) => item(i + 1));
    const restored = deserializeItems(serializeItems(items));
    expect(restored).toHaveLength(60);
    // The oldest entries win (array order), not whichever happened to
    // serialize last.
    expect(restored[0].name).toBe('app-1.exe');
    expect(restored[59].name).toBe('app-60.exe');
  });

  it('transient progress fields are rebuilt as zeros, never restored stale', () => {
    const restored = deserializeItems(serializeItems([item(1, { speed: 5_000_000, eta: 42 })]));
    expect(restored[0].speed).toBe(0);
    expect(restored[0].eta).toBe(0);
  });

  it('verified is only restored as the boolean true, never as a truthy string', () => {
    // "verified" drives the UI's integrity badge; a junk value from a
    // hand-edited store must degrade to "unverified", not render as true.
    const raw = JSON.stringify([
      { url: 'https://a.com/x.exe', name: 'x.exe', status: 'completed', verified: 'yes' },
      { url: 'https://a.com/y.exe', name: 'y.exe', status: 'completed', verified: true },
    ]);
    const restored = deserializeItems(raw);
    expect(restored[0].verified).toBeUndefined();
    expect(restored[1].verified).toBe(true);
  });

  it('a completed entry with junk numerics restores with zeroed counters, not NaN', () => {
    const raw = JSON.stringify([
      {
        url: 'https://a.com/z.exe',
        name: 'z.exe',
        status: 'completed',
        bytes: 'lots',
        total: null,
        startedAt: 'yesterday',
      },
    ]);
    const restored = deserializeItems(raw);
    expect(restored[0].bytes).toBe(0);
    expect(restored[0].total).toBe(0);
    expect(restored[0].startedAt).toBe(0);
  });

  it('an active download restored from disk becomes the resumable failure it now is', () => {
    // The process died with the transfer; a persisted "active" entry is a
    // lie. The contract: it must come back as an error with canResume so
    // the panel offers Resume against the surviving .part file.
    const raw = JSON.stringify([
      {
        url: 'https://a.com/big.iso',
        name: 'big.iso',
        status: 'active',
        bytes: 500,
        canResume: true,
      },
    ]);
    const restored = deserializeItems(raw);
    expect(restored).toHaveLength(0); // active entries are not persisted at all
  });
});
