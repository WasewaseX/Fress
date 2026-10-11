// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The detail modal's resolver failure model: every lookup must settle into
// an honest state (ready / none / rate-limit / network failure), a rejected
// lookup must never stay loading, Retry re-runs ONLY the failed lookup
// through the agreed retry seam, the official-page fallbacks stay reachable
// in every failure state, and a superseded response can never update a
// dialog it no longer describes.
//
// The resolver modules are mocked at the module boundary: this suite pins
// the DIALOG's behavior, not the resolvers' (the resolver internals and
// their cache/retry behavior belong to a different owner - the dialog only
// consumes the agreed interface in src/lib/resolveRetry.ts).

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { AppDetailModal } from '../AppDetailModal';
import { AppItem } from '../../types';

vi.mock('../../lib/releaseFetch', () => ({
  resolveGitHubDownload: vi.fn(),
  resolveFdroidDownload: vi.fn(),
  parseGithubRepo: vi.fn(() => 'ente-io/ente'),
  fdroidPageUrl: vi.fn((id: string) => `https://f-droid.org/packages/${id}/`),
  playStoreUrl: vi.fn((id: string) => `https://play.google.com/store/apps/details?id=${id}`),
  githubFetchSupported: vi.fn((p: string) => p !== 'web' && p !== 'ios'),
  peekResolveError: vi.fn(() => null),
}));

vi.mock('../../lib/officialResolvers', () => ({
  officialSupported: vi.fn(() => true),
  resolveOfficialDownload: vi.fn(),
}));

vi.mock('../../lib/resolveRetry', () => ({
  resolverRetry: {
    retryGitHubResolve: vi.fn(),
    retryFdroidResolve: vi.fn(),
    retryOfficialResolve: vi.fn(),
  },
}));

vi.mock('../../lib/downloads', () => ({
  useDownloadActions: () => ({
    startDownload: vi.fn(),
    recordExternalOpen: vi.fn(),
  }),
  formatBytes: (n: number) => `${n} B`,
}));

vi.mock('../../lib/starFetch', () => ({
  useLiveStars: () => null,
}));

vi.mock('../../lib/external', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../AppCard', () => ({
  AppIcon: () => <span data-testid="app-icon" />,
}));

import {
  resolveGitHubDownload,
  resolveFdroidDownload,
  peekResolveError,
} from '../../lib/releaseFetch';
import { resolveOfficialDownload } from '../../lib/officialResolvers';
import { resolverRetry } from '../../lib/resolveRetry';

const mockedGh = vi.mocked(resolveGitHubDownload);
const mockedFd = vi.mocked(resolveFdroidDownload);
const mockedOfficial = vi.mocked(resolveOfficialDownload);
const mockedPeek = vi.mocked(peekResolveError);
const mockedRetryGh = vi.mocked(resolverRetry.retryGitHubResolve);
const mockedRetryFd = vi.mocked(resolverRetry.retryFdroidResolve);
const mockedRetryOfficial = vi.mocked(resolverRetry.retryOfficialResolve);

const HIT = {
  source: 'github' as const,
  url: 'https://github.com/ente-io/ente/releases/download/v3/auth-desktop.exe',
  filename: 'EnteAuth-Setup.exe',
  size: 10_485_760,
  version: '3.0.0',
};

const APP: AppItem = {
  id: 'ente-auth',
  name: 'Ente Auth',
  tagline: 'Authenticator',
  description: 'An authenticator app.',
  whyItsAwesome: 'Open source.',
  beginnerGuide: 'Download it.',
  githubUrl: 'https://github.com/ente-io/ente',
  websiteUrl: 'https://ente.io',
  category: 'Utilities & System',
  platforms: ['windows'],
  license: 'MIT',
  stars: 0,
  tags: [],
  beginnerRating: 'Quick Learning Curve',
} as unknown as AppItem;

