// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Resolves real download files from GitHub Releases and F-Droid.
 *
 * Only STABLE releases are ever offered: GitHub's /releases/latest endpoint
 * already excludes drafts and prereleases (beta/RC), so users never get a
 * beta build by accident. For F-Droid we use the official API's suggested
 * version code.
 *
 * ---------------------------------------------------------------------
 * COMPATIBILITY FACADE
 * ---------------------------------------------------------------------
 * This file used to hold the whole resolver. It now exists so every
 * existing importer keeps a single, stable import path:
 *
 *   src/lib/release/types.ts          shared release/asset types
 *   src/lib/release/repo.ts           repo identity + tag->version strings
 *   src/lib/release/assetMatching.ts  asset filtering, ABI gates, scoring
 *   src/lib/release/githubProvider.ts GitHub Releases API access
 *   src/lib/release/fdroidProvider.ts F-Droid index access
 *   src/lib/release/hostArch.ts       per-session host arch signal
 *   src/lib/release/resolveCache.ts   session memo + persistent cache
 *   src/lib/release/resolve.ts        resolution policy / orchestration
 *
 * New code should import from the specific module it needs; the re-exports
 * here are the compatibility surface and must not grow new behavior.
 */

// Shared types -----------------------------------------------------------------
export type {
  ReleaseAsset,
  ReleaseInfo,
  ResolvedDownload,
  FdroidInfo,
  AssetPick,
  AndroidAbi,
  DeviceAbi,
  PlatformPatterns,
  ResolveFailureKind,
  ResolveOutcome,
  AssetSelectionOptions,
} from './release/types';
export { WEAK_SCORE_MAX } from './release/types';

// Release identity strings -----------------------------------------------------
export { parseGithubRepo, cleanVersion, effectiveRepo } from './release/repo';

// Asset filtering and matching ---------------------------------------------------
export {
  androidAssetFlags,
  androidAssetAbi,
  androidDeviceAbi,
  assetCompatibleWithDevice,
  assetServesSelectionRole,
  scoreAsset,
  pickAsset,
  pickAssetDetailed,
} from './release/assetMatching';

// Host architecture --------------------------------------------------------------
export { getHostArch } from './release/hostArch';

// Trusted-digest integrity --------------------------------------------------------
export {
  attachTrustedDigests,
  normalizeTrustedDigest,
  peekDigestDiagnostics,
  revalidatePersistedDigests,
} from './release/digests';

// Caches and error bookkeeping ---------------------------------------------------
export {
  peekResolveError,
  peekResolveFailure,
  loadPersisted,
  persist,
} from './release/resolveCache';

// Resolution orchestration -------------------------------------------------------
export {
  resolveGitHubDownload,
  resolveFdroidDownload,
  retryGitHubResolve,
  retryFdroidResolve,
  resolveDownloadFor,
  resolveWithOutcome,
  fdroidPageUrl,
  playStoreUrl,
  githubFetchSupported,
  guessUserPlatform,
} from './release/resolve';
