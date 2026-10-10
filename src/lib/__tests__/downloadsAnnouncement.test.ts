// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import { summarizeDownloadStates } from '../downloadsAnnouncement';
import { DownloadItem } from '../downloads';

const item = (over: Partial<DownloadItem>): DownloadItem => ({
  id: 1,
  url: 'https://example.com/a.exe',
  name: 'a.exe',
  dir: '',
  bytes: 0,
  total: 0,
  speed: 0,
  eta: 0,
  status: 'active',
  startedAt: 1,
  ...over,
});

describe('summarizeDownloadStates, screen-reader announcements', () => {
  it('counts active, completed and failed downloads', () => {
    const summary = summarizeDownloadStates([
      item({ id: 1, status: 'active' }),
      item({ id: 2, status: 'active' }),
      item({ id: 3, status: 'completed' }),
      item({ id: 4, status: 'error', error: 'boom' }),
      item({ id: 5, status: 'cancelled' }),
      item({ id: 6, status: 'queued' }),
    ]);
    expect(summary).toBe('Downloads: 2 downloading, 1 queued, 1 completed, 2 failed');
  });

  it('treats failures (error and cancelled) as announced failures', () => {
    const summary = summarizeDownloadStates([
      item({ id: 1, status: 'error' }),
      item({ id: 2, status: 'cancelled' }),
    ]);
    expect(summary).toContain('2 failed');
  });

  it('returns a neutral sentence when nothing is tracked', () => {
    expect(summarizeDownloadStates([])).toBe('Downloads');
  });

  it('never mentions zero-count groups (no noise on every tick)', () => {
    const summary = summarizeDownloadStates([item({ status: 'completed' })]);
    expect(summary).toBe('Downloads: 1 completed');
  });

  it('ignores passthrough entries (page/browser) that are not our transfers', () => {
    const summary = summarizeDownloadStates([
      item({ id: 1, status: 'page' }),
      item({ id: 2, status: 'browser' }),
      item({ id: 3, status: 'completed' }),
    ]);
    expect(summary).toBe('Downloads: 1 completed');
  });
});

describe('summarizeDownloadStates with a translator (i18n)', () => {
  const fakeT = (key: string, params?: Record<string, string | number>): string => {
    const dict: Record<string, string> = {
      'downloads.a11y.summary': 'Descargas: {list}',
      'downloads.a11y.summaryDownloading': '{count} descargando',
      'downloads.a11y.summaryQueued': '{count} en cola',
      'downloads.a11y.summaryCompleted': '{count} completada',
      'downloads.a11y.summaryFailed': '{count} fallida',
      'downloads.a11y.summaryEmpty': 'Descargas',
    };
    let s: string = dict[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
    return s;
  };

  it('interpolates {count} and {list} through the translator', () => {
    const summary = summarizeDownloadStates([
      item({ id: 1, status: 'active' }),
      item({ id: 2, status: 'active' }),
      item({ id: 3, status: 'queued' }),
      item({ id: 4, status: 'completed' }),
      item({ id: 5, status: 'error' }),
      item({ id: 6, status: 'cancelled' }),
    ], fakeT);
    expect(summary).toBe('Descargas: 2 descargando, 1 en cola, 1 completada, 2 fallida');
  });

  it('never mentions zero-count groups through the translator either', () => {
    const summary = summarizeDownloadStates([item({ status: 'completed' })], fakeT);
    expect(summary).toBe('Descargas: 1 completada');
  });

  it('uses the translated empty sentence when nothing is tracked', () => {
    expect(summarizeDownloadStates([], fakeT)).toBe('Descargas');
  });

  it('hands the translator numbers for {count} and a string for {list}', () => {
    const seen: Array<Record<string, string | number> | undefined> = [];
    summarizeDownloadStates([item({ status: 'active' }), item({ status: 'completed' })], (key, params) => {
      seen.push(params);
      return fakeT(key, params);
    });
    expect(seen[0]).toEqual({ count: 1 });
    // {list} carries the already-translated bits, joined with ', '
    expect(seen[2]).toEqual({ list: '1 descargando, 1 completada' });
  });
});
