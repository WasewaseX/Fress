// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { AppItem, Platform } from '../types';
import { ResolvedDownload } from './releaseFetch';
import {
  retryGitHubResolve,
  retryFdroidResolve,
  retryResolveDownloadFor,
} from './release/resolve';
import { retryOfficialResolve } from './officialResolvers';

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
 * The functions below are that agreement, pinned as a TypeScript
 * interface so both sides can be built and tested against the same shape:
 *
 *   retryGitHubResolve(app, platform)   -> Promise<ResolvedDownload | null>
 *   retryFdroidResolve(pkgId)           -> Promise<ResolvedDownload | null>
 *   retryOfficialResolve(app, platform) -> Promise<ResolvedDownload | null>
 *   retryResolveDownloadFor(app, platform) -> Promise<ResolvedDownload | null>
 *
 * The first three evict exactly ONE source's failed lookup; the composite
 * fourth (added for the catalog card's quick action) evicts every failed
 * lookup the full resolution chain may have produced for this app|platform
 * (GitHub, F-Droid and the vendor manifest) and re-runs the normal
 * resolution policy - because the card never knows WHICH source failed,
 * only that the chain returned null.
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
 * The three delegates route to the resolver-side evict-then-re-resolve
 * implementations (release/resolve.ts for GitHub and F-Droid,
 * officialResolvers.ts for the vendor manifests): each evicts exactly the
 * failed memo entry (and persisted failure) for the one app|platform asked
 * about, then re-runs the plain resolver - so a Retry always performs a
 * FRESH lookup instead of replaying the memoized failure. The dialog never
 * changes: it imports this module, not the resolver internals.
 */

export interface ResolverRetryApi {
  /** Re-run the GitHub Releases lookup for one app|platform. */
  retryGitHubResolve(app: AppItem, platform: Platform): Promise<ResolvedDownload | null>;
  /** Re-run the F-Droid lookup for one package id. */
  retryFdroidResolve(pkgId: string): Promise<ResolvedDownload | null>;
  /** Re-run the vendor-manifest (official) lookup for one app|platform. */
  retryOfficialResolve(app: AppItem, platform: Platform): Promise<ResolvedDownload | null>;
  /** Re-run the WHOLE resolution chain for one app|platform after evicting
   * every failed source lookup. Card-level retry: the card consumes the
   * composite result, not a per-source answer. */
  retryResolveDownloadFor(app: AppItem, platform: Platform): Promise<ResolvedDownload | null>;
}

export const resolverRetry: ResolverRetryApi = {
  // Direct passthroughs to the resolver owners' retry wrappers: same
  // signatures, same settle-never-reject contract, one evicted failure
  // each. Kept as thin arrows so a future signature change on either side
  // surfaces here first, never inside the dialog.
  retryGitHubResolve: (app: AppItem, platform: Platform) => retryGitHubResolve(app, platform),
  retryFdroidResolve: (pkgId: string) => retryFdroidResolve(pkgId),
  retryOfficialResolve: (app: AppItem, platform: Platform) => retryOfficialResolve(app, platform),
  retryResolveDownloadFor: (app: AppItem, platform: Platform) => retryResolveDownloadFor(app, platform),
};
