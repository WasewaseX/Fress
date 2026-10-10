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
