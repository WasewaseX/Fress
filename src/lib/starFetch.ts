// Live star counts, kept honest.
//
// The curated numbers in appsData were hand-entered and drifted out of date
// (some badly). This module asks GitHub/GitLab for the real number, caches it
// for 24 hours in localStorage, and hands the caller the live value. Anything
// that fails (offline, rate limit, weird host) returns null and the UI keeps
// showing the stored number — never worse than before, usually better.

import { useEffect, useState } from 'react';

const CACHE_KEY = 'fress.stars.v1';
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry { n: number; t: number }
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

function readCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Cache;
  } catch {
    return {};
  }
}

function writeCache(key: string, n: number) {
  try {
    const cache = readCache();
    cache[key] = { n, t: Date.now() };
    // keep the cache small: drop entries older than 30 days when it grows past 300
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      for (const k of keys) {
        if (Date.now() - cache[k].t > 30 * TTL_MS) delete cache[k];
      }
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable — live fetches simply won't persist
  }
}

// One in-flight request per repo, no matter how many cards ask at once.
const inflight = new Map<string, Promise<number | null>>();

async function fetchStars(repo: RepoKey): Promise<number | null> {
  const cached = readCache()[repo.key];
  if (cached && Date.now() - cached.t < TTL_MS) return cached.n;
  if (inflight.has(repo.key)) return inflight.get(repo.key)!;

  const job = (async () => {
    try {
      const res = await fetch(repo.api, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as { stargazers_count?: number; star_count?: number };
      const n = repo.kind === 'github' ? json.stargazers_count : json.star_count;
      if (typeof n !== 'number') return null;
      writeCache(repo.key, n);
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

/** Formatting shared by card, table and detail views. */
export function formatStarCount(stars: number): string {
  if (stars >= 1000) {
    const k = stars / 1000;
    const label = k >= 10 ? k.toFixed(0) : k.toFixed(1);
    return `${label.replace(/\.0$/, '')}k`;
  }
  return stars.toString();
}
