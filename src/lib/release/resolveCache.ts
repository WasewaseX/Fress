// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../../types';
import { effectiveRepo } from './repo';
import { ResolvedDownload } from './types';

/**
 * Resolver caches and error bookkeeping.
 *
 * Two layers, two lifetimes:
 * - Session memo (in-memory Maps): deduplicates concurrent/rapid repeat
 *   lookups. Failures expire quickly so the next click really retries.
 * - Persistent store (localStorage): survives restarts so a batch download
 *   does not re-spend GitHub's unauthenticated quota on every app launch.
 *   Successes live 6 hours, failures 5 minutes; the store is capped.
 */

const ghCache = new Map<string, Promise<ResolvedDownload | null>>();
const fdCache = new Map<string, Promise<ResolvedDownload | null>>();
/**
 * Failed lookups are remembered only briefly. A GitHub rate limit or a Wi-Fi
 * blip used to be cached for the whole session: the first click resolved to
 * nothing and every later click on the same app kept silently doing nothing
 * until a restart. Successes stay cached for the session, failures expire so
 * the next click really tries again.
 */
const FAIL_TTL_MS = 30_000;

/**
 * Why the last resolution for a repo|platform returned nothing, when the
 * reason is actionable (rate limit vs the honest "no stable build here").
 * The UI reads this instead of showing a generic failure for what is often
 * just GitHub's unauthenticated quota being exhausted.
 *
 * Keyed by `repo|platform` only - NOT by the full resolve-cache key (which
 * additionally carries the tag-stream pattern and the flagged-releases
 * vouch). peekResolveError can only compute `repo|platform` from an app,
 * so a full key here made every recorded error unreachable through the
 * UI-facing getter; the error is a property of the repo lookup, not of one
 * app's stream filter.
 */
const resolveErrors = new Map<string, string>();

/** The error-map key for a repo|platform pair; kept in one place so the
 * writer and peekResolveError can never drift apart again. */
export function resolveErrorKey(repo: string, platform: Platform): string {
  return `${repo}|${platform}`;
}

/** The last actionable failure for a repo|platform lookup, or null. */
export function peekResolveError(app: AppItem, platform: Platform): string | null {
  const repo = effectiveRepo(app, platform);
  if (!repo) return null;
  return resolveErrors.get(resolveErrorKey(repo, platform)) ?? null;
}

/** Record an actionable failure for a repo|platform pair. Kept next to the
 * map and its key so the contract stays in one module. */
export function recordResolveError(repo: string, platform: Platform, message: string): void {
  resolveErrors.set(resolveErrorKey(repo, platform), message);
}

/** The session memo key for a GitHub resolve; also the namespace under
 * which persistent entries are partitioned. */
export function ghCacheKey(app: AppItem, platform: Platform, repo: string): string {
  return `${repo}|${platform}|${app.tagPatterns?.[platform] ?? ''}|${app.includeFlaggedReleases ? 'flagged' : ''}`;
}

export { ghCache, fdCache, FAIL_TTL_MS };

/* ------------------------------------------------------------------ */
/* Persistent resolver cache (localStorage)                            */
/* ------------------------------------------------------------------ */
/**
 * GitHub's unauthenticated REST quota is 60 requests/hour PER IP. A batch
 * download over the catalog spends it in minutes, and every app launch used
 * to re-spend it again. Resolved downloads are cached to localStorage with
 * a TTL: successes 6 hours (a project's "latest stable" rarely changes
 * faster), failures 5 minutes. The store is capped so it can never grow
 * without bound, and every cache partition includes the host arch + the
 * app's stream filters, so a different vouching can never read a stale hit.
 */
const CACHE_KEY = 'fress.resolveCache.v1';
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_PERSIST_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

interface CacheEntry { t: number; url: string | null; hit: ResolvedDownload | null }

export function loadPersisted(key: string): ResolvedDownload | null | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const store = JSON.parse(raw) as Record<string, CacheEntry>;
    const e = store[key];
    if (!e) return undefined;
    const ttl = e.url === null ? FAIL_PERSIST_TTL_MS : SUCCESS_TTL_MS;
    if (Date.now() - e.t > ttl) return undefined;
    return e.hit;
  } catch {
    return undefined;
  }
}

export function persist(key: string, hit: ResolvedDownload | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CACHE_KEY);
    const store = (raw ? JSON.parse(raw) : {}) as Record<string, CacheEntry>;
    const entries = Object.entries(store);
    if (entries.length >= CACHE_MAX_ENTRIES) {
      entries
        .sort((a, b) => a[1].t - b[1].t)
        .slice(0, Math.floor(CACHE_MAX_ENTRIES / 4))
        .forEach(([k]) => delete store[k]);
    }
    store[key] = { t: Date.now(), url: hit?.url ?? null, hit };
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // Storage full/blocked: the in-memory cache still covers the session.
  }
}

export function cacheSet(
  cache: Map<string, Promise<ResolvedDownload | null>>,
  key: string,
  value: Promise<ResolvedDownload | null>
): void {
  cache.set(key, value);
  value.then((r) => {
    if (r === null) {
      // Expire failures after a short TTL so the next click really retries.
      // globalThis: window does not exist in Node (tests) or workers.
      globalThis.setTimeout(() => {
        if (cache.get(key) === value) cache.delete(key);
      }, FAIL_TTL_MS);
    }
  });
}
