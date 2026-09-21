// Live star counts, kept honest.
//
// The curated numbers in appsData were hand-entered and drifted out of date
// (some badly). This module asks GitHub/GitLab for the real number and hands
// the caller the live value. Anything that fails (offline, rate limit, weird
// host) returns null and the UI keeps showing the stored number, which is
// itself synced against the live APIs at release time, so nothing on screen
// is invented.
//
// GitHub allows 60 anonymous requests per hour per IP, and a catalog this
// size would burn that in one session. Two things keep every refresh live:
//   1. Conditional requests (If-None-Match + ETag). A 304 answer costs zero
//      quota, so re-checking an unchanged repo is always allowed.
//   2. Detection of the per-hour quota running dry: we stop early instead of
//      hammering, and keep the last known-good number on screen.

import { useEffect, useState } from 'react';

const CACHE_KEY = 'fress.stars.v1';
const ETAG_KEY = 'fress.stars.etags.v1';
const TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry { n: number; t: number; e?: string }
type Cache = Record<string, CacheEntry>;

export interface RepoKey {
  kind: 'github' | 'gitlab';
  /** api url to hit */
  api: string;
  /** stable cache key */
  key: string;
}

/** Works out which API can report stars for a project URL. */
export function parseRepoUrl(url?: string): RepoKey | null {
  if (!url) return null;
  const gh = url.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (gh) {
    const key = `gh:${gh[1]}/${gh[2]}`.toLowerCase();
    return { kind: 'github', api: `https://api.github.com/repos/${gh[1]}/${gh[2]}`, key };
  }
  const gl = url.match(/^(https?:\/\/[^/]+)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?\/?$/);
  // GitLab forges: gitlab.com and the self-hosted instances the catalog links to
  if (gl && /gitlab|videolan/.test(gl[1])) {
    const key = `gl:${gl[1]}${gl[2]}`.toLowerCase();
    const path = encodeURIComponent(gl[2]);
    return { kind: 'gitlab', api: `${gl[1]}/api/v4/projects/${path}`, key };
  }
  return null;
}

function readStore(key: string): Cache {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Cache;
  } catch {
    return {};
  }
}

function readCache(): Cache {
  return readStore(CACHE_KEY);
}

function readEtags(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ETAG_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCache(key: string, n: number, etag?: string) {
  try {
    const cache = readCache();
    cache[key] = { n, t: Date.now(), ...(etag ? { e: etag } : {}) } as CacheEntry;
    // keep the cache small: drop entries older than 30 days when it grows past 300
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      for (const k of keys) {
        if (Date.now() - cache[k].t > 30 * TTL_MS) delete cache[k];
      }
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable: live fetches simply won't persist
  }
}

// One in-flight request per repo, no matter how many cards ask at once.
const inflight = new Map<string, Promise<number | null>>();

/**
 * Live count for a repo URL, or null when the forge can't be queried.
 * Used by the Add-app form to prefill the star field with the real value.
 */
export async function fetchLiveStarCount(url?: string): Promise<number | null> {
  const repo = parseRepoUrl(url);
  return repo ? fetchStars(repo) : null;
}

async function fetchStars(repo: RepoKey): Promise<number | null> {
  const cached = readCache()[repo.key];
  if (cached && Date.now() - cached.t < TTL_MS) return cached.n;
  if (quotaDry) return null;
  if (inflight.has(repo.key)) return inflight.get(repo.key)!;

  const job = (async () => {
    try {
      const etags = readEtags();
      const headers: Record<string, string> = { Accept: 'application/json' };
      // A 304 reply is free on GitHub: it neither counts against the hourly
      // quota nor transfers the body, so cached repos stay cheap to re-check.
      const etag = etags[repo.key];
      if (etag) headers['If-None-Match'] = etag;

      const res = await fetch(repo.api, { headers });

      if (res.status === 304 && cached) {
        writeCache(repo.key, cached.n, etag);
        return cached.n;
      }

      // Out of quota (or throttled): give up quietly for this session. The
      // stored number stays on screen. It is release-synced, never invented.
      if (res.status === 403 || res.status === 429) {
        quotaDry = res.headers.get('x-ratelimit-remaining') === '0';
        return null;
      }
      if (!res.ok) return null;

      const json = (await res.json()) as { stargazers_count?: number; star_count?: number };
      const n = repo.kind === 'github' ? json.stargazers_count : json.star_count;
      if (typeof n !== 'number') return null;

      const newEtag = res.headers.get('ETag') || undefined;
      if (newEtag) {
        etags[repo.key] = newEtag;
        try { localStorage.setItem(ETAG_KEY, JSON.stringify(etags)); } catch { /* ignore */ }
      }
      writeCache(repo.key, n, newEtag);
      return n;
    } catch {
      return null;
    } finally {
      inflight.delete(repo.key);
    }
  })();
  inflight.set(repo.key, job);
  return job;
}

// Flipped for the rest of the session once GitHub reports the hourly quota
// as spent; avoids 50 doomed requests on a rate-limited connection.
let quotaDry = false;

/**
 * Returns the live star count for the app's repo, or null while loading /
 * when the repo can't be queried (caller keeps the stored value then).
 */
export function useLiveStars(githubUrl?: string): number | null {
  const repo = parseRepoUrl(githubUrl);
  const [stars, setStars] = useState<number | null>(() => {
    if (!repo) return null;
    const cached = readCache()[repo.key];
    return cached && Date.now() - cached.t < TTL_MS ? cached.n : null;
  });

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    void fetchStars(repo).then((n) => {
      if (alive && n != null) setStars(n);
    });
    return () => {
      alive = false;
    };
    // repo.key is stable per url string
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.key]);

  return stars;
}

/**
 * Formatting shared by card, table, search results and detail views.
 * Mirrors github.com's own convention (19.6k, 950) so a live number never
 * looks rounded into a lie: a 940-star repo must not read as "1k".
 */
export function formatStarCount(stars: number): string {
  if (stars >= 1000) {
    const k = stars / 1000;
    const label = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `${label.replace(/\.0$/, '')}k`;
  }
  return stars.toString();
}
