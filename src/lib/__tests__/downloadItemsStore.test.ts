// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';
import { serializeItems, deserializeItems } from '../downloadItemsStore';
import { DownloadItem } from '../downloads';

const item = (over: Partial<DownloadItem>): DownloadItem => ({
  id: 1,
  url: 'https://example.com/app.exe',
  name: 'app.exe',
  dir: '/downloads',
  bytes: 0,
  total: 0,
  speed: 0,
  eta: 0,
  status: 'completed',
  startedAt: 1,
  ...over,
});

describe('downloadItemsStore — the panel survives an app restart', () => {
  it('keeps completed, failed, cancelled and page entries; drops transient ones', () => {
    const items = [
      item({ id: 1, status: 'completed', path: '/downloads/app.exe' }),
      item({ id: 2, status: 'error', error: 'boom', canResume: true }),
      item({ id: 3, status: 'cancelled', canResume: true }),
      item({ id: -4, status: 'page', url: 'https://example.com/page' }),
      item({ id: 5, status: 'active' }), // in-flight: cannot survive
      item({ id: -6, status: 'queued' }), // never started: nothing to keep
      item({ id: -7, status: 'browser' }), // browser tab: not ours
    ];
    const restored = deserializeItems(serializeItems(items));
    expect(restored.map((it) => it.status).sort()).toEqual(['cancelled', 'completed', 'error', 'page']);
  });

  it('a restored entry carries everything Resume and Open need', () => {
    const restored = deserializeItems(
      serializeItems([
        item({ status: 'cancelled', canResume: true, sha256: 'abc', bytes: 500, total: 1000 }),
      ])
    );
    expect(restored[0]).toMatchObject({
      url: 'https://example.com/app.exe',
      name: 'app.exe',
      dir: '/downloads',
      bytes: 500,
      total: 1000,
      status: 'cancelled',
      canResume: true,
      sha256: 'abc',
    });
  });

  it('trusted expected hashes survive the restart so Resume still verifies', () => {
    const restored = deserializeItems(
      serializeItems([
        item({
          status: 'cancelled',
          canResume: true,
          expectedSha256: 'a'.repeat(64),
          expectedSha512: 'b'.repeat(128),
        }),
        // An item that never had a trusted hash stays without one: absent
        // must round-trip as absent, never as an empty-string "hash".
        item({ status: 'error', canResume: true }),
      ])
    );
    expect(restored[0].expectedSha256).toBe('a'.repeat(64));
    expect(restored[0].expectedSha512).toBe('b'.repeat(128));
    expect(restored[1].expectedSha256).toBeUndefined();
    expect(restored[1].expectedSha512).toBeUndefined();
  });

  it('the wire filename hint survives the restart; an absent hint stays absent', () => {
    // Retry after a restart must re-send what the ORIGINAL start sent to
    // Rust - not the display fallback word, which would rename the retried
    // file on disk (a requested name outranks Content-Disposition there).
    const restored = deserializeItems(
      serializeItems([
        item({ status: 'error', canResume: true, name: 'Setup.exe', filename: 'Setup.exe' }),
        // Absent must round-trip as absent, never as an empty-string hint.
        item({ status: 'error', canResume: true, name: 'Download' }),
      ])
    );
    expect(restored[0].filename).toBe('Setup.exe');
    expect(restored[1].filename).toBeUndefined();
  });

  it('a corrupted store degrades to an empty panel, never a crash', () => {
    expect(deserializeItems('not json at all')).toEqual([]);
    expect(deserializeItems('{"url": "oops"}')).toEqual([]);
    expect(deserializeItems(null)).toEqual([]);
  });

  it('junk entries in the store are dropped, good ones survive', () => {
    const raw = JSON.stringify([
      { url: 'ftp://bad', name: 'x', status: 'completed' },
      { url: 'https://ok.com/a.exe', name: 'a.exe', status: 'completed', path: '/a.exe' },
      { url: 'https://ok.com/b.exe' }, // no name, no status
    ]);
    const restored = deserializeItems(raw);
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('a.exe');
    expect(restored[0].path).toBe('/a.exe');
  });

  it('round-trips without losing the entries it keeps', () => {
    const items = [
      item({ id: 9, status: 'completed', path: '/downloads/x.exe' }),
      item({ id: 11, status: 'error', error: 'cut short', canResume: true }),
    ];
    const once = deserializeItems(serializeItems(items));
    const twice = deserializeItems(serializeItems(once.map((it, i) => ({ ...it, id: -i - 1 }))));
    expect(twice).toEqual(once);
  });
});
