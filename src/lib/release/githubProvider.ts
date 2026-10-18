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
 * SOURCE PRIORITY (the quota is the scarce resource - spend it last):
 *
 * DESKTOP (Tauri): the quota-free github.com documents (releases.atom +
 * expanded_assets fragments, see atomReleases.ts) answer FIRST. They are
 * CDN-served static files - verified live at <1s with the API's hourly
 * quota fully exhausted - so the common lookup costs ZERO api.github.com
 * requests and cannot die with "No download was started: the download
 * sources could not be reached". The REST API runs only when the atom
 * path cannot answer (feed unreachable, or entries exist but none yielded
 * assets within the fragment budget - fragment hiccups and missing sizes
 * must not degrade the pick) and then provides the EXACT document:
 * authoritative prerelease flags, byte-exact sizes, the full asset list.
 *
 * BROWSER: github.com does not answer CORS, so the webview build keeps
 * the API-first order (unchanged historical behavior); the atom documents
 * remain the fallback for environments where the API fails.
 *
 * If every attempted source fails, the ORIGINAL API error is rethrown
 * unchanged so resolve.ts's failure classification (rate-limit vs network
 * vs api) and the UI's retry affordances keep working exactly as before.
 */

interface GhReleaseRaw {
  tag: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; download_url: string }[];
}

/** Browser-path API cap. A hung api.github.com connection used to stall a
 * user's Download click indefinitely (no timeout on a bare fetch); with
 * the timeout the lookup degrades to the next source instead. The native
 * command path has its own production timing (api_resilience). */
const BROWSER_API_TIMEOUT_MS = 20_000;

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
    signal: AbortSignal.timeout(BROWSER_API_TIMEOUT_MS),
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
  if (isTauri()) {
    // Desktop: quota-free documents FIRST. Two outcomes hand the decision
    // to the API below: the feed/fragments are unreachable (network), or
    // the feed parsed but no stable entry carried assets within the
    // fragment budget (inconclusive - the API owns the exact answer:
    // authoritative prerelease flags, byte-exact sizes, full asset list).
    try {
      const viaAtom = await getLatestViaAtom(repo, false);
      if (viaAtom) return viaAtom;
    } catch {
      // Feed unreachable: the API attempt below may still answer.
    }
    // The API owns the exact answer (authoritative prerelease flags,
    // byte-exact sizes, full asset list) and the honest 404 - whatever it
    // throws here is the lookup's classified final state.
    return await fetchLatestReleaseViaApi(repo);
  }
  // Browser: github.com documents are CORS-blocked, so the API goes first
  // and the quota-free documents remain the failure fallback (unchanged
  // historical order). The honest 404 ("this repo has no stable release")
  // is an ANSWER, not a failure: the atom fallback cannot improve it (the
  // feed of a release-less repo is empty too) and probing it would waste
  // requests on every release-less mirror. Everything else - rate limit,
  // network, API 5xx - is worth one quota-free second opinion.
  try {
    return await fetchLatestReleaseViaApi(repo);
  } catch (e) {
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
    {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(BROWSER_API_TIMEOUT_MS),
    }
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
  // The scan needs the API's depth (the atom feed carries only the newest
  // ~10 releases) and its byte-exact sizes, so the API is attempted first
  // on BOTH surfaces. On the desktop the previous atom-first
  // getLatestRelease call has usually already answered without spending a
  // single API request - the quota is available for exactly this scan.
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
