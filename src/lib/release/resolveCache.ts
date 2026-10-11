// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../../types';
import { effectiveRepo } from './repo';
import { ResolveFailureKind, ResolvedDownload } from './types';
import { revalidatePersistedDigests } from './digests';

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

/**
 * The same failures, typed. resolveErrors carries the human message for the
 * existing UI; resolveFailureKinds additionally records WHAT KIND of
 * failure it was so the typed outcome contract (ResolveOutcome in
 * release/types.ts) can tell a rate limit from a network blip from an API
 * error instead of forcing the UI to regex the message.
 *
 * A failure kind is always paired with a message in resolveErrors under
 * the same key; only recordResolveFailure writes here.
 */
const resolveFailureKinds = new Map<string, ResolveFailureKind>();

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

/** The typed failure for a repo|platform lookup, or null when the last
 * null result was a genuine "no compatible asset" (no error recorded).
 * F-Droid lookups record under their own namespace (no repo is involved);
 * the repo record wins when both exist - it is the quota-limited source. */
export function peekResolveFailure(app: AppItem, platform: Platform): { kind: ResolveFailureKind; message: string } | null {
  const repo = effectiveRepo(app, platform);
  if (repo) {
    const key = resolveErrorKey(repo, platform);
    const kind = resolveFailureKinds.get(key);
    const message = resolveErrors.get(key);
    if (kind && message !== undefined) return { kind, message };
  }
  if (app.fdroidId) {
    const key = fdroidFailureKey(app.fdroidId);
    const kind = resolveFailureKinds.get(key);
    const message = resolveErrors.get(key);
    if (kind && message !== undefined) return { kind, message };
  }
  return null;
}

/** Record an actionable failure for a repo|platform pair (message form).
 * Kept next to the map and its key so the contract stays in one module. */
export function recordResolveError(repo: string, platform: Platform, message: string): void {
  recordResolveFailure(repo, platform, 'api', message);
}

/** Record an actionable failure together with its KIND. This is the writer
 * every resolver path should use; recordResolveError delegates here with
 * kind 'api' for backward compatibility. */
export function recordResolveFailure(
  repo: string,
  platform: Platform,
  kind: ResolveFailureKind,
  message: string
): void {
  const key = resolveErrorKey(repo, platform);
  resolveErrors.set(key, message);
  resolveFailureKinds.set(key, kind);
}

/** Clear the failure record for a repo|platform pair. Each NEW lookup run
 * clears the previous run's record before it starts, so the record always
 * describes the LATEST completed attempt - a run that ends in a genuine
 * no-match must not be misreported as failed because an earlier run hit a
 * rate limit. */
export function clearResolveFailure(repo: string, platform: Platform): void {
  const key = resolveErrorKey(repo, platform);
  resolveErrors.delete(key);
  resolveFailureKinds.delete(key);
}

/** The failure-record namespace for F-Droid package lookups (which have no
 * repo and no per-IP quota, but still fail: unreachable index, HTTP 5xx). */
export function fdroidFailureKey(pkgId: string): string {
  return `fdroid|${pkgId.trim()}`;
}

export function recordFdroidFailure(pkgId: string, kind: ResolveFailureKind, message: string): void {
  const key = fdroidFailureKey(pkgId);
  resolveErrors.set(key, message);
  resolveFailureKinds.set(key, kind);
}

export function clearFdroidFailure(pkgId: string): void {
  const key = fdroidFailureKey(pkgId);
  resolveErrors.delete(key);
  resolveFailureKinds.delete(key);
}

/** The session memo key for a GitHub resolve; also the namespace under
 * which persistent entries are partitioned.
 *
 * The key carries EVERY app configuration that changes what a lookup
 * fetches or how a result is picked:
 *   repo | platform | tag-stream pattern | prerelease vouch | asset
 *   naming overrides. Leaving any of these out would let an edited
 *   catalog entry (or a second app sharing the repo) read a result that
 *   was selected under different rules - an override change MUST NOT
 *   reuse an old cached pick. The persistent store appends the host arch
 *   on top (see resolve.ts). */
export function ghCacheKey(app: AppItem, platform: Platform, repo: string): string {
  return [
    repo,
    platform,
    app.tagPatterns?.[platform] ?? '',
    app.includeFlaggedReleases ? 'flagged' : '',
    app.assetPatterns?.[platform] ?? '',
  ].join('|');
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
    // Digests that were persisted by an older build (or hand-edited
    // storage) must not re-enter the engine looking trusted: malformed
    // values are dropped here, with a diagnostic (revalidatePersisted-
    // Digests). A hit without digests is returned unchanged.
    return revalidatePersistedDigests(e.hit, key) as ResolvedDownload | null;
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

/* ------------------------------------------------------------------ */
/* Explicit retry support (typed retry/invalidation contract)          */
/* ------------------------------------------------------------------ */

/**
 * Evict session-memo entries under `prefix` whose promise settles to null
 * (a failed lookup), so an explicit user-facing Retry genuinely re-fetches
 * instead of instantly reading the cached failure back. Pending entries are
 * awaited and evicted when they fail; succeeded entries are never touched.
 *
 * Returns once every matching failed entry is removed. Safe to call when
 * nothing matches: it is a no-op then. This is the session half of the
 * retry contract; purgePersistedFailures is the persistent half. Callers
 * go through retryGitHubResolve / retryFdroidResolve / retryOfficialResolve
 * (release/resolve.ts, officialResolvers.ts) rather than open-coding this.
 */
export async function evictFailedLookups(
  cache: Map<string, Promise<ResolvedDownload | null>>,
  prefix: string
): Promise<void> {
  const doomed: string[] = [];
  for (const [key, p] of Array.from(cache.entries())) {
    if (!key.startsWith(prefix)) continue;
    await p.then(
      (r) => {
        if (r === null) doomed.push(key);
      },
      () => {
        // A rejected memo entry is a failure by definition.
        doomed.push(key);
      }
    );
  }
  for (const key of doomed) {
    // Another caller may have replaced the entry meanwhile; only drop what
    // is still the promise we inspected.
    cache.delete(key);
  }
}

/**
 * Remove persisted FAILURE entries (url === null) under `prefix` from the
 * localStorage store. Without this, a Retry after a failed lookup would
 * re-read the 5-minute persisted failure and return null without any
 * network request, making the button a lie. Successes are never purged.
 */
export function purgePersistedFailures(prefix: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const store = JSON.parse(raw) as Record<string, CacheEntry>;
    let changed = false;
    for (const key of Object.keys(store)) {
      if (key.startsWith(prefix) && store[key].url === null) {
        delete store[key];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // Blocked or full storage: the session eviction above still applies.
  }
}