function renderModal(app: AppItem | null = APP) {
  return render(
    <I18nProvider>
      <AppDetailModal app={app} onClose={() => {}} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPeek.mockReturnValue(null);
  // Retry calls must settle too - a retry that returned undefined would
  // crash the dialog's promise chain.
  mockedRetryGh.mockResolvedValue(null);
  mockedRetryFd.mockResolvedValue(null);
  mockedRetryOfficial.mockResolvedValue(null);
  // The sandbox has REAL network access; every test here must be hermetic.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test)'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppDetailModal resolver failure model', () => {
  it('ready: a resolved stable build renders the automatic download button', async () => {
    mockedGh.mockReturnValue(Promise.resolve(HIT));
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    renderModal();
    await waitFor(() => expect(screen.getByText('EnteAuth-Setup.exe')).toBeTruthy());
    // The retry/error surface is gone once a real answer arrived.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('none: an honest no-match is a status note, not an error', async () => {
    mockedGh.mockReturnValue(Promise.resolve(null));
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    renderModal();
    await waitFor(() =>
      expect(screen.getByText(/No ready-made file for this platform/i)).toBeTruthy()
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rate limit: a memoized quota failure shows the error row with Retry', async () => {
    mockedGh.mockReturnValue(Promise.resolve(null));
    mockedPeek.mockReturnValue('API rate limit exceeded');
    renderModal();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeTruthy();
  });

  it('network failure: a rejected lookup lands in the error row, never stuck loading', async () => {
    mockedGh.mockReturnValue(Promise.reject(new Error('network gone')));
    renderModal();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('Retry re-runs ONLY the failed lookup through the agreed seam', async () => {
    // GitHub is rate-limited; the official resolver answered fine.
    mockedGh.mockReturnValue(Promise.resolve(null));
    mockedPeek.mockReturnValue('API rate limit exceeded');
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    renderModal();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(mockedRetryGh).toHaveBeenCalledTimes(1));
    expect(mockedRetryGh).toHaveBeenCalledWith(APP, 'windows');
    // The healthy lookups are not re-run by one failed resolver's retry.
    expect(mockedRetryOfficial).not.toHaveBeenCalled();
    expect(mockedRetryFd).not.toHaveBeenCalled();
    // The retry goes through the seam, never straight back into the plain
    // resolver (which would read the memoized failure).
    expect(mockedGh).toHaveBeenCalledTimes(1);
  });

  it('fallbacks stay reachable while a lookup is failing', async () => {
    mockedGh.mockReturnValue(Promise.resolve(null));
    mockedPeek.mockReturnValue('API rate limit exceeded');
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    renderModal();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // The forge releases page fallback (rendered from the generic options)
    // must still be present next to the error row.
    const releasesFallback = screen.getByRole('button', { name: /releases/i });
    expect(releasesFallback).toBeTruthy();
  });

  it('a superseded response cannot update the dialog (lifecycle guard)', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    // First request (windows) hangs; the user switches platform, which
    // starts a second request that answers immediately.
    mockedGh.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }));
    mockedGh.mockImplementationOnce(() => Promise.resolve(HIT));
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    const BOTH: AppItem = { ...APP, platforms: ['windows', 'mac'] };
    renderModal(BOTH);
    expect(screen.queryByText('EnteAuth-Setup.exe')).toBeNull();

    // Switch platform: a NEW lookup generation starts and answers.
    fireEvent.click(screen.getByRole('button', { name: /macos/i }));
    await waitFor(() => expect(screen.getByText('EnteAuth-Setup.exe')).toBeTruthy());

    // The STALE windows response now lands - the dialog must ignore it (and
    // must not throw while updating).
    resolveFirst(null);
    await waitFor(() => expect(screen.getByText('EnteAuth-Setup.exe')).toBeTruthy());
  });

  it('unsupported platform lookups are not started (no row, no request)', () => {
    mockedGh.mockReturnValue(Promise.resolve(null));
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    const WEB: AppItem = { ...APP, platforms: ['web'] };
    render(
      <I18nProvider>
        <AppDetailModal app={WEB} onClose={() => {}} />
      </I18nProvider>
    );
    // githubFetchSupported('web') is false: no GitHub lookup may fire at all.
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it('a ready download is never labelled verified on its own', async () => {
    mockedGh.mockReturnValue(Promise.resolve(HIT));
    mockedOfficial.mockReturnValue(Promise.resolve(null));
    renderModal();
    await waitFor(() => expect(screen.getByText('EnteAuth-Setup.exe')).toBeTruthy());
    // No trusted hash arrived with the resolution: the DOWNLOAD section must
    // not claim verification. (The repository section's "verified open-source
    // repository" copy is about catalog vetting, not the transfer.)
    const box = document.getElementById('detail-download-box');
    expect(box).toBeTruthy();
    expect(box!.textContent ?? '').not.toMatch(/verified/i);
  });
});
