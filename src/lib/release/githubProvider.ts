// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../downloads';
import { ReleaseInfo } from './types';

/**
 * GitHub Releases provider: talks to the GitHub REST API through the Tauri
 * `fetch_latest_release` / `fetch_recent_releases` commands in the desktop
 * app, or plain fetch in the browser. Knows nothing about asset matching -
 * it only delivers normalized ReleaseInfo shapes.
 */

interface GhReleaseRaw {
  tag: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; download_url: string }[];
}

export async function getLatestRelease(repo: string): Promise<ReleaseInfo> {
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

export async function getRecentReleases(
  repo: string,
  count: number,
  includeFlagged = false
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

/** Exposed for tests and callers that want the scan depth without the
 * magic number. */
export { RECENT_RELEASES_COUNT };
