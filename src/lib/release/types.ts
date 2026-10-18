// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Platform } from '../../types';

/**
 * Shared release/asset types for the download resolvers.
 *
 * This module owns the data shapes that cross resolver boundaries:
 * provider modules (GitHub, F-Droid) produce them, the matching layer
 * scores against them, and the UI consumes them. Nothing here imports
 * from other release modules - types only, so dependency arrows always
 * point from the implementations toward this file.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  /** The digest the forge itself renders for this uploaded asset
   * (GitHub's release page shows `sha256:<hex>` per asset). Same trust
   * class as `downloadUrl` - the party serving the file states its digest
   * - so it may flow into the engine's delete-on-mismatch verification.
   * Optional: sources that carry no per-asset digest leave it undefined
   * and the artifact stays honestly unverified. */
  sha256?: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface ResolvedDownload {
  /** 'github' = release assets, 'fdroid' = the F-Droid index, 'official' =
   * the project's own manifest/CDN outside GitHub (Tor, Signal, Proton, ...). */
  source: 'github' | 'fdroid' | 'official';
  url: string;
  filename: string;
  size: number;
  version: string;
  publishedAt?: string;
  releasePageUrl?: string;
  /** 'override' = the catalog author pinned this exact naming pattern;
   * 'heuristic' = picked by the scoring rules. */
  matchedBy?: 'override' | 'heuristic';
  /** True when the heuristic could only produce a low-confidence pick
   * (odd extension, no architecture marker, stripped flags). The UI warns
   * instead of presenting it as a sure thing. */
  weak?: boolean;
  /** Checksums the vendor published in the same manifest that named the
   * file (GIMP's gimp_versions.json, Signal's latest*.yml / latest.json,
   * Proton's version.json). The download engine deletes any file that
   * fails them, so a corrupted or tampered download can never look
   * finished. Absent when the manifest ships no per-file checksum. */
  expectedSha256?: string;
  expectedSha512?: string;
}

export interface FdroidInfo {
  apkUrl: string;
  pageUrl: string;
  version: string;
  versionCode: number;
}

/** Below this heuristic score the pick is reported as low confidence.
 * A typical solid pick scores 6-13; 1 and below means the only candidate
 * was an odd extension or something stripped of identifying markers. */
export const WEAK_SCORE_MAX = 1;

export interface AssetPick {
  pick: ReleaseAsset;
  matchedBy: 'override' | 'heuristic';
  weak: boolean;
}

/* ------------------------------------------------------------------ */
/* Android ABI vocabulary (shared with the self-updater)               */
/* ------------------------------------------------------------------ */

export type AndroidAbi = 'arm64' | 'arm' | 'x86' | 'x86_64';

/** What the runtime actually knows about the device. "unknown" is NOT a
 * synonym for x86_64: guessing x86_64 for a browser on a reduced user agent
 * is exactly what made ARM phones get handed x86_64-only APKs they cannot
 * install. Unknown devices fall back to universal APKs instead. */
export type DeviceAbi = AndroidAbi | 'unknown';

/** The per-platform naming patterns a catalog entry may pin. Declared here
 * so both the matching layer and the resolver orchestration share one
 * shape. */
export type PlatformPatterns = Partial<Record<Platform, string>>;

/** Selection hints the resolver feeds the asset picker alongside the
 * platform/arch. Declared here (types only) so assetMatching, the
 * orchestration and the official resolvers share one shape. */
export interface AssetSelectionOptions {
  /** True only when the app being resolved IS the server product (its
   * release repo is itself named "*server*"). Default false: the common
   * case is a desktop client, where a server binary can never be the
   * answer (hard-refused by assetServesSelectionRole). */
  allowServer?: boolean;
}

/* ------------------------------------------------------------------ */
/* Typed resolution outcome (the resolver/UI contract)                 */
/* ------------------------------------------------------------------ */

/**
 * WHY a resolution ended the way it did. The resolver's plain API answers
 * `ResolvedDownload | null`, which deliberately keeps the hot path simple
 * — but a null is five different situations, and the UI must be able to
 * tell them apart instead of guessing (a rate limit needs a Retry afford-
 * ance; a genuine "no Linux build exists" needs a page link, not a retry;
 * an unsupported platform needs nothing at all). Consumers that only need
 * the file keep using ResolvedDownload | null; consumers that render the
 * WHY use resolveWithOutcome() (release/resolve.ts), which returns this
 * union. Never infer the difference from string matching in the UI.
 *
 * The union is EXHAUSTIVE on purpose: a new resolver situation must add a
 * variant here, which forces every consuming switch to acknowledge it.
 */
export type ResolveFailureKind =
  | 'rate-limit' // the forge/vendor quota window is exhausted; retrying now will fail
  | 'network'    // the request could not leave the machine (offline, DNS, timeout, redirect loop)
  | 'api';       // the remote answered but not with usable data (HTTP 5xx, non-JSON, schema drift)

export type ResolveOutcome =
  /** A usable download was resolved. `confident: true` = the picker vouches
   * for the file (vendor manifest, well-named release asset). `confident:
   * false` = a weak/low-confidence pick the UI MUST disclose as such
   * (download.weak is set); it is still installable-looking, it is just not
   * certain. */
  | { status: 'resolved'; download: ResolvedDownload; confident: boolean }
  /** The lookup ran against a supported, configured source and found no
   * compatible installable asset (e.g. the repo ships no Linux binary, or
   * only wrong-ABI splits). This is a genuine answer, NOT a failure. */
  | { status: 'no-match' }
  /** The platform (or source for that platform) cannot have a resolution
   * at all: web/ios targets, or an app with no repository, F-Droid id or
   * official resolver for the requested platform. There is nothing to
   * retry and nothing to find. */
  | { status: 'unsupported'; reason: string }
  /** The lookup could not complete. `kind` separates the actionable cases;
   * `message` is the recorded human-readable diagnostic. This is the ONLY
   * variant where a retry/invalidation makes sense. */
  | { status: 'failed'; kind: ResolveFailureKind; message: string }
  /** No direct file exists, but there IS a valid official page that names
   * one (curated page, the project's own download page, the forge releases
   * page). `pageUrl` is the fallback the UI should offer - plainly
   * labelled as a page, never as a ready-to-run installer. */
  | { status: 'official-page'; pageUrl: string; why: 'no-direct-asset' | 'unsupported-direct' };
