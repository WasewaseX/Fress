// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../types';
import {
  resolveGitHubDownload,
  resolveFdroidDownload,
  ResolvedDownload,
} from './releaseFetch';
import { resolveOfficialDownload } from './officialResolvers';

/**
 * THE AGREED RETRY INTERFACE between the dialog UI and the resolver
 * internals.
 *
 * Ownership split (accessibility/localization PR, 2026-10):
 *   - The DIALOG UI (src/components/AppDetailModal.tsx) owns the failure
 *     state machine: loading / ready / none / rate-limit / network error,
 *     the Retry buttons and the official-page fallbacks. It never touches
 *     resolver caches directly - "manually delete cache entries from the
 *     component" is exactly what this seam exists to prevent.
 *   - The RESOLVER INTERNALS (src/lib/officialResolvers.ts,
 *     src/lib/release/**, src/lib/releaseFetch.ts) own WHAT a retry does.
 *     A resolver lookup is memoized (failures 30s in the session memo,
 *     failures 5min persisted), so an honest Retry must evict the failed
 *     memo entry for exactly the one app|platform the user asked about
 *     before re-running the resolver. That eviction is resolver-side code
 *     and belongs with the rest of the cache.
 *
 * The three functions below are that agreement, pinned as a TypeScript
 * interface so both sides can be built and tested against the same shape:
 *
 *   retryGitHubResolve(app, platform)   -> Promise<ResolvedDownload | null>
 *   retryFdroidResolve(pkgId)           -> Promise<ResolvedDownload | null>
 *   retryOfficialResolve(app, platform) -> Promise<ResolvedDownload | null>
 *
 * Contract every implementation must keep:
 *   1. Resolve to the SAME result type as the plain resolvers - never
 *      reject for "no result" (resolve to null instead); rejecting is
 *      reserved for transport-level surprises, which the dialog renders
 *      as a network failure.
 *   2. Re-run the lookup for THIS app|platform only: cached successes and
 *      unrelated apps' entries stay untouched.
 *   3. Never leave the caller waiting forever: every path settles.
 *
 * Today this module delegates to the plain resolvers (the only exports
 * available here). While the failure memo is in effect an immediate retry
 * may answer from that memo; the dialog keeps reporting the truth either
 * way, because it re-derives its state from the actual answer plus the
 * resolver's peekResolveError bookkeeping. When the resolver-side retry
 * implementations (evict-then-re-resolve) land in their owning files, the
 * three delegates below switch to them without ANY change in the dialog:
 * the component imports this module, not the resolver internals.
 */

export interface ResolverRetryApi {
  /** Re-run the GitHub Releases lookup for one app|platform. */
  retryGitHubResolve(app: AppItem, platform: Platform): Promise<ResolvedDownload | null>;
  /** Re-run the F-Droid lookup for one package id. */
  retryFdroidResolve(pkgId: string): Promise<ResolvedDownload | null>;
  /** Re-run the vendor-manifest (official) lookup for one app|platform. */
  retryOfficialResolve(app: AppItem, platform: Platform): Promise<ResolvedDownload | null>;
}

export const resolverRetry: ResolverRetryApi = {
  retryGitHubResolve: (app: AppItem, platform: Platform) => resolveGitHubDownload(app, platform),
  retryFdroidResolve: (pkgId: string) => resolveFdroidDownload(pkgId),
  retryOfficialResolve: (app: AppItem, platform: Platform) => resolveOfficialDownload(app, platform),
};
