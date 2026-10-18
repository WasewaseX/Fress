// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';
import { ReleaseInfo } from './types';
import { getLatestViaAtom, getReleasesViaAtom } from './atomReleases';

/**
 * GitHub Releases provider: talks to the GitHub REST API through the Tauri
 * `fetch_latest_release` / `fetch_recent_releases` commands in the desktop
 * app, or plain fetch in the browser. Knows nothing about asset matching -
 * it only delivers normalized ReleaseInfo shapes.
 *
 * RATE-LIMIT-PROOF FALLBACK: api.github.com's unauthenticated quota is
 * 60 req/h per IP, shared with the live-star refresh, and when it is
 * exhausted every catalog lookup used to fail with "the download sources
 * could not be reached". Both functions therefore fall back to GitHub's
 * own quota-free web documents (releases.atom + expanded_assets fragments,
 * see atomReleases.ts) whenever the API call fails for a reason OTHER than
 * the honest "no stable release found" 404 - a repo with no releases at
 * all would gain nothing from the feed and must not spend requests on it.
 * If the fallback also fails, the ORIGINAL error is rethrown unchanged so
 * resolve.ts's failure classification (rate-limit vs network vs api) and
 * the UI's retry affordances keep working exactly as before.
 */

interface GhReleaseRaw {
  tag: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; download_url: string }[];
}

async function fetchLatestReleaseViaApi(repo: string): Promise<ReleaseInfo> {
  if (isTauri()) {
    const r = await invoke<GhReleaseRaw>('fetch_latest_release', { repo });
    return {
      tag: r.tag,
      name: r.name,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloadUrl: a.download_url })),
    };
  }
  const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (resp.status === 404) throw new Error('No stable release found');
  if (resp.status === 403 || resp.status === 429) throw new Error('GitHub rate limit reached');
  if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
  const d = await resp.json();
  return {
    tag: d.tag_name || '',
    name: d.name || d.tag_name || '',
    publishedAt: d.published_at || '',
    htmlUrl: d.html_url || `https://github.com/${repo}/releases`,
    assets: (d.assets || []).map((a: { name: string; size: number; browser_download_url: string }) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  };
}

export async function getLatestRelease(repo: string): Promise<ReleaseInfo> {
  try {
    return await fetchLatestReleaseViaApi(repo);
  } catch (e) {
    // The honest 404 ("this repo has no stable release") is an ANSWER, not
    // a failure: the atom fallback cannot improve it (the feed of a
    // release-less repo is empty too) and probing it would waste requests
    // on every release-less mirror. Everything else - rate limit, network,
    // API 5xx - is worth one quota-free second opinion.
    const msg = (e as Error).message || '';
    if (/no stable release/i.test(msg)) throw e;
    try {
      const viaAtom = await getLatestViaAtom(repo, false);
      if (viaAtom) return viaAtom;
    } catch {
      // Fallback dead: keep the original, already-classified API error.
    }
    throw e;
  }
}

/** How far the recent-releases scan reaches. Multi-stream repos (desktop +
 * mobile + server tags from one repo: Obsidian, Tuta, Ente) need roughly a
 * dozen entries before the right stream shows up; 20 covers every repo in
 * the catalog with one API call. */
const RECENT_RELEASES_COUNT = 20;

interface GhReleaseListRaw {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

async function fetchRecentReleasesViaApi(
  repo: string,
  count: number,
  includeFlagged: boolean
): Promise<ReleaseInfo[]> {
  if (isTauri()) {
    const r = await invoke<GhReleaseRaw[]>('fetch_recent_releases', { repo, count, includeFlagged });
    return (r || []).map((rel) => ({
      tag: rel.tag,
      name: rel.name,
      publishedAt: rel.published_at,
      htmlUrl: rel.html_url,
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, downloadUrl: a.download_url })),
    }));
  }
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=${count}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  if (resp.status === 404) throw new Error('No stable release found');
  if (resp.status === 403 || resp.status === 429) throw new Error('GitHub rate limit reached');
  if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
  const d: GhReleaseListRaw[] = await resp.json();
  const list = Array.isArray(d) ? d : [];
  // Some projects flag their own stable builds as prereleases (DevToys has
  // never shipped an unflagged release). Only a catalog entry that vouches
  // for that repo may include them.
  const stable = includeFlagged ? list : list.filter((r) => r.prerelease !== true);
  return stable.map((r) => ({
    tag: r.tag_name || '',
    name: r.name || r.tag_name || '',
    publishedAt: r.published_at || '',
    htmlUrl: r.html_url || `https://github.com/${repo}/releases`,
    assets: (r.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  }));
}

export async function getRecentReleases(
  repo: string,
  count: number,
  includeFlagged = false
): Promise<ReleaseInfo[]> {
  try {
    return await fetchRecentReleasesViaApi(repo, count, includeFlagged);
  } catch (e) {
    // Same contract as getLatestRelease: the honest 404 is an answer, not
    // a failure; everything else earns one quota-free second opinion. The
    // atom list carries its own stage filter (the feed has no prerelease
    // flag), and an empty/unusable feed rethrows the ORIGINAL error below.
    const msg = (e as Error).message || '';
    if (/no stable release/i.test(msg)) throw e;
    try {
      const viaAtom = await getReleasesViaAtom(repo, count, includeFlagged);
      if (viaAtom.length > 0) return viaAtom;
    } catch {
      // Fallback dead: keep the original, already-classified API error.
    }
    throw e;
  }
}

/** Exposed for tests and callers that want the scan depth without the
 * magic number. */
export { RECENT_RELEASES_COUNT };
